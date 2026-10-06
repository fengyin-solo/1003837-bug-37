<template>
  <section class="page" data-module="material">
    <header class="page-head">
      <div>
        <h2>耗材管理</h2>
        <p class="page-desc">围绕耗材编号、当前库存与预警阈值做登记、领用、采购与入库；库存、预警、采购状态同一口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="goRequisition">前往耗材领用</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>耗材编号/名称</span>
        <input v-model="keyword" placeholder="按编号或名称检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row.code }}</td>
          <td>{{ row.name }}</td>
          <td>{{ row.spec }}</td>
          <td>{{ row.category }}</td>
          <td :class="{ 'stock-low': row.stock <= row.threshold }">{{ row.stock }}</td>
          <td>{{ row.threshold }}</td>
          <td>{{ row.keeper }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openRequisition(row)">领用</button>
            <button class="link" type="button" @click="openPurchase(row)">发起采购</button>
            <button class="link" type="button" @click="quickAdjust(row)">盘点调整</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无耗材数据</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">采购单</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>单号</th><th>耗材编号</th><th>耗材名称</th><th>采购数量</th>
          <th>采购人</th><th>发起时间</th><th>状态</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="order in purchases" :key="order.id">
          <td>#{{ order.id }}</td>
          <td>{{ order.materialCode }}</td>
          <td>{{ order.materialName }}</td>
          <td>{{ order.qty }}</td>
          <td>{{ order.applicant }}</td>
          <td>{{ formatTime(order.createdAt) }}</td>
          <td>{{ order.status }}</td>
          <td class="row-actions">
            <button v-if="order.status === '待入库'" class="link" type="button" @click="doInbound(order)">
              确认入库
            </button>
            <button v-if="order.status === '待入库'" class="link" type="button" @click="doCancel(order)">
              取消
            </button>
            <span v-else class="muted-text">
              {{ order.inboundTerminal ? `终端 ${order.inboundTerminal} 确认` : '' }}
            </span>
          </td>
        </tr>
        <tr v-if="!purchases.length">
          <td colspan="8" class="empty-state">暂无采购单</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">库存流水</h3>
    <table class="data-table">
      <thead>
        <tr><th>时间</th><th>耗材编号</th><th>变动</th><th>结余</th><th>原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="move in movements" :key="move.id">
          <td>{{ formatTime(move.createdAt) }}</td>
          <td>{{ move.materialCode }}</td>
          <td :class="move.change < 0 ? 'stock-low' : 'stock-ok'">
            {{ move.change > 0 ? `+${move.change}` : move.change }}
          </td>
          <td>{{ move.balance }}</td>
          <td>{{ move.reason }}</td>
        </tr>
        <tr v-if="!movements.length">
          <td colspan="5" class="empty-state">暂无库存流水</td>
        </tr>
      </tbody>
    </table>

    <div v-if="dialog.mode" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>{{ dialog.title }}</h3>
        <p class="muted-text">{{ dialog.material?.code }} · {{ dialog.material?.name }}（当前库存 {{ dialog.material?.stock }} / 预警 {{ dialog.material?.threshold }}）</p>
        <label class="filter-item">
          <span>{{ dialog.mode === 'requisition' ? '领用数量' : '采购数量' }}</span>
          <input v-model.number="dialog.qty" type="number" min="1" />
        </label>
        <label class="filter-item">
          <span>{{ dialog.mode === 'requisition' ? '领用人' : '采购人' }}</span>
          <input v-model="dialog.operator" :placeholder="dialog.mode === 'requisition' ? '领用人' : '采购人'" />
        </label>
        <p v-if="dialog.tip" class="muted-text">{{ dialog.tip }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitDialog">确定</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 种耗材 · 库存以本页与领用页共享的台账为准</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  adjustStock,
  cancelPurchase,
  confirmInbound,
  createPurchase,
  createRequisition,
  listMaterials,
  listMovements,
  listPurchases,
  materialSummary,
} from '@/api/material-service'
import type { Material, PurchaseOrder } from '@/data/material-types'

const router = useRouter()
const columns = ['耗材编号', '耗材名称', '规格型号', '用途分类', '当前数量', '预警数量', '保管人', '耗材状态']
const statuses = ['充足', '偏低', '需采购', '已停用']

const rows = ref<Material[]>([])
const purchases = ref<PurchaseOrder[]>([])
const movements = ref<ReturnType<typeof listMovements>>([])
const keyword = ref('')
const errorMessage = ref('')
const okMessage = ref('')

const dialog = ref<{
  mode: '' | 'requisition' | 'purchase'
  title: string
  material: Material | null
  qty: number | null
  operator: string
  tip: string
}>({ mode: '', title: '', material: null, qty: null, operator: '', tip: '' })

const statsCards = computed(() => {
  const summary = materialSummary()
  return [
    { label: '耗材种类', value: summary.total },
    { label: '需采购种类', value: summary.needPurchase },
    { label: '偏低种类', value: summary.low },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function formatTime(value: string): string {
  return new Date(value).toLocaleString()
}

function flash(message: string, ok = false) {
  errorMessage.value = ok ? '' : message
  okMessage.value = ok ? message : ''
}

function resetFilters() {
  keyword.value = ''
  reload()
}

function reload() {
  const kw = keyword.value.trim()
  const all = listMaterials()
  rows.value = kw
    ? all.filter((row) => row.code.includes(kw) || row.name.includes(kw))
    : all
  purchases.value = listPurchases().sort((a, b) => b.id - a.id)
  movements.value = listMovements().slice().reverse().slice(0, 20)
}

function goRequisition() {
  router.push('/material-requisition')
}

function openRequisition(material: Material) {
  dialog.value = {
    mode: 'requisition',
    title: '领用耗材',
    material,
    qty: 1,
    operator: '',
    tip: material.stock <= material.threshold ? '该耗材已在预警线以下，领用后请关注采购进度' : '',
  }
}

function openPurchase(material: Material) {
  dialog.value = {
    mode: 'purchase',
    title: '发起采购',
    material,
    qty: Math.max(material.threshold - material.stock + 1, 1),
    operator: '',
    tip: '发起采购后状态转为「需采购」，本轮库存预警关闭，领用页不再重复提醒',
  }
}

function quickAdjust(material: Material) {
  const input = window.prompt(
    `对「${material.name}」做盘点调整，输入整数（正为盘盈，负为盘亏），当前库存 ${material.stock}`,
    '0',
  )
  if (input === null) {
    return
  }
  const delta = Number(input)
  if (!Number.isInteger(delta) || delta === 0) {
    flash('调整数量必须是非零整数')
    return
  }
  const result = adjustStock(material.id, delta)
  finish(result, result.ok ? '盘点调整已提交' : '')
}

function submitDialog() {
  const target = dialog.value.material
  if (!target || !dialog.value.mode) {
    return
  }
  const qty = Number(dialog.value.qty)
  if (!Number.isInteger(qty) || qty <= 0) {
    flash('数量必须是正整数')
    return
  }
  if (!dialog.value.operator.trim()) {
    flash(dialog.value.mode === 'requisition' ? '请填写领用人' : '请填写采购人')
    return
  }
  const mode = dialog.value.mode
  const result =
    mode === 'requisition'
      ? createRequisition({ materialId: target.id, qty, applicant: dialog.value.operator })
      : createPurchase({ materialId: target.id, qty, applicant: dialog.value.operator })
  closeDialog()
  finish(result, result.ok ? (mode === 'requisition' ? '领用已提交' : '采购单已发起') : '')
}

function doInbound(order: PurchaseOrder) {
  const result = confirmInbound(order.id)
  finish(result, result.ok ? `采购单 #${order.id} 已确认入库，库存、采购状态与领用清单已同步回写` : '')
}

function doCancel(order: PurchaseOrder) {
  const result = cancelPurchase(order.id)
  finish(result, result.ok ? `采购单 #${order.id} 已取消` : '')
}

function finish(result: { ok: boolean; message?: string }, okText: string) {
  reload()
  if (!result.ok) {
    flash(result.message ?? '操作失败')
    return
  }
  flash(okText, true)
}

function closeDialog() {
  dialog.value = { mode: '', title: '', material: null, qty: null, operator: '', tip: '' }
}

/** 另一标签页确认入库后，本页列表自动对齐，避免展示旧的需采购/库存数。 */
function onStorage(event: StorageEvent) {
  if (event.key?.includes('material-domain')) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.section-title {
  margin: 20px 0 8px;
  font-size: 15px;
}
.stock-low {
  color: #b42318;
  font-weight: 600;
}
.stock-ok {
  color: #067647;
}
.ok-text {
  color: #067647;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 360px;
}
.modal h3 {
  margin: 0 0 6px;
}
.modal .filter-item {
  margin: 10px 0;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
