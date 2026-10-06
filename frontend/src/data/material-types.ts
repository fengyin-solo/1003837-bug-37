/** 发掘耗材领域的公共类型：store 与 service 共用，页面只从 service 取数。 */

/** 耗材主数据：当前数量是库存唯一口径，预警数量即阈值。 */
export type Material = {
  id: number
  code: string
  name: string
  spec: string
  category: string
  stock: number
  threshold: number
  keeper: string
  /** 充足 / 偏低 / 需采购 / 已停用。需采购只取决于是否存在在途采购单。 */
  status: string
  version: number
}

/** 领用记录：申请即出库。snapshotStock/snapshotThreshold 是申请当时的数量口径，历史记录永不回改。 */
export type Requisition = {
  id: number
  materialId: number
  materialCode: string
  materialName: string
  qty: number
  applicant: string
  createdAt: string
  /** 待备货：申请当时库存不足挂起的待办，入库补货后可能被满足。 */
  status: '已出库' | '待备货'
  /** 待备货待办被某次入库满足时回写；已出库记录永远停在申请时刻。 */
  fulfilledBy?: number
  // 当时数量口径（快照，冻结）
  snapshotStock: number
  snapshotThreshold: number
}

export type PurchaseOrder = {
  id: number
  materialId: number
  materialCode: string
  materialName: string
  qty: number
  applicant: string
  createdAt: string
  status: '待入库' | '已入库' | '已取消'
  /** 已入库后记录确认入库的终端与时间，并发确认时据此只放行一次。 */
  inboundAt?: string
  inboundTerminal?: string
  version: number
}

/** 预警提醒：同一耗材编号每次「自上而下穿越阈值」只生成一份未关闭提醒（按未关闭提醒去重）。 */
export type StockAlert = {
  id: number
  materialId: number
  materialCode: string
  materialName: string
  /** 同一轮低库存期的序号，仅用于追溯；去重以「是否已有未关闭提醒」为准。 */
  seqNo: number
  open: boolean
  createdAt: string
  closedAt?: string
  /** 关闭原因：入库补货恢复 / 发起采购转为采购跟踪。 */
  closedReason?: string
}

export type MovementReason =
  | '领用出库'
  | '采购入库'
  | '待备货出库'
  | '盘点调整'
  | '盘盈调整'
  | string

/** 库存流水：任何数量变动都落一笔，库存口径可追溯。 */
export type StockMovement = {
  id: number
  materialId: number
  materialCode: string
  change: number
  balance: number
  reason: MovementReason
  refId?: number
  createdAt: string
}

export type MaterialState = {
  materials: Material[]
  requisitions: Requisition[]
  purchases: PurchaseOrder[]
  alerts: StockAlert[]
  movements: StockMovement[]
  seq: number
  /** 入库并发锁：key=耗材编号，value 为持锁终端与过期时间。 */
  inboundLocks: Record<string, { terminal: string; expiresAt: number }>
  version: number
}
