/**
 * 耗材领域规则验证脚本：node scripts/verify-material-rules.mjs
 * 用内存版 localStorage 模拟两个终端（标签页）共享同一底层存储，覆盖每条修复不变量。
 *
 * 运行前需先 build:test（esbuild 把领域代码打成两份独立 IIFE，模块内终端 ID 各自隔离）。
 */
import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

// ---- 内存版 localStorage：两个终端共享同一个 map，模拟同源多标签页 ----
class MemoryStorage {
  constructor(map) {
    this.map = map
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    this.map.set(k, String(v))
  }
  removeItem(k) {
    this.map.delete(k)
  }
}

// 把领域代码（含 @ 别名）打成 IIFE，再注入到带独立 window/localStorage 的沙箱，
// 每个沙箱有自己的模块实例与终端 ID，但底层共享同一个内存存储（模拟同源多标签页）。
async function makeLoader() {
  const result = await build({
    stdin: {
      contents: `
        import * as svc from '${join(root, 'src/api/material-service.ts').replaceAll('\\\\', '/')}'
        Object.assign(globalThis.__svc__ = {}, svc)
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    alias: { '@': join(root, 'src') },
  })
  const code = result.outputFiles[0].text
  return function terminal(sharedMap) {
    const storage = new MemoryStorage(sharedMap)
    const win = { localStorage: storage }
    const globalScope = {}
    const fn = new Function('window', 'globalThis', `"use strict";\n${code}\n;return globalThis.__svc__`)
    return fn(win, globalScope)
  }
}

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error.stack || error)
    process.exitCode = 1
  }
}

const shared = new Map()
const createTerminal = await makeLoader()
const A = createTerminal(shared) // 终端 A（先初始化并播种）
const B = createTerminal(shared) // 终端 B：共享存储，独立模块实例/终端 ID

console.log('\n[1] 初始口径一致 & 历史领用快照')
check('列表库存按阈值语义播种（手铲 48/10 充足）', () => {
  const m1 = A.listMaterials().find((x) => x.code === 'MATE-0001')
  assert.equal(m1.stock, 48)
  assert.equal(m1.status, '充足')
})
check('历史领用记录保留申请当时口径 35/10', () => {
  const req = A.listRequisitions().find((r) => r.id === 1)
  assert.equal(req.snapshotStock, 35)
  assert.equal(req.snapshotThreshold, 10)
  assert.equal(req.status, '已出库')
})
check('种子里低于阈值的 MATE-0002 只有一份未关闭提醒', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0002').length, 1)
})

console.log('\n[2] 同一耗材编号跨越阈值只生成一份提醒')
let r = A.createRequisition({ materialId: 1, qty: 30, applicant: '张三' }) // 48→18
assert.equal(r.ok, true)
check('阈值上方领用不产生提醒', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001').length, 0)
})
r = A.createRequisition({ materialId: 1, qty: 9, applicant: '张三' }) // 18→9 穿越
assert.equal(r.ok, true)
check('跌破瞬间恰好生成一份提醒', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001').length, 1)
})
A.createRequisition({ materialId: 1, qty: 2, applicant: '李四' }) // 9→7
A.adjustStock(1, -1) // 7→6
check('同一轮低库存期内继续领用/盘点不产生第二份', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001').length, 1)
})
check('领用页待办与列表库存同口径（库存=6）', () => {
  assert.equal(A.getMaterial(1).stock, 6)
  const todos = A.listRequisitionTodos()
  assert.ok(todos.some((t) => t.materialCode === 'MATE-0001' && t.kind === '库存预警'))
})

console.log('\n[3] 发起采购：转需采购并关闭本轮提醒')
const pur = A.createPurchase({ materialId: 1, qty: 20, applicant: '王五' })
assert.equal(pur.ok, true, pur.message)
check('状态需采购、未关闭提醒清零、采购单待入库', () => {
  assert.equal(A.getMaterial(1).status, '需采购')
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001').length, 0)
  assert.equal(A.listPurchases().find((p) => p.id === pur.value.id).status, '待入库')
})
check('重复发起采购被拒绝', () => {
  assert.equal(A.createPurchase({ materialId: 1, qty: 5, applicant: '王五' }).ok, false)
})

console.log('\n[4] 确认入库：同事务回写库存 + 采购状态 + 领用清单')
const backlog = A.createRequisition({ materialId: 1, qty: 10, applicant: '赵六' })
check('库存不足领用登记为待备货且不扣库存', () => {
  assert.equal(backlog.value.status, '待备货')
  assert.equal(A.getMaterial(1).stock, 6)
  assert.equal(A.listRequisitions().filter((x) => x.status === '待备货').length, 1)
})
const inbound = A.confirmInbound(pur.value.id)
assert.equal(inbound.ok, true, inbound.message)
check('库存 6+20-10(待备货)=16；采购单已入库；待备货核销并回写入库单号', () => {
  assert.equal(A.getMaterial(1).stock, 16)
  assert.equal(A.listPurchases().find((p) => p.id === pur.value.id).status, '已入库')
  const req = A.listRequisitions().find((x) => x.id === backlog.value.id)
  assert.equal(req.status, '已出库')
  assert.equal(req.fulfilledBy, pur.value.id)
  assert.equal(A.listRequisitionTodos().filter((t) => t.kind === '待备货').length, 0)
})
check('入库后状态据实重算为充足，旧需采购不残留', () => {
  assert.equal(A.getMaterial(1).status, '充足')
})
check('历史领用记录数量口径冻结（6/10），最早记录仍是 35/10', () => {
  const req = A.listRequisitions().find((x) => x.id === backlog.value.id)
  assert.equal(req.snapshotStock, 6)
  assert.equal(req.snapshotThreshold, 10)
  assert.equal(A.listRequisitions().find((x) => x.id === 1).snapshotStock, 35)
})
check('流水完整：领用→领用→领用→盘点→采购入库→待备货出库', () => {
  const moves = A.listMovements(1).map((m) => ({ reason: m.reason, change: m.change, balance: m.balance }))
  assert.deepEqual(moves, [
    { reason: '领用出库', change: -10, balance: 35 },
    { reason: '盘盈调整', change: 13, balance: 48 },
    { reason: '领用出库', change: -30, balance: 18 },
    { reason: '领用出库', change: -9, balance: 9 },
    { reason: '领用出库', change: -2, balance: 7 },
    { reason: '盘点调整', change: -1, balance: 6 },
    { reason: '采购入库', change: 20, balance: 26 },
    { reason: '待备货出库', change: -10, balance: 16 },
  ])
})

console.log('\n[5] 恢复后再次跌破：允许且只再生成一份')
A.createRequisition({ materialId: 1, qty: 10, applicant: '钱七' }) // 16→6
check('新一次下行穿越只有一份未关闭提醒', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001' && a.open).length, 1)
})
A.createRequisition({ materialId: 1, qty: 1, applicant: '孙八' })
check('继续领用不叠加提醒', () => {
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0001' && a.open).length, 1)
})

console.log('\n[6] 两个终端并发确认入库：只入一次账，另一个明确拒绝')
const beforeStock3 = B.getMaterial(3).stock // 种子 4
assert.equal(beforeStock3, 4)
const r1 = A.confirmInbound(1)
const r2 = B.confirmInbound(1)
check('第一个成功、第二个明确拒绝', () => {
  assert.equal(r1.ok, true, r1.message)
  assert.equal(r2.ok, false)
  assert.match(r2.message, /已由终端|已拒绝|正在确认/)
})
check('库存只入账一次 4+50=54（两个终端读到一致值）', () => {
  assert.equal(A.getMaterial(3).stock, 54)
  assert.equal(B.getMaterial(3).stock, 54)
})
check('采购入库流水只有一笔 +50', () => {
  assert.deepEqual(
    A.listMovements(3).filter((m) => m.reason === '采购入库').map((m) => m.change),
    [50],
  )
})
check('采购单记录确认终端，旧需采购状态清除为充足', () => {
  const order = A.listPurchases().find((p) => p.id === 1)
  assert.equal(order.status, '已入库')
  assert.ok(order.inboundTerminal)
  assert.equal(A.getMaterial(3).status, '充足')
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0003').length, 0)
})

console.log('\n[7] 失败整体退回，不留半截')
const stock2 = A.getMaterial(2).stock
check('不存在采购单的入库请求被拒，库存不变', () => {
  assert.equal(A.confirmInbound(99999).ok, false)
  assert.equal(A.getMaterial(2).stock, stock2)
})
check('重复确认已入库单被拒，库存不二次增加', () => {
  const s = A.getMaterial(3).stock
  assert.equal(A.confirmInbound(1).ok, false)
  assert.equal(A.getMaterial(3).stock, s)
})
check('非法数量请求在事务前拦截，库存不变', () => {
  const s = A.getMaterial(2).stock
  assert.equal(A.createRequisition({ materialId: 2, qty: 0, applicant: 'X' }).ok, false)
  assert.equal(A.getMaterial(2).stock, s)
})
check('事务中途失败：已改的库存/采购单/领用清单整体退回，不留半截', () => {
  // 给 MATE-0002 备一张待入库采购单和一条待备货领用
  const before = {
    stock: A.getMaterial(2).stock,
    purchases: A.listPurchases().length,
    requisitions: A.listRequisitions().length,
    movements: A.listMovements(2).length,
  }
  const result = A.commit((draft) => {
    const material = draft.materials.find((x) => x.id === 2)
    material.stock += 30 // 先改库存（模拟入库回写第一步）
    draft.purchases.push({
      id: 999001, materialId: 2, materialCode: material.code, materialName: material.name,
      qty: 30, applicant: 'X', createdAt: new Date().toISOString(), status: '已入库', version: 0,
    })
    draft.requisitions.push({
      id: 999002, materialId: 2, materialCode: material.code, materialName: material.name,
      qty: 5, applicant: 'X', createdAt: new Date().toISOString(), status: '已出库',
      snapshotStock: material.stock, snapshotThreshold: material.threshold,
    })
    throw new A.MaterialRuleError('模拟领用清单回写失败')
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /模拟领用清单回写失败/)
  assert.equal(A.getMaterial(2).stock, before.stock)
  assert.equal(A.listPurchases().length, before.purchases)
  assert.equal(A.listRequisitions().length, before.requisitions)
  assert.equal(A.listMovements(2).length, before.movements)
})

console.log('\n[8] 取消采购：旧状态据实回落，不残留')
const p2 = A.createPurchase({ materialId: 2, qty: 30, applicant: '王保管' })
assert.equal(p2.ok, true)
assert.equal(A.getMaterial(2).status, '需采购')
const cancel = A.cancelPurchase(p2.value.id)
check('取消后回到偏低且只挂一份预警（不残留需采购）', () => {
  assert.equal(cancel.ok, true)
  assert.equal(A.getMaterial(2).status, '偏低')
  assert.equal(A.listOpenAlerts().filter((a) => a.materialCode === 'MATE-0002' && a.open).length, 1)
})

console.log(`\n全部 ${passed} 项检查通过`)
if (process.exitCode) {
  process.exit(process.exitCode)
}
