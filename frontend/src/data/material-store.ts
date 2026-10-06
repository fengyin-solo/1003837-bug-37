/**
 * 发掘耗材领域存储：库存、预警提醒、采购单、领用待办与流水的唯一数据源。
 *
 * 列表页、领用页看到的数量都从这里读取（同一口径），不允许各页面自己算库存。
 * 所有写操作走 commit：先快照，任一步失败或写盘不生效就整体退回，绝不留半截状态。
 */

import type { Material, MaterialState, Requisition, StockAlert, StockMovement, PurchaseOrder } from './material-types'

export type { Material, MaterialState, PurchaseOrder, Requisition, StockAlert, StockMovement } from './material-types'

/** 入库事务失败时抛出，消息可直接展示给操作员。 */
export class MaterialRuleError extends Error {}

// ---------- 持久化 ----------

const STORAGE_KEY = 'field-archaeology-digital:material-domain'
/** 跨终端（浏览器标签页）锁的存活毫秒数，超过视为死锁可接管。 */
const LOCK_TTL_MS = 15_000

let terminalId = ''
export function currentTerminal(): string {
  if (!terminalId) {
    const key = 'field-archaeology-digital:terminal-id'
    let id = ''
    if (typeof window !== 'undefined' && window.localStorage) {
      id = window.localStorage.getItem(key) ?? ''
      if (!id) {
        id = `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        window.localStorage.setItem(key, id)
      }
    } else {
      id = `T-${Math.random().toString(36).slice(2, 10)}`
    }
    terminalId = id
  }
  return terminalId
}

function persist(state: MaterialState): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const raw = JSON.stringify(state)
  window.localStorage.setItem(STORAGE_KEY, raw)
  // 写盘后校验：配额/隐私模式等导致没真正生效时，让事务整体退回。
  const back = window.localStorage.getItem(STORAGE_KEY)
  if (back !== raw) {
    throw new MaterialRuleError('库存状态写入失败，本次操作已整体退回，请重试')
  }
  // 其他标签页依赖 storage 事件感知变更
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------- 种子与迁移 ----------

function seedState(): MaterialState {
  const now = new Date().toISOString()
  // 当前数量口径直接播种成符合阈值语义的数据，列表、库存、领用清单天然一致。
  const seedMaterials: Material[] = [
    { id: 1, code: 'MATE-0001', name: '手铲', spec: '小号钢铲', category: '发掘工具', stock: 48, threshold: 10, keeper: '王保管', status: '充足', version: 0 },
    { id: 2, code: 'MATE-0002', name: '编织袋', spec: '50×80cm', category: '包装耗材', stock: 8, threshold: 20, keeper: '王保管', status: '偏低', version: 0 },
    { id: 3, code: 'MATE-0003', name: '记号笔', spec: '黑色油性', category: '记录耗材', stock: 4, threshold: 30, keeper: '李保管', status: '需采购', version: 0 },
  ]
  return {
    materials: seedMaterials,
    requisitions: [
      // 历史领用记录：保留申请当时的数量口径（库存 35 时领用 10），后续库存变动不回改。
      {
        id: 1, materialId: 1, materialCode: 'MATE-0001', materialName: '手铲',
        qty: 10, applicant: '张发掘', createdAt: now, status: '已出库',
        snapshotStock: 35, snapshotThreshold: 10,
      },
    ],
    purchases: [
      {
        id: 1, materialId: 3, materialCode: 'MATE-0003', materialName: '记号笔',
        qty: 50, applicant: '李保管', createdAt: now, status: '待入库', version: 0,
      },
    ],
    alerts: [
      // MATE-0002 已在阈值线以下：只挂一份未关闭提醒；MATE-0003 的提醒已随发起采购关闭。
      { id: 1, materialId: 2, materialCode: 'MATE-0002', materialName: '编织袋', seqNo: 1, open: true, createdAt: now },
      {
        id: 2, materialId: 3, materialCode: 'MATE-0003', materialName: '记号笔',
        seqNo: 1, open: false, createdAt: now, closedAt: now, closedReason: '已发起采购，转采购跟踪',
      },
    ],
    movements: [
      { id: 1, materialId: 1, materialCode: 'MATE-0001', change: -10, balance: 35, reason: '领用出库', refId: 1, createdAt: now },
      { id: 2, materialId: 1, materialCode: 'MATE-0001', change: 13, balance: 48, reason: '盘盈调整', createdAt: now },
    ],
    seq: 2,
    inboundLocks: {},
    version: 0,
  }
}

/**
 * 旧版通用表里若已有耗材记录（首次升级到领域存储），迁移成耗材主数据。
 * 迁移时严格按当前数量与阈值重算状态，避免「数量够却还挂需采购」的旧残留。
 */
function migrateFromLegacy(): MaterialState | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const legacyRaw = window.localStorage.getItem('field-archaeology-digital:entries')
  if (!legacyRaw) {
    return null
  }
  try {
    const legacy = JSON.parse(legacyRaw) as Record<string, unknown[]>
    const rows = legacy['material']
    if (!Array.isArray(rows) || rows.length === 0) {
      return null
    }
    const state = seedState()
    const migrated: Material[] = []
    rows.forEach((rawRow, index) => {
      const row = rawRow as Record<string, unknown>
      const code = String(row['耗材编号'] ?? `MATE-MIG-${index + 1}`)
      if (state.materials.some((item) => item.code === code)) {
        return
      }
      const stock = Number(row['当前数量'] ?? 0)
      const threshold = Number(row['预警数量'] ?? 0)
      migrated.push({
        id: index + 1000,
        code,
        name: String(row['耗材名称'] ?? code),
        spec: String(row['规格型号'] ?? ''),
        category: String(row['用途分类'] ?? ''),
        stock: Number.isFinite(stock) ? stock : 0,
        threshold: Number.isFinite(threshold) ? threshold : 0,
        keeper: String(row['保管人'] ?? ''),
        status: stock <= threshold ? '偏低' : '充足',
        version: 0,
      })
    })
    if (migrated.length === 0) {
      return null
    }
    state.materials = migrated
    return state
  } catch {
    return null
  }
}

let cache: MaterialState | null = null

/** 兼容旧版本落库结构：补齐新字段、丢弃已废弃字段。 */
function normalizeState(raw: Record<string, unknown>): MaterialState {
  const state = raw as unknown as MaterialState
  state.materials = Array.isArray(state.materials) ? state.materials : []
  state.requisitions = Array.isArray(state.requisitions) ? state.requisitions : []
  state.purchases = Array.isArray(state.purchases) ? state.purchases : []
  state.alerts = Array.isArray(state.alerts)
    ? state.alerts.map((alert: Record<string, unknown>) => {
      const legacyEpisode = typeof alert.episode === 'number' ? alert.episode : 1
      return {
        id: Number(alert.id),
        materialId: Number(alert.materialId),
        materialCode: String(alert.materialCode ?? ''),
        materialName: String(alert.materialName ?? ''),
        seqNo: typeof alert.seqNo === 'number' ? alert.seqNo : legacyEpisode,
        open: Boolean(alert.open),
        createdAt: String(alert.createdAt ?? ''),
        closedAt: alert.closedAt as string | undefined,
        closedReason: alert.closedReason as string | undefined,
      }
    })
    : []
  state.movements = Array.isArray(state.movements) ? state.movements : []
  state.inboundLocks = state.inboundLocks ?? {}
  state.seq = typeof state.seq === 'number'
    ? Math.max(state.seq, ...state.materials.map((item) => item.id), 0)
    : 0
  state.version = state.version ?? 0
  return state
}

export function loadState(): MaterialState {
  if (cache) {
    return cache
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        cache = normalizeState(JSON.parse(raw) as Record<string, unknown>)
        return cache
      } catch {
        window.localStorage.removeItem(STORAGE_KEY)
      }
    }
    const migrated = migrateFromLegacy()
    cache = migrated ?? seedState()
    persist(cache)
    return cache
  }
  cache = seedState()
  return cache
}

/** 跨标签页时按存储里的最新版本对齐，避免本页缓存把另一终端的确认入库覆盖掉。 */
export function refreshState(): MaterialState {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const latest = normalizeState(JSON.parse(raw) as Record<string, unknown>)
        if (!cache || latest.version >= cache.version) {
          cache = latest
        }
      } catch {
        /* 落库损坏时沿用内存态 */
      }
    }
  }
  return loadState()
}

// ---------- 事务 ----------

type CommitResult<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * 执行一笔领域事务：
 * 1. 从磁盘取最新状态（不吃跨标签页的旧缓存）；
 * 2. 快照后交给 worker 原地改 draft，抛错即回滚；
 * 3. 写盘后再读回校验，没真正生效也回滚。
 */
export function commit<T>(worker: (draft: MaterialState) => T): CommitResult<T> {
  const fresh = refreshState()
  const baseVersion = fresh.version
  const snapshot = clone(fresh)
  try {
    const value = worker(fresh)
    fresh.version += 1
    persist(fresh)
    return { ok: true, value }
  } catch (error) {
    cache = snapshot
    if (typeof window !== 'undefined' && window.localStorage) {
      // 仅当磁盘还停留在本事务开始前的版本（没有其他终端抢先提交）才恢复快照，
      // 否则绝不拿本页旧快照覆盖别的终端已经生效的入库。
      try {
        const currentRaw = window.localStorage.getItem(STORAGE_KEY)
        const current = currentRaw ? (JSON.parse(currentRaw) as MaterialState) : null
        if (!current || current.version === baseVersion) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
        }
      } catch {
        /* 磁盘不可读时不覆盖，交由操作员核对后重试 */
      }
    }
    const message = error instanceof Error ? error.message : '耗材操作失败，已整体退回'
    return { ok: false, message }
  }
}

export function nextId(draft: MaterialState): number {
  draft.seq += 1
  return draft.seq
}

// ---------- 并发锁 ----------

/** 尝试占用某耗材的入库锁；被其他终端持有时明确拒绝。 */
export function acquireInboundLock(draft: MaterialState, materialCode: string, now: number): void {
  const held = draft.inboundLocks[materialCode]
  if (held && held.terminal !== currentTerminal() && held.expiresAt > now) {
    throw new MaterialRuleError(
      `另一终端正在确认「${materialCode}」入库（锁 ${new Date(held.expiresAt).toLocaleTimeString()} 前有效），本次请求已明确拒绝，库存未重复增加`,
    )
  }
  draft.inboundLocks[materialCode] = { terminal: currentTerminal(), expiresAt: now + LOCK_TTL_MS }
}

export function releaseInboundLock(draft: MaterialState, materialCode: string): void {
  const held = draft.inboundLocks[materialCode]
  if (held && held.terminal === currentTerminal()) {
    delete draft.inboundLocks[materialCode]
  }
}

/** 清理过期死锁。 */
export function pruneLocks(draft: MaterialState, now: number): void {
  for (const [code, held] of Object.entries(draft.inboundLocks)) {
    if (held.expiresAt <= now) {
      delete draft.inboundLocks[code]
    }
  }
}
