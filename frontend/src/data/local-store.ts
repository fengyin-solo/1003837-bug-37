import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

/** 耗材业务面的两个集合：与耗材行同库，动作要在同一事务里回写。 */
export const MATERIAL_KEY = 'material'
export const REQUISITION_KEY = 'material_requisition'
export const ALERT_KEY = 'material_alert'
export const BUSINESS_KEYS = [MATERIAL_KEY, REQUISITION_KEY, ALERT_KEY] as const

export type Store = Record<string, EntryRow[]>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// Node（验证脚本）环境下没有 localStorage，给一个最小内存实现。
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { localStorage?: Storage }
    if (g.localStorage) {
      return g.localStorage
    }
    g.localStorage = memoryStorage()
    return g.localStorage
  }
  return null
}

/** 老版本种子里的耗材行没有 version：按 0 迁移，下一次写入自然升级。 */
function migrate(store: Store): Store {
  for (const row of store[MATERIAL_KEY] ?? []) {
    if (typeof row.version !== 'number') {
      row.version = 0
    }
    if (typeof row.当前数量 !== 'number') {
      row.当前数量 = Number(row.当前数量) || 0
    }
    if (typeof row.预警数量 !== 'number') {
      row.预警数量 = Number(row.预警数量) || 0
    }
    if (typeof row.采购中 !== 'boolean') {
      // 老存档没有采购中标记：有待发放单时由 sweep 兜底，这里保守按 false 迁移。
      row.采购中 = false
    }
  }
  return store
}

function readLatest(): Store {
  const fallback = migrate(clone(SEED_ROWS))
  const storage = getStorage()
  if (!storage) {
    return fallback
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Store
    // 老存档里没有后来新增的业务集合，用种子补齐。
    return migrate({ ...clone(SEED_ROWS), ...clone(parsed) })
  } catch {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function persist(store: Store): void {
  const storage = getStorage()
  if (storage) {
    storage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

/**
 * 整库快照读取：不做进程内缓存，保证另一个终端（标签页）刚确认入库后，
 * 本端立刻能看到新的 version 与库存。
 */
export function allRows(): Store {
  return readLatest()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 测试辅助：把整库重置回种子，隔离用例之间的状态。 */
export function resetAll(): void {
  persist(migrate(clone(SEED_ROWS)))
}

/**
 * 整库事务：mutate 直接在快照上改；返回后一次性落库。
 * mutate 抛错或后置校验抛错都不会触碰 localStorage —— 调用方看到失败即视为整体退回。
 */
export function commitStore<T>(mutate: (draft: Store) => T): T {
  const snapshot = readLatest()
  const draft = clone(snapshot)
  const result = mutate(draft)
  // 后置一致性校验放在 mutate 内部抛出时，到这里同样不写库。
  persist(draft)
  return result
}

export function storageKey(): string {
  return STORAGE_KEY
}
