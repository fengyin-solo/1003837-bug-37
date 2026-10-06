/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 发掘耗材：数量与预警线是数字，version 是确认入库用的乐观锁版本号。 */
export type MaterialRow = EntryRow & {
  耗材编号: string
  耗材名称: string
  规格型号: string
  用途分类: string
  当前数量: number
  预警数量: number
  保管人: string
  /** 已发起采购、等待确认入库：与待发放领用单共同决定「需采购」状态。 */
  采购中: boolean
  version: number
}

/** 发掘耗材领用记录：申请时库存/预警线是历史快照，后续库存变化不改写。 */
export type RequisitionRow = EntryRow & {
  领用单号: string
  耗材编号: string
  耗材名称: string
  领用数量: number
  领用人: string
  用途: string
  申请时间: string
  申请时库存: number
  申请时预警线: number
  发放时间: string
  发放后库存: number | string
}

/** 耗材预警提醒：同一耗材编号的一次阈值跨越只允许存在一份「预警中」。 */
export type MaterialAlertRow = EntryRow & {
  提醒编号: string
  耗材编号: string
  耗材名称: string
  预警数量: number
  触发时库存: number
  触发时间: string
  解除时间: string
}
