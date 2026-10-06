/**
 * 发掘耗材领域服务：库存数量变更、预警阈值判断、采购动作、领用待办生成的唯一入口。
 *
 * 不变量（修复目标）：
 * 1. 同一耗材编号每次自「阈值之上」跌破阈值（下行穿越），只生成一份未关闭预警提醒；
 *    同一轮低库存期内重复领用/操作不再产生第二份，恢复到阈值之上后关闭，
 *    下一次真实穿越才允许再生成一份。
 * 2. 确认入库在一个事务内同时回写三处：库存数量、采购单状态、领用面（预警提醒 +
 *    历史待备货领用清单），任一处失败或写盘不生效则整体退回。
 * 3. 列表页、库存数、领用清单都从 material-store 同一数据源读取，口径一致。
 * 4. 历史领用记录的 snapshotStock/snapshotThreshold 为申请当时口径，永不回改。
 * 5. 两个终端并发确认同一笔入库：只有一个成功（库存只入账一次），另一个明确拒绝。
 */

import {
  acquireInboundLock,
  commit,
  currentTerminal,
  MaterialRuleError,
  nextId,
  pruneLocks,
  refreshState,
  releaseInboundLock,
} from '@/data/material-store'
import type {
  Material,
  MaterialState,
  MovementReason,
  PurchaseOrder,
  Requisition,
  StockAlert,
  StockMovement,
} from '@/data/material-types'

export type {
  Material,
  MaterialState,
  PurchaseOrder,
  Requisition,
  StockAlert,
  StockMovement,
} from '@/data/material-types'

export type ServiceResult<T = void> = { ok: true; value: T } | { ok: false; message: string }

// 仅供测试/调试使用的事务原语：业务页面应只调用下方具名动作。
export { commit, MaterialRuleError } from '@/data/material-store'

// ---------- 查询（同一口径，页面不得自行计算库存） ----------

export function listMaterials(): Material[] {
  return refreshState().materials.map((item) => ({ ...item }))
}

export function getMaterial(id: number): Material | null {
  const found = refreshState().materials.find((item) => item.id === id)
  return found ? { ...found } : null
}

export function listRequisitions(): Requisition[] {
  return refreshState().requisitions.map((item) => ({ ...item }))
}

export function listPurchases(): PurchaseOrder[] {
  return refreshState().purchases.map((item) => ({ ...item }))
}

export function listOpenAlerts(): StockAlert[] {
  return refreshState().alerts.filter((item) => item.open).map((item) => ({ ...item }))
}

export function listMovements(materialId?: number): StockMovement[] {
  const rows = refreshState().movements
  return (materialId ? rows.filter((item) => item.materialId === materialId) : rows).map((item) => ({ ...item }))
}

/** 领用页看到的待办：未关闭预警提醒 + 库存不足挂起的待备货领用。 */
export type RequisitionTodo = {
  key: string
  kind: '库存预警' | '待备货'
  materialId: number
  materialCode: string
  materialName: string
  message: string
  createdAt: string
}

export function listRequisitionTodos(): RequisitionTodo[] {
  const state = refreshState()
  const todos: RequisitionTodo[] = []
  for (const alert of state.alerts.filter((item) => item.open)) {
    todos.push({
      key: `alert-${alert.id}`,
      kind: '库存预警',
      materialId: alert.materialId,
      materialCode: alert.materialCode,
      materialName: alert.materialName,
      message: `库存已跌破预警线（当前 ${stockOf(state, alert.materialId)} / 阈值 ${thresholdOf(state, alert.materialId)}），请及时采购`,
      createdAt: alert.createdAt,
    })
  }
  for (const req of state.requisitions.filter((item) => item.status === '待备货')) {
    todos.push({
      key: `req-${req.id}`,
      kind: '待备货',
      materialId: req.materialId,
      materialCode: req.materialCode,
      materialName: req.materialName,
      message: `领用 ${req.qty} 件待备货（当前库存 ${stockOf(state, req.materialId)}）`,
      createdAt: req.createdAt,
    })
  }
  return todos.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export type MaterialSummary = {
  total: number
  needPurchase: number
  low: number
}

export function materialSummary(): MaterialSummary {
  const rows = refreshState().materials.filter((item) => item.status !== '已停用')
  return {
    total: rows.length,
    needPurchase: rows.filter((item) => item.status === '需采购').length,
    low: rows.filter((item) => item.status === '偏低').length,
  }
}

// ---------- 内部规则 ----------

function stockOf(draft: MaterialState, materialId: number): number {
  return draft.materials.find((item) => item.id === materialId)?.stock ?? 0
}

function thresholdOf(draft: MaterialState, materialId: number): number {
  return draft.materials.find((item) => item.id === materialId)?.threshold ?? 0
}

function findMaterial(draft: MaterialState, materialId: number): Material {
  const material = draft.materials.find((item) => item.id === materialId)
  if (!material) {
    throw new MaterialRuleError(`耗材不存在（id=${materialId}）`)
  }
  return material
}

function hasActivePurchase(draft: MaterialState, materialId: number): boolean {
  return draft.purchases.some((item) => item.materialId === materialId && item.status === '待入库')
}

/** 状态只由「库存 vs 阈值」与「是否在途采购」推导，避免旧状态残留。 */
function deriveStatus(material: Material, draft: MaterialState): string {
  if (material.status === '已停用') {
    return '已停用'
  }
  if (material.stock <= material.threshold) {
    return hasActivePurchase(draft, material.id) ? '需采购' : '偏低'
  }
  return '充足'
}

function appendMovement(
  draft: MaterialState,
  material: Material,
  change: number,
  reason: MovementReason,
  refId: number | undefined,
  now: string,
): void {
  draft.movements.push({
    id: nextId(draft),
    materialId: material.id,
    materialCode: material.code,
    change,
    balance: material.stock,
    reason,
    refId,
    createdAt: now,
  })
}

/**
 * 预警判断（穿越去重核心）：
 * 只有数量从「阈值之上」跨越到「阈值线及以下」这一下行穿越，才生成一份提醒；
 * 去重键就是「该耗材是否已存在未关闭提醒」——同一轮低库存期内继续领用、重复操作、
 * 入库清待办又回落等，都不会产生第二份。
 * 数量恢复到阈值之上时关闭未关闭提醒；下一次真实下行穿越自然能再生成一份。
 */
function evaluateAlert(draft: MaterialState, material: Material, beforeStock: number, now: string): void {
  const crossedDown = beforeStock > material.threshold && material.stock <= material.threshold
  if (crossedDown) {
    const hasOpen = draft.alerts.some((item) => item.materialId === material.id && item.open)
    if (!hasOpen) {
      const seqNo = draft.alerts.filter((item) => item.materialId === material.id).length + 1
      draft.alerts.push({
        id: nextId(draft),
        materialId: material.id,
        materialCode: material.code,
        materialName: material.name,
        seqNo,
        open: true,
        createdAt: now,
      })
    }
    return
  }
  const recovered = beforeStock <= material.threshold && material.stock > material.threshold
  if (recovered) {
    closeOpenAlerts(draft, material, now, '库存恢复至预警线之上')
  }
}

function closeOpenAlerts(
  draft: MaterialState,
  material: Material,
  now: string,
  reason: string,
): void {
  for (const alert of draft.alerts) {
    if (alert.materialId === material.id && alert.open) {
      alert.open = false
      alert.closedAt = now
      alert.closedReason = reason
    }
  }
}

/**
 * 库存恢复后回写领用面：把仍挂着的「待备货」历史领用按库存先进先出满足。
 * 已出库历史记录不动，满足时仅回写待办状态与满足单号。
 * 每次消耗走统一的库存变更（流水 + 穿越去重 + 状态重算），因此若清待办又把库存
 * 拉回预警线内，也只会出现一份提醒，不会重复刷屏。
 */
function fulfillBacklog(
  draft: MaterialState,
  material: Material,
  purchaseId: number,
  now: string,
): void {
  const pending = draft.requisitions
    .filter((item) => item.materialId === material.id && item.status === '待备货')
    .sort((a, b) => a.id - b.id)
  for (const req of pending) {
    if (material.stock <= 0) {
      break
    }
    const qty = Math.min(req.qty, material.stock)
    if (qty <= 0) {
      continue
    }
    applyStockChange(draft, material, -qty, '待备货出库', req.id, now)
    req.status = '已出库'
    req.fulfilledBy = purchaseId
    // 注意：snapshotStock/snapshotThreshold 保留申请当时口径，不回改。
  }
}

/** 统一应用库存变动：改数量 → 落流水 → 预警判断 → 重算状态。 */
function applyStockChange(
  draft: MaterialState,
  material: Material,
  delta: number,
  reason: MovementReason,
  refId: number | undefined,
  now: string,
): void {
  const before = material.stock
  material.stock += delta
  if (material.stock < 0) {
    throw new MaterialRuleError(`「${material.name}」库存不足，当前仅剩 ${before} 件`)
  }
  appendMovement(draft, material, delta, reason, refId, now)
  evaluateAlert(draft, material, before, now)
  material.status = deriveStatus(material, draft)
  material.version += 1
}

// ---------- 写动作 ----------

/** 手工调整库存（盘点）：同样走穿越去重与状态重算。 */
export function adjustStock(materialId: number, delta: number, reason = '盘点调整'): ServiceResult<Material> {
  if (!Number.isInteger(delta) || delta === 0) {
    return { ok: false, message: '调整数量必须是非零整数' }
  }
  return commit((draft) => {
    const material = findMaterial(draft, materialId)
    if (material.status === '已停用') {
      throw new MaterialRuleError(`「${material.name}」已停用，不能调整库存`)
    }
    applyStockChange(draft, material, delta, reason, undefined, new Date().toISOString())
    return { ...material }
  })
}

/**
 * 领用耗材：申请即出库。
 * 库存充足 → 扣减库存、写流水、按穿越规则决定是否产生唯一一份预警；
 * 库存不足 → 生成「待备货」领用待办（不扣库存），库存现状仍按穿越规则提醒。
 * 领用记录冻结申请当时库存/阈值口径。
 */
export function createRequisition(input: {
  materialId: number
  qty: number
  applicant: string
}): ServiceResult<Requisition> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    return { ok: false, message: '领用数量必须是正整数' }
  }
  const applicant = input.applicant.trim()
  if (!applicant) {
    return { ok: false, message: '请填写领用人' }
  }
  return commit((draft) => {
    const material = findMaterial(draft, input.materialId)
    if (material.status === '已停用') {
      throw new MaterialRuleError(`「${material.name}」已停用，不能领用`)
    }
    const now = new Date().toISOString()
    const req: Requisition = {
      id: nextId(draft),
      materialId: material.id,
      materialCode: material.code,
      materialName: material.name,
      qty: input.qty,
      applicant,
      createdAt: now,
      status: material.stock >= input.qty ? '已出库' : '待备货',
      snapshotStock: material.stock,
      snapshotThreshold: material.threshold,
    }
    draft.requisitions.push(req)
    if (req.status === '已出库') {
      applyStockChange(draft, material, -input.qty, '领用出库', req.id, now)
    }
    // 待备货不扣库存，但库存可能早已低于阈值：提醒随实际库存口径走，不重复生成。
    return { ...req }
  })
}

/**
 * 发起采购：把「偏低」推进为「需采购」，并关闭本轮预警提醒（转采购跟踪，领用页不再重复提醒）。
 * 已有在途采购单时明确拒绝，防止重复采购。
 */
export function createPurchase(input: {
  materialId: number
  qty: number
  applicant: string
}): ServiceResult<PurchaseOrder> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    return { ok: false, message: '采购数量必须是正整数' }
  }
  const applicant = input.applicant.trim()
  if (!applicant) {
    return { ok: false, message: '请填写采购人' }
  }
  return commit((draft) => {
    const material = findMaterial(draft, input.materialId)
    if (material.status === '已停用') {
      throw new MaterialRuleError(`「${material.name}」已停用，不能发起采购`)
    }
    if (hasActivePurchase(draft, material.id)) {
      throw new MaterialRuleError(`「${material.name}」已有待入库采购单，请勿重复发起`)
    }
    const now = new Date().toISOString()
    const order: PurchaseOrder = {
      id: nextId(draft),
      materialId: material.id,
      materialCode: material.code,
      materialName: material.name,
      qty: input.qty,
      applicant,
      createdAt: now,
      status: '待入库',
      version: 0,
    }
    draft.purchases.push(order)
    closeOpenAlerts(draft, material, now, '已发起采购，转采购跟踪')
    material.status = deriveStatus(material, draft)
    material.version += 1
    return { ...order }
  })
}

/**
 * 确认入库（修复重点）：
 * 一个事务内同时回写三个业务面——
 *   a) 库存：采购数量入账，写流水；
 *   b) 采购状态：采购单 → 已入库；
 *   c) 领用面：关闭残留预警、满足历史待备货领用清单。
 * 任一步失败 / 写盘不生效 → 整体退回。
 * 两个终端并发确认：锁 + 采购单状态（乐观版本）双重判定，只有一个成功，另一个明确拒绝。
 */
export function confirmInbound(purchaseId: number): ServiceResult<PurchaseOrder> {
  return commit((draft) => {
    const nowMs = Date.now()
    pruneLocks(draft, nowMs)
    const order = draft.purchases.find((item) => item.id === purchaseId)
    if (!order) {
      throw new MaterialRuleError(`采购单 #${purchaseId} 不存在`)
    }
    // 第二重判定：另一终端已先确认 → 明确拒绝，库存不会再加一次。
    if (order.status !== '待入库') {
      throw new MaterialRuleError(
        `采购单 #${purchaseId} 已由终端 ${order.inboundTerminal ?? '其它终端'} 于 ${
          order.inboundAt ?? '此前'
        } 确认入库，本次请求已拒绝，库存未重复入账`,
      )
    }
    const material = findMaterial(draft, order.materialId)
    acquireInboundLock(draft, material.code, nowMs)
    try {
      const now = new Date().toISOString()

      // a) 回写库存（穿越判断：补货越过预警线 → 关闭本轮提醒）
      applyStockChange(draft, material, order.qty, '采购入库', order.id, now)

      // c) 领用面：入库恢复后满足待备货领用清单（走统一穿越去重，最多一份提醒）
      fulfillBacklog(draft, material, order.id, now)

      // 清待办后库存口径据实重算：若仍在线内则继续挂「偏低/需采购」，提醒不重复刷；
      // 只有将来再次发生「线上 → 线下」的真实穿越（届时不存在未关闭提醒），才会再生成一份。
      material.status = deriveStatus(material, draft)
      material.version += 1

      // b) 回写采购状态（放在最后：前面任何一步抛错都不会留下“已入库”假象）
      order.status = '已入库'
      order.inboundAt = now
      order.inboundTerminal = currentTerminal()
      order.version += 1

      return { ...order }
    } finally {
      // 事务成功后释放本终端锁；若 worker 抛错，commit 会整体回滚快照（含锁）。
      releaseInboundLock(draft, material.code)
    }
  })
}

/** 取消采购单：恢复在途标记；库存仍低于阈值时重新挂出那一份预警，状态据实重算。 */
export function cancelPurchase(purchaseId: number): ServiceResult<PurchaseOrder> {
  return commit((draft) => {
    const order = draft.purchases.find((item) => item.id === purchaseId)
    if (!order) {
      throw new MaterialRuleError(`采购单 #${purchaseId} 不存在`)
    }
    if (order.status !== '待入库') {
      throw new MaterialRuleError(`采购单 #${purchaseId} 当前为「${order.status}」，不能取消`)
    }
    order.status = '已取消'
    order.version += 1
    const material = findMaterial(draft, order.materialId)
    const now = new Date().toISOString()
    if (material.stock <= material.threshold) {
      const hasOpen = draft.alerts.some((item) => item.materialId === material.id && item.open)
      if (!hasOpen) {
        const seqNo = draft.alerts.filter((item) => item.materialId === material.id).length + 1
        draft.alerts.push({
          id: nextId(draft),
          materialId: material.id,
          materialCode: material.code,
          materialName: material.name,
          seqNo,
          open: true,
          createdAt: now,
        })
      }
    }
    material.status = deriveStatus(material, draft)
    material.version += 1
    return { ...order }
  })
}
