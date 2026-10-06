import {
  ALERT_KEY,
  commitStore,
  listRows,
  MATERIAL_KEY,
  REQUISITION_KEY,
} from '@/data/local-store'
import type {
  EntryRow,
  MaterialAlertRow,
  MaterialRow,
  RequisitionRow,
} from '@/data/types'

export type { MaterialAlertRow, MaterialRow, RequisitionRow }

// 耗材状态口径：
// 已停用 > 有未满足的领用单（需采购）> 数量<=预警线（偏低）> 数量>预警线（充足）。
// 所有写入结束都按这个口径回算，列表页、库存数、领用清单永远来自同一份数据。
const STATUS_OK = '充足'
const STATUS_LOW = '偏低'
const STATUS_PURCHASE = '需采购'
const STATUS_DISABLED = '已停用'

export const REQUISITION_WAITING = '待发放'
export const REQUISITION_ISSUED = '已发放'
export const ALERT_ACTIVE = '预警中'
export const ALERT_RESOLVED = '已解除'

export type BusinessCode = 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'CONCURRENT'

export class BusinessError extends Error {
  code: BusinessCode

  constructor(code: BusinessCode, message: string) {
    super(message)
    this.code = code
  }
}

export type RequisitionInput = {
  materialCode: string
  quantity: number
  receiver: string
  purpose: string
}

export type InboundInput = {
  id: number
  quantity: number
  expectedVersion?: number
}

export type MaterialStats = {
  kinds: number
  needPurchase: number
  low: number
  waitingRequisitions: number
  activeAlerts: number
}

function asMaterial(row: EntryRow): MaterialRow {
  return row as MaterialRow
}

function asRequisition(row: EntryRow): RequisitionRow {
  return row as RequisitionRow
}

function asAlert(row: EntryRow): MaterialAlertRow {
  return row as MaterialAlertRow
}

function findMaterial(materials: EntryRow[], idOrCode: number | string): MaterialRow | undefined {
  if (typeof idOrCode === 'number' || /^\d+$/.test(String(idOrCode))) {
    return materials.find((row) => Number(row.id) === Number(idOrCode)) as MaterialRow | undefined
  }
  return materials.find((row) => asMaterial(row).耗材编号 === String(idOrCode)) as
    | MaterialRow
    | undefined
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowText(): string {
  const d = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function serialText(): string {
  const d = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function deriveStatus(material: MaterialRow, waitingCount: number): string {
  if (material.status === STATUS_DISABLED) {
    return STATUS_DISABLED
  }
  // 采购单进行中或还有未满足的领用单，都属于「需采购」面；
  // 入库把这两个条件都清掉后，状态才会落回偏低/充足，旧状态不会残留。
  if (material.采购中 || waitingCount > 0) {
    return STATUS_PURCHASE
  }
  return Number(material.当前数量) <= Number(material.预警数量) ? STATUS_LOW : STATUS_OK
}

/**
 * 一致性清扫：依据库存与领用清单统一回算耗材的状态、待办标记和预警提醒。
 * 任何写事务收尾都必须调用，避免「需采购」旧状态残留或库存与清单对不上。
 */
function sweep(draft: Record<string, EntryRow[]>): void {
  const materials = draft[MATERIAL_KEY] ?? []
  const requisitions = draft[REQUISITION_KEY] ?? []
  const alerts = draft[ALERT_KEY] ?? []

  const waitingByCode = new Map<string, number>()
  for (const row of requisitions) {
    if (row.status === REQUISITION_WAITING) {
      const code = asRequisition(row).耗材编号
      waitingByCode.set(code, (waitingByCode.get(code) ?? 0) + 1)
    }
    row.pending = row.status === REQUISITION_WAITING
  }

  for (const row of alerts) {
    row.pending = row.status === ALERT_ACTIVE
  }

  for (const row of materials) {
    const material = asMaterial(row)
    const waiting = waitingByCode.get(material.耗材编号) ?? 0
    const derived = deriveStatus(material, waiting)
    material.status = derived
    material.pending = derived !== STATUS_DISABLED
    material.abnormal = derived === STATUS_DISABLED
    if (typeof material.version !== 'number') {
      material.version = 0
    }
    // 库存回到预警线上，自动解除这次跨越生成的提醒；仍在线下则保留一份。
    if (
      derived !== STATUS_DISABLED &&
      Number(material.当前数量) > Number(material.预警数量)
    ) {
      for (const alertRow of alerts) {
        const alert = asAlert(alertRow)
        if (alert.耗材编号 === material.耗材编号 && alert.status === ALERT_ACTIVE) {
          alert.status = ALERT_RESOLVED
          alert.pending = false
          alert.解除时间 = nowText()
        }
      }
    }
  }

  // 待发放领用单对应的耗材必须是「需采购」，否则两处口径对不上，事务整体退回。
  for (const row of requisitions) {
    if (row.status !== REQUISITION_WAITING) {
      continue
    }
    const code = asRequisition(row).耗材编号
    const material = materials.find((item) => asMaterial(item).耗材编号 === code)
    if (!material) {
      throw new BusinessError('INVALID', `领用单 ${asRequisition(row).领用单号} 对应的耗材已不存在`)
    }
    if (material.status !== STATUS_PURCHASE) {
      throw new BusinessError(
        'CONFLICT',
        `领用单 ${asRequisition(row).领用单号} 仍待发放，但耗材「${code}」已不是需采购状态`,
      )
    }
  }
}

/**
 * 下行跨越预警线才生成提醒：上一次库存在线上、变更后在线下。
 * 同一耗材编号存在「预警中」提醒时直接复用，绝不重复生成第二份。
 */
function raiseAlertIfCross(
  alerts: EntryRow[],
  material: MaterialRow,
  before: number,
  after: number,
): void {
  const threshold = Number(material.预警数量)
  const crossedDown = before > threshold && after <= threshold
  if (!crossedDown) {
    return
  }
  const existing = alerts.some(
    (row) => asAlert(row).耗材编号 === material.耗材编号 && row.status === ALERT_ACTIVE,
  )
  if (existing) {
    return
  }
  alerts.push({
    id: nextId(alerts),
    status: ALERT_ACTIVE,
    pending: true,
    abnormal: false,
    提醒编号: `ALERT-${material.耗材编号}`,
    耗材编号: material.耗材编号,
    耗材名称: material.耗材名称,
    预警数量: threshold,
    触发时库存: after,
    触发时间: nowText(),
    解除时间: '',
  })
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** 领用申请：库存够直接扣减发放；不够则生成待发放待办，采购入库后 FIFO 补扣。 */
export function applyRequisition(input: RequisitionInput): {
  ok: boolean
  message: string
  alertRaised: boolean
  issued: boolean
} {
  const code = String(input.materialCode ?? '').trim()
  const quantity = Number(input.quantity)
  const receiver = String(input.receiver ?? '').trim()
  const purpose = String(input.purpose ?? '').trim()
  if (!code) {
    throw new BusinessError('INVALID', '请选择要领用的耗材编号')
  }
  if (!positiveInteger(quantity)) {
    throw new BusinessError('INVALID', '领用数量必须是正整数')
  }
  if (!receiver) {
    throw new BusinessError('INVALID', '请填写领用人')
  }

  let alertRaised = false
  let issued = false
  const requisitionNo = `REQ-${serialText()}-${String(nextId(listRows(REQUISITION_KEY))).padStart(4, '0')}`

  commitStore((draft) => {
    const materials = draft[MATERIAL_KEY] ?? (draft[MATERIAL_KEY] = [])
    const requisitions = draft[REQUISITION_KEY] ?? (draft[REQUISITION_KEY] = [])
    const alerts = draft[ALERT_KEY] ?? (draft[ALERT_KEY] = [])

    const material = findMaterial(materials, code)
    if (!material) {
      throw new BusinessError('NOT_FOUND', `没有找到耗材编号为 ${code} 的发掘耗材`)
    }
    if (material.status === STATUS_DISABLED) {
      throw new BusinessError('CONFLICT', `耗材「${code}」已停用，不能领用`)
    }

    const before = Number(material.当前数量)
    const enough = before >= quantity
    const base: RequisitionRow = {
      id: nextId(requisitions),
      status: enough ? REQUISITION_ISSUED : REQUISITION_WAITING,
      pending: !enough,
      abnormal: false,
      领用单号: requisitionNo,
      耗材编号: code,
      耗材名称: material.耗材名称,
      领用数量: quantity,
      领用人: receiver,
      用途: purpose,
      申请时间: nowText(),
      // 历史领用记录保留当时口径：快照写死，不随后续库存或阈值调整变化。
      申请时库存: before,
      申请时预警线: Number(material.预警数量),
      发放时间: '',
      发放后库存: '',
    }

    if (enough) {
      const after = before - quantity
      material.当前数量 = after
      material.version = Number(material.version ?? 0) + 1
      base.发放时间 = base.申请时间
      base.发放后库存 = after
      const hadActive = alerts.some(
        (row) => asAlert(row).耗材编号 === code && row.status === ALERT_ACTIVE,
      )
      raiseAlertIfCross(alerts, material, before, after)
      alertRaised =
        !hadActive &&
        before > Number(material.预警数量) &&
        after <= Number(material.预警数量)
    }

    requisitions.push(base)
    issued = enough
    sweep(draft)
  })

  return {
    ok: true,
    issued,
    alertRaised,
    message: '',
  }
}

/** 发起采购：没有进行中的采购单即可发起（库存偏低或已有待发放待办都允许补货）。 */
export function startPurchase(id: number): { ok: boolean; message: string } {
  return commitStore((draft) => {
    const materials = draft[MATERIAL_KEY] ?? []
    const index = materials.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      throw new BusinessError('NOT_FOUND', `没有找到编号为 ${id} 的发掘耗材`)
    }
    const material = asMaterial(materials[index])
    if (material.status === STATUS_DISABLED) {
      throw new BusinessError('CONFLICT', '已停用的耗材不能发起采购')
    }
    if (material.采购中) {
      throw new BusinessError('CONFLICT', '该耗材已有采购单在等待确认入库，不能重复发起采购')
    }
    if (material.status === STATUS_OK) {
      throw new BusinessError('CONFLICT', `库存仍高于预警线（${material.预警数量}），无需采购`)
    }
    // 进入采购流程：库存不变，置采购中并推进 version，使其它终端手里的旧快照失效。
    material.采购中 = true
    material.pending = true
    material.version = Number(material.version ?? 0) + 1
    sweep(draft)
    return { ok: true, message: `耗材「${material.耗材编号}」已发起采购，等待确认入库` }
  })
}

/**
 * 确认入库：采购动作的收尾，一个事务里同时回写三个业务面——
 *   1. 库存加上入库数量；
 *   2. FIFO 扣减该耗材的「待发放」领用清单（只扣一次）；
 *   3. 采购状态按剩余待办重算，库存回到线上则同步解除预警。
 * expectedVersion 是页面读到的乐观锁版本：另一终端已确认时版本对不上，明确拒绝。
 */
export function confirmInbound(input: InboundInput): {
  ok: boolean
  message: string
  issued: number
  remaining: number
} {
  const id = Number(input.id)
  const quantity = Number(input.quantity)
  if (!positiveInteger(quantity)) {
    throw new BusinessError('INVALID', '入库数量必须是正整数')
  }

  return commitStore((draft) => {
    const materials = draft[MATERIAL_KEY] ?? []
    const requisitions = draft[REQUISITION_KEY] ?? (draft[REQUISITION_KEY] = [])
    const alerts = draft[ALERT_KEY] ?? (draft[ALERT_KEY] = [])

    const index = materials.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      throw new BusinessError('NOT_FOUND', `没有找到编号为 ${id} 的发掘耗材`)
    }
    const material = asMaterial(materials[index])

    if (
      typeof input.expectedVersion === 'number' &&
      Number(material.version ?? 0) !== input.expectedVersion
    ) {
      throw new BusinessError(
        'CONCURRENT',
        `耗材「${material.耗材编号}」已被另一终端更新（库存或采购状态已变化），请刷新后重新确认入库`,
      )
    }
    if (material.status === STATUS_DISABLED) {
      throw new BusinessError('CONFLICT', '已停用的耗材不能确认入库')
    }
    if (!material.采购中) {
      throw new BusinessError('CONFLICT', '该耗材没有等待确认的采购单，不能确认入库')
    }

    const before = Number(material.当前数量)
    let stock = before + quantity
    material.当前数量 = stock

    // 同一事务内 FIFO 扣减：每条待发放单在这次入库里最多翻转一次，库存只扣一遍。
    const waiting = requisitions
      .filter(
        (row) =>
          asRequisition(row).耗材编号 === material.耗材编号 &&
          row.status === REQUISITION_WAITING,
      )
      .sort((a, b) => (asRequisition(a).申请时间 < asRequisition(b).申请时间 ? -1 : 1))

    let issued = 0
    for (const row of waiting) {
      const requisition = asRequisition(row)
      const need = Number(requisition.领用数量)
      if (stock < need) {
        break
      }
      stock -= need
      material.当前数量 = stock
      requisition.status = REQUISITION_ISSUED
      requisition.pending = false
      requisition.发放时间 = nowText()
      requisition.发放后库存 = stock
      issued += 1
    }

    // 采购动作收尾：三个业务面在同一次写入落定——采购标记清除、版本推进、
    // 状态与预警由 sweep 依据库存和剩余待办统一回算。
    material.采购中 = false
    material.version = Number(material.version ?? 0) + 1
    sweep(draft)

    // 提交前最终校验：任何一面没落到预期口径，整体退回（persist 尚未执行）。
    const remaining = requisitions.filter(
      (row) =>
        asRequisition(row).耗材编号 === material.耗材编号 &&
        row.status === REQUISITION_WAITING,
    ).length
    const freshStock = Number(material.当前数量)
    if (freshStock < 0) {
      throw new BusinessError('CONFLICT', '入库后库存为负，数据不自洽，已整体退回')
    }
    if (issued > waiting.length) {
      throw new BusinessError('CONFLICT', '待发放清单被扣减次数异常，已整体退回')
    }
    if (material.采购中) {
      throw new BusinessError('CONFLICT', '采购标记未清除，已整体退回')
    }
    const resolvedExpect = freshStock > Number(material.预警数量)
    const activeAlert = alerts.some(
      (row) => asAlert(row).耗材编号 === material.耗材编号 && row.status === ALERT_ACTIVE,
    )
    if (resolvedExpect && activeAlert) {
      throw new BusinessError('CONFLICT', '库存已恢复但预警提醒未解除，已整体退回')
    }
    if (remaining > 0 && material.status !== STATUS_PURCHASE) {
      throw new BusinessError('CONFLICT', '仍有待发放领用单但需采购状态被提前清掉，已整体退回')
    }
    if (remaining === 0 && material.status === STATUS_PURCHASE) {
      throw new BusinessError('CONFLICT', '采购单已入库但需采购状态残留，已整体退回')
    }

    const message =
      `耗材「${material.耗材编号}」入库 ${quantity}，当前库存 ${freshStock}` +
      (issued > 0 ? `，已补发领用单 ${issued} 份` : '') +
      (remaining > 0 ? `，仍有 ${remaining} 份领用单待发放` : '，采购状态已清除')
    return { ok: true, message, issued, remaining }
  })
}

/** 标记停用：存在未满足领用单时拒绝，避免停用后待办悬挂。 */
export function markDisabled(id: number): { ok: boolean; message: string } {
  return commitStore((draft) => {
    const materials = draft[MATERIAL_KEY] ?? []
    const requisitions = draft[REQUISITION_KEY] ?? []
    const alerts = draft[ALERT_KEY] ?? (draft[ALERT_KEY] = [])
    const material = findMaterial(materials, id)
    if (!material) {
      throw new BusinessError('NOT_FOUND', `没有找到编号为 ${id} 的发掘耗材`)
    }
    if (material.status === STATUS_DISABLED) {
      throw new BusinessError('CONFLICT', '该耗材已经是停用状态')
    }
    const waiting = requisitions.filter(
      (row) =>
        asRequisition(row).耗材编号 === material.耗材编号 &&
        row.status === REQUISITION_WAITING,
    ).length
    if (waiting > 0) {
      throw new BusinessError('CONFLICT', `还有 ${waiting} 份领用单待发放，不能停用`)
    }
    if (material.采购中) {
      throw new BusinessError('CONFLICT', '采购单尚未确认入库，不能停用')
    }
    material.status = STATUS_DISABLED
    material.abnormal = true
    material.pending = false
    material.version = Number(material.version ?? 0) + 1
    for (const row of alerts) {
      const alert = asAlert(row)
      if (alert.耗材编号 === material.耗材编号 && alert.status === ALERT_ACTIVE) {
        alert.status = ALERT_RESOLVED
        alert.pending = false
        alert.解除时间 = nowText()
      }
    }
    sweep(draft)
    return { ok: true, message: `耗材「${material.耗材编号}」已标记停用` }
  })
}

function filterRows<T extends EntryRow>(rows: T[], filters: Record<string, string>): T[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listMaterials(filters: Record<string, string> = {}): {
  items: MaterialRow[]
  total: number
} {
  const items = filterRows(
    (listRows(MATERIAL_KEY) as MaterialRow[]).map((row) => ({ ...row })),
    filters,
  )
  return { items, total: items.length }
}

export function listRequisitions(filters: Record<string, string> = {}): {
  items: RequisitionRow[]
  total: number
} {
  const items = filterRows(listRows(REQUISITION_KEY) as RequisitionRow[], filters).sort(
    (a, b) => Number(b.id) - Number(a.id),
  )
  return { items, total: items.length }
}

export function listAlerts(includeResolved = false): MaterialAlertRow[] {
  const rows = listRows(ALERT_KEY) as MaterialAlertRow[]
  return rows
    .filter((row) => includeResolved || row.status === ALERT_ACTIVE)
    .sort((a, b) => Number(b.id) - Number(a.id))
}

export function materialOptions(): { id: number; code: string; name: string }[] {
  return (listRows(MATERIAL_KEY) as MaterialRow[])
    .filter((row) => row.status !== STATUS_DISABLED)
    .map((row) => ({ id: Number(row.id), code: row.耗材编号, name: row.耗材名称 }))
}

export function materialStats(): MaterialStats {
  const materials = listRows(MATERIAL_KEY) as MaterialRow[]
  const requisitions = listRows(REQUISITION_KEY) as RequisitionRow[]
  const alerts = listRows(ALERT_KEY) as MaterialAlertRow[]
  return {
    kinds: materials.filter((row) => row.status !== STATUS_DISABLED).length,
    needPurchase: materials.filter((row) => row.status === STATUS_PURCHASE).length,
    low: materials.filter((row) => row.status === STATUS_LOW).length,
    waitingRequisitions: requisitions.filter((row) => row.status === REQUISITION_WAITING).length,
    activeAlerts: alerts.filter((row) => row.status === ALERT_ACTIVE).length,
  }
}
