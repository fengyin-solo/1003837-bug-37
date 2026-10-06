<template>
  <section class="page" data-module="material">
    <header class="page-head">
      <div>
        <h2>耗材管理</h2>
        <p class="page-desc">维护发掘耗材库存与预警线；库存跨越预警线只提醒一次，确认入库在同一事务里回写库存、采购状态与领用清单。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/material/requisition">去领用 / 看待办</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出耗材清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="stats.activeAlerts > 0" class="alert-banner">
      有 {{ stats.activeAlerts }} 种耗材库存处于预警线以下，
      <RouterLink to="/material/requisition">前往领用页查看提醒</RouterLink>
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status !== '已停用' && !row.采购中 && row.status !== '充足'"
              class="link"
              type="button"
              @click="handleAction('发起采购', row)"
            >
              发起采购
            </button>
            <button
              v-if="row.采购中"
              class="link"
              type="button"
              @click="openInbound(row)"
            >
              确认入库
            </button>
            <button
              v-if="row.status !== '已停用'"
              class="link"
              type="button"
              @click="handleAction('标记停用', row)"
            >
              标记停用
            </button>
            <span v-if="availableActions(row).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无耗材数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="inboundTarget" class="modal-mask" @click.self="closeInbound">
      <div class="modal-card">
        <h3>确认入库：{{ inboundTarget.耗材名称 }}（{{ inboundTarget.耗材编号 }}）</h3>
        <p class="modal-line">当前库存 {{ inboundTarget.当前数量 }}，预警线 {{ inboundTarget.预警数量 }}。</p>
        <label class="filter-item">
          <span>入库数量（正整数）</span>
          <input v-model.number="inboundQuantity" type="number" min="1" step="1" />
        </label>
        <p v-if="inboundError" class="error-text">{{ inboundError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeInbound">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitInbound">
            确认入库
          </button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条耗材记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  BusinessError,
  confirmInbound,
  listMaterials,
  listRequisitions,
  markDisabled,
  materialStats,
  startPurchase,
} from '@/api/material-service'
import type { MaterialRow } from '@/data/types'

const columns = ['耗材编号', '耗材名称', '规格型号', '用途分类', '当前数量', '预警数量', '保管人', '待发放', '采购中']
const filterFields = ['耗材编号', '耗材名称', '规格型号']
const statuses = ['充足', '偏低', '需采购', '已停用']

const rows = ref<MaterialRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const stats = ref(materialStats())
const waitingRows = ref(listRequisitions({}).items)
const statCards = computed(() => [
  { label: '耗材种类', value: stats.value.kinds },
  { label: '需采购种类', value: stats.value.needPurchase },
  { label: '偏低种类', value: stats.value.low },
  { label: '待发放领用单', value: stats.value.waitingRequisitions },
])

const waitingCountByCode = computed(() => {
  const map = new Map<string, number>()
  for (const row of waitingRows.value) {
    if (row.status === '待发放') {
      map.set(String(row.耗材编号), (map.get(String(row.耗材编号)) ?? 0) + 1)
    }
  }
  return map
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatCell(row: MaterialRow, column: string): string | number {
  if (column === '待发放') {
    return waitingCountByCode.value.get(String(row.耗材编号)) ?? 0
  }
  if (column === '采购中') {
    return row.采购中 ? '是' : '否'
  }
  const value = row[column]
  if (typeof value === 'boolean') {
    return value ? '是' : '否'
  }
  return value === '' || value === undefined || value === null ? '—' : value
}

function availableActions(row: MaterialRow): string[] {
  if (row.status === '已停用') {
    return []
  }
  const actions = []
  if (row.采购中) {
    actions.push('确认入库')
  } else if (row.status !== '充足') {
    actions.push('发起采购')
  }
  actions.push('标记停用')
  return actions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('material')
}

function handleAction(action: '发起采购' | '标记停用', row: MaterialRow) {
  errorMessage.value = ''
  try {
    const result = action === '发起采购' ? startPurchase(Number(row.id)) : markDisabled(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
  } catch (error) {
    errorMessage.value = error instanceof BusinessError ? error.message : '操作失败'
  }
}

const inboundTarget = ref<MaterialRow | null>(null)
const inboundQuantity = ref<number>(1)
const inboundError = ref('')
const submitting = ref(false)

function openInbound(row: MaterialRow) {
  inboundTarget.value = row
  inboundQuantity.value = 1
  inboundError.value = ''
}

function closeInbound() {
  inboundTarget.value = null
  inboundError.value = ''
}

function submitInbound() {
  if (!inboundTarget.value) {
    return
  }
  inboundError.value = ''
  submitting.value = true
  try {
    // 带上读到的版本号：另一终端先确认成功时，这里会被明确拒绝，库存不会再扣一次。
    const result = confirmInbound({
      id: Number(inboundTarget.value.id),
      quantity: Number(inboundQuantity.value),
      expectedVersion: Number(inboundTarget.value.version ?? 0),
    })
    closeInbound()
    reload()
    errorMessage.value = result.ok ? '' : result.message
  } catch (error) {
    inboundError.value = error instanceof BusinessError ? error.message : '确认入库失败，已整体退回'
  } finally {
    submitting.value = false
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listMaterials(filters.value)
    waitingRows.value = listRequisitions({}).items
    rows.value = payload.items
    total.value = payload.total
    stats.value = materialStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '耗材列表读取失败'
  }
}

onMounted(reload)
</script>
