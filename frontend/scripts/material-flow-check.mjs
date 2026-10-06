// 耗材业务链路验证脚本：把 scripts/_harness.ts（含 @ 别名）打包后在 Node 里跑。
// 覆盖：阈值下行跨越只提醒一次、库存不足进待发放、入库三业务面同事务回写、
//       入库 FIFO 补发、两终端并发确认只扣一次（另一请求明确拒绝）、
//       历史领用记录保留申请时口径、事务失败整体退回。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadHarness() {
  const result = await build({
    entryPoints: [path.join(root, 'scripts/_harness.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@': path.join(root, 'src') },
  })
  const dir = path.join(os.tmpdir(), 'material-flow-check')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'harness.mjs')
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const svc = await loadHarness()
const { resetAll } = svc

let passed = 0
function check(name, fn) {
  resetAll()
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function getMaterial(code) {
  return svc.listMaterials({}).items.find((row) => row.耗材编号 === code)
}
function requisitions() {
  return svc.listRequisitions({}).items
}
function activeAlerts() {
  return svc.listAlerts(false)
}

// 1. 库存下行跨越预警线只生成一份提醒；之后再领用（仍在线下）不重复提醒。
check('同一耗材编号跨越阈值只生成一份提醒', () => {
  const before = getMaterial('MATE-0001') // 库存 30，预警线 10
  assert.equal(before.status, '充足')
  const r1 = svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 25, receiver: '甲', purpose: '测试' })
  assert.equal(r1.alertRaised, true)
  const after1 = getMaterial('MATE-0001')
  assert.equal(after1.当前数量, 5)
  assert.equal(after1.status, '偏低')
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 1)

  const r2 = svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 1, receiver: '乙', purpose: '测试' })
  assert.equal(r2.alertRaised, false)
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 1, '仍只有一份提醒')
  assert.equal(getMaterial('MATE-0001').当前数量, 4)
})

// 2. 库存恢复到预警线上后提醒解除；再次下行跨越可生成新一轮的一份提醒。
check('回补后提醒解除，再次跨越仍只生成一份', () => {
  svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 21, receiver: '甲', purpose: '测试' })
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 1)
  const low = getMaterial('MATE-0001') // 30-21=9，偏低
  const purchased = svc.startPurchase(low.id)
  assert.equal(purchased.ok, true)
  const purchasing = getMaterial('MATE-0001')
  assert.equal(purchasing.version, low.version + 1, '发起采购推进版本')
  svc.confirmInbound({ id: purchasing.id, quantity: 20, expectedVersion: purchasing.version })
  // 9+20=29（无待发放单），>10 -> 充足
  assert.equal(getMaterial('MATE-0001').当前数量, 29)
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 0)
  const r = svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 20, receiver: '丙', purpose: '测试' })
  assert.equal(r.alertRaised, true)
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 1)
})

// 3. 库存不足：领用单进入待发放，耗材转「需采购」；重复发起采购被拒绝。
check('库存不足生成待发放待办并进入需采购', () => {
  // MATE-0002 库存 4 预警 10，状态偏低，无待办
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 8, receiver: '甲', purpose: '测试' })
  const m = getMaterial('MATE-0002')
  assert.equal(m.当前数量, 4, '不足时不扣库存')
  assert.equal(m.status, '需采购')
  const waiting = requisitions().filter((r) => r.耗材编号 === 'MATE-0002' && r.status === '待发放')
  assert.equal(waiting.length, 1)
  assert.equal(svc.startPurchase(m.id).ok, true)
  assert.throws(() => svc.startPurchase(getMaterial('MATE-0002').id), /等待确认入库/)
})

// 4. 确认入库同时回写三个业务面：库存、采购状态、领用清单。
check('确认入库同事务回写库存/采购状态/领用清单', () => {
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 8, receiver: '甲', purpose: '测试' })
  const need = getMaterial('MATE-0002')
  svc.startPurchase(need.id)
  const m = getMaterial('MATE-0002')
  const result = svc.confirmInbound({ id: m.id, quantity: 14, expectedVersion: m.version })
  // 4+14=18，FIFO 补发 8，剩 10 == 预警线 10，状态偏低
  assert.equal(result.issued, 1)
  const after = getMaterial('MATE-0002')
  assert.equal(after.当前数量, 10)
  assert.equal(after.status, '偏低', '无待办且数量<=预警线 -> 偏低，旧的需采购被清掉')
  assert.equal(after.采购中, false)
  const req = requisitions().find((r) => r.耗材编号 === 'MATE-0002')
  assert.equal(req.status, '已发放')
  assert.equal(req.发放后库存, 10)
  assert.ok(req.发放时间)
  assert.equal(svc.listAlerts(false).filter((a) => a.耗材编号 === 'MATE-0002').length, 1, '仍在预警线下，提醒保留')
})

// 5. 入库量不够补发：剩余领用单保持待发放，状态保持「需采购」（不提前清）。
check('入库不足以补齐时保留待发放与需采购状态', () => {
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 8, receiver: '甲', purpose: '测试' })
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 5, receiver: '乙', purpose: '测试' })
  const need = getMaterial('MATE-0002')
  svc.startPurchase(need.id)
  const m = getMaterial('MATE-0002')
  const result = svc.confirmInbound({ id: m.id, quantity: 6, expectedVersion: m.version })
  // 4+6=10：FIFO 先补发第一份 8（剩 2），第二份要 5 不够而保留待发放
  assert.equal(result.issued, 1)
  assert.equal(result.remaining, 1)
  assert.equal(getMaterial('MATE-0002').当前数量, 2)
  assert.equal(getMaterial('MATE-0002').status, '需采购')
  assert.equal(getMaterial('MATE-0002').采购中, false)
  assert.equal(requisitions().filter((r) => r.耗材编号 === 'MATE-0002' && r.status === '待发放').length, 1)
  assert.equal(requisitions().filter((r) => r.耗材编号 === 'MATE-0002' && r.status === '已发放').length, 1)
  // 仍需采购时可以再次发起采购
  const again = getMaterial('MATE-0002')
  assert.equal(svc.startPurchase(again.id).ok, true)
  assert.equal(getMaterial('MATE-0002').采购中, true)
})

// 6. 两终端并发确认入库：只扣一次库存，持旧版本的另一请求被明确拒绝。
check('并发确认入库只扣一次，另一请求明确拒绝', () => {
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 8, receiver: '甲', purpose: '并发' })
  const need = getMaterial('MATE-0002')
  svc.startPurchase(need.id)
  const terminalA = getMaterial('MATE-0002')
  const terminalBVersion = terminalA.version // 两个终端同时读到同一版本
  const rA = svc.confirmInbound({ id: terminalA.id, quantity: 14, expectedVersion: terminalA.version })
  assert.equal(rA.ok, true)
  assert.equal(getMaterial('MATE-0002').当前数量, 10)
  let code = null
  try {
    svc.confirmInbound({ id: terminalA.id, quantity: 14, expectedVersion: terminalBVersion })
  } catch (error) {
    code = error.code
  }
  assert.equal(code, 'CONCURRENT')
  assert.equal(getMaterial('MATE-0002').当前数量, 10, '库存未被扣第二次')
  assert.equal(
    requisitions().filter((r) => r.耗材编号 === 'MATE-0002' && r.status === '已发放').length,
    1,
    '领用单只补发一次',
  )
})

// 7. 历史领用记录保留当时数量口径（申请时库存、当时预警线快照），后续变更不改写。
check('历史领用记录保留当时数量口径', () => {
  svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 5, receiver: '甲', purpose: '历史' })
  const first = requisitions().find((r) => r.领用人 === '甲' && r.用途 === '历史')
  assert.equal(first.申请时库存, 30)
  assert.equal(first.申请时预警线, 10)
  assert.equal(first.发放后库存, 25)
  svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 20, receiver: '乙', purpose: '后续' })
  const reloaded = requisitions().find((r) => r.id === first.id)
  assert.equal(reloaded.申请时库存, 30, '快照不被改写')
  assert.equal(reloaded.申请时预警线, 10)
  assert.equal(reloaded.发放后库存, 25)
})

// 8. 事务失败整体退回：没有进行中的采购单时确认入库被拒，库存与版本原样不动。
check('非法入库被拒时整体退回', () => {
  const m = getMaterial('MATE-0001') // 充足
  const stockBefore = m.当前数量
  const versionBefore = m.version
  let code = null
  try {
    svc.confirmInbound({ id: m.id, quantity: 10, expectedVersion: m.version })
  } catch (error) {
    code = error.code
  }
  assert.equal(code, 'CONFLICT')
  const after = getMaterial('MATE-0001')
  assert.equal(after.当前数量, stockBefore)
  assert.equal(after.version, versionBefore, '版本未推进')
  assert.equal(after.status, '充足')
})

// 9. 非法输入（非正整数、不存在的编号、停用耗材领用）均拒绝。
check('非法输入与停用耗材被拒绝', () => {
  assert.throws(() => svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 0, receiver: '甲', purpose: '' }))
  assert.throws(() => svc.applyRequisition({ materialCode: 'NOPE', quantity: 1, receiver: '甲', purpose: '' }), /没有找到/)
  assert.throws(() => svc.confirmInbound({ id: getMaterial('MATE-0001').id, quantity: -3 }))
})

// 10. 种子数据的需采购耗材入库：清掉旧的需采购状态、解除预警并补发种子待发放单。
check('种子旧采购状态入库后正确清除', () => {
  const m = getMaterial('MATE-0003') // 库存 0、预警 50、有待发放单 20
  assert.equal(m.status, '需采购')
  const result = svc.confirmInbound({ id: m.id, quantity: 100, expectedVersion: m.version })
  // 0+100=100，补发 20 后 80 > 50 -> 充足，预警解除，需采购清除
  assert.equal(result.issued, 1)
  assert.equal(result.remaining, 0)
  const after = getMaterial('MATE-0003')
  assert.equal(after.当前数量, 80)
  assert.equal(after.status, '充足')
  assert.equal(svc.listAlerts(false).filter((a) => a.耗材编号 === 'MATE-0003').length, 0)
  assert.equal(
    requisitions().filter((r) => r.耗材编号 === 'MATE-0003' && r.status === '已发放').length,
    1,
  )
})

// 11. 停用耗材有待发放单或采购单时拒绝停用；无悬挂事项可停用并解除预警。
check('有悬挂事项不能停用，正常停用解除预警', () => {
  svc.applyRequisition({ materialCode: 'MATE-0002', quantity: 8, receiver: '甲', purpose: '停用测试' })
  const withWaiting = getMaterial('MATE-0002')
  assert.throws(() => svc.markDisabled(withWaiting.id), /待发放/)

  // MATE-0001 库存 30、线 10：先领用到线下产生提醒，再补回到线上不现实，
  // 直接用一个无待办但在预警线下的耗材验证停用解除提醒：再领用 25 到 5。
  svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 25, receiver: '乙', purpose: '停用测试' })
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 1)
  const low = getMaterial('MATE-0001')
  assert.equal(svc.markDisabled(low.id).ok, true)
  assert.equal(getMaterial('MATE-0001').status, '已停用')
  assert.equal(activeAlerts().filter((a) => a.耗材编号 === 'MATE-0001').length, 0, '停用解除预警')
  assert.throws(
    () => svc.applyRequisition({ materialCode: 'MATE-0001', quantity: 1, receiver: '丙', purpose: '' }),
    /已停用/,
  )
})

resetAll()
console.log(`\n全部通过：${passed} 个场景`)
