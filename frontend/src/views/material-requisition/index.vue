<template>
  <section class="page" data-module="material-requisition">
    <header class="page-head">
      <div>
        <h2>耗材领用</h2>
        <p class="page-desc">
          领用即出库并冻结当时库存口径；库存跌破预警线时这里只收到一份提醒，入库补货后待办自动核销。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="goMaterial">返回耗材管理</button>
      </div>
    </header>

    <h3 class="section-title">待办提醒</h3>
    <table class="data-table">
      <thead>
        <tr><th>类型</th><th>耗材编号</th><th>耗材名称</th><th>说明</th><th>产生时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.key">
          <td>
            <span class="badge" :class="todo.kind === '库存预警' ? 'badge-warn' : 'badge-backlog'">
              {{ todo.kind }}
            </span>
          </td>
          <td>{{ todo.materialCode }}</td>
          <td>{{ todo.materialName }}</td>
          <td>{{ todo.message }}</td>
          <td>{{ formatTime(todo.createdAt) }}</td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="5" class="empty-state">暂无待办：库存均在预警线之上，也没有待备货领用</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">发起领用</h3>
    <form class="filter-bar" @submit.prevent="submit">
      <label class="filter-item">
        <span>耗材</span>
        <select v-model="form.materialId">
          <option v-for="item in materials" :key="item.id" :value="item.id">
            {{ item.code }} · {{ item.name }}（库存 {{ item.stock }} / 预警 {{ item.threshold }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>领用数量</span>
        <input v-model.number="form.qty" type="number" min="1" />
      </label>
      <label class="filter-item">
        <span>领用人</span>
        <input v-model="form.applicant" placeholder="领用人" />
      </label>
      <button class="btn primary" type="submit">提交领用</button>
    </form>
    <p v-if="formHint" class="muted-text">{{ formHint }}</p>

    <h3 class="section-title">历史领用记录（保留当时数量口径）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>记录号</th><th>耗材编号</th><th>耗材名称</th><th>领用数量</th>
          <th>领用人</th><th>申请时间</th><th>状态</th>
          <th>申请时库存</th><th>申请时阈值</th><th>当前库存（仅对照）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="req in requisitions" :key="req.id">
          <td>#{{ req.id }}</td>
          <td>{{ req.materialCode }}</td>
          <td>{{ req.materialName }}</td>
          <td>{{ req.qty }}</td>
          <td>{{ req.applicant }}</td>
          <td>{{ formatTime(req.createdAt) }}</td>
          <td>
            {{ req.status }}
            <span v-if="req.fulfilledBy" class="muted-text">（入库单 #{{ req.fulfilledBy }} 已补齐）</span>
          </td>
          <td>{{ req.snapshotStock }}</td>
          <td>{{ req.snapshotThreshold }}</td>
          <td>{{ currentStockOf(req.materialId) }}</td>
        </tr>
        <tr v-if="!requisitions.length">
          <td colspan="10" class="empty-state">暂无领用记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>预警提醒按耗材编号去重：每次跌破预警线只产生一份，恢复后再次跌破才会重新提醒</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  createRequisition,
  listMaterials,
  listRequisitions,
  listRequisitionTodos,
} from '@/api/material-service'
import type { Material, Requisition, RequisitionTodo } from '@/api/material-service'

const router = useRouter()

const materials = ref<Material[]>([])
const requisitions = ref<Requisition[]>([])
const todos = ref<RequisitionTodo[]>([])
const errorMessage = ref('')
const okMessage = ref('')

const form = reactive<{ materialId: number | ''; qty: number; applicant: string }>({
  materialId: '',
  qty: 1,
  applicant: '',
})

const selected = computed(() => materials.value.find((item) => item.id === form.materialId) ?? null)

const formHint = computed(() => {
  if (!selected.value) {
    return ''
  }
  const target = selected.value
  if (target.stock < Number(form.qty)) {
    return `当前库存仅 ${target.stock} 件，提交后将生成「待备货」领用待办，入库补货时自动核销，不扣减库存。`
  }
  if (target.stock - Number(form.qty) <= target.threshold && target.stock > target.threshold) {
    return '本次领用将使库存跌破预警线，会生成一份库存预警提醒（同一轮只提醒一次）。'
  }
  return ''
})

function formatTime(value: string): string {
  return new Date(value).toLocaleString()
}

function currentStockOf(materialId: number): number {
  return materials.value.find((item) => item.id === materialId)?.stock ?? 0
}

function reload() {
  materials.value = listMaterials()
  requisitions.value = listRequisitions().slice().reverse()
  todos.value = listRequisitionTodos()
  if (form.materialId === '' && materials.value[0]) {
    form.materialId = materials.value[0].id
  }
}

function submit() {
  errorMessage.value = ''
  okMessage.value = ''
  if (!form.materialId) {
    errorMessage.value = '请选择耗材'
    return
  }
  const result = createRequisition({
    materialId: Number(form.materialId),
    qty: Number(form.qty),
    applicant: form.applicant,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value =
    result.value.status === '待备货'
      ? '库存不足，已登记为待备货领用，到货入库后自动核销'
      : '领用成功，库存已扣减'
  form.qty = 1
  reload()
}

function goMaterial() {
  router.push('/material')
}

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
.badge {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.badge-warn {
  background: #fef3c7;
  color: #92400e;
}
.badge-backlog {
  background: #fee4e2;
  color: #b42318;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #067647;
}
</style>
