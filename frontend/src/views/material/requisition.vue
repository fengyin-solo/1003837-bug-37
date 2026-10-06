<template>
  <section class="page" data-module="material-requisition">
    <header class="page-head">
      <div>
        <h2>发掘耗材领用</h2>
        <p class="page-desc">
          提交领用即时扣减库存并按当时口径留存记录；库存不足时进入待发放待办，采购入库后自动补发。
          同一耗材编号跨越预警线只收到一份提醒，入库恢复后自动解除。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/material">返回耗材管理</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">预警中耗材</span>
        <strong class="stat-value">{{ alerts.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待发放领用单</span>
        <strong class="stat-value">{{ waitingRows.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">历史领用记录</span>
        <strong class="stat-value">{{ issuedRows.length }}</strong>
      </article>
    </div>

    <form class="filter-bar requisition-form" @submit.prevent="submitForm">
      <label class="filter-item">
        <span>耗材编号</span>
        <select v-model="form.materialCode">
          <option value="" disabled>请选择耗材</option>
          <option v-for="option in options" :key="option.code" :value="option.code">
            {{ option.code }} · {{ option.name }}
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>领用数量</span>
        <input v-model.number="form.quantity" type="number" min="1" step="1" />
      </label>
      <label class="filter-item">
        <span>领用人</span>
        <input v-model="form.receiver" placeholder="领用人姓名" />
      </label>
      <label class="filter-item filter-grow">
        <span>用途</span>
        <input v-model="form.purpose" placeholder="如：T0203 发掘、浮选采样分装" />
      </label>
      <button class="btn primary" type="submit">提交领用</button>
    </form>

    <p v-if="formMessage" :class="formOk ? 'ok-text' : 'error-text'">{{ formMessage }}</p>

    <h3 class="section-title">预警提醒</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>提醒编号</th>
          <th>耗材编号</th>
          <th>耗材名称</th>
          <th>预警数量</th>
          <th>触发时库存</th>
          <th>触发时间</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in alerts" :key="String(row.id)">
          <td>{{ row.提醒编号 }}</td>
          <td>{{ row.耗材编号 }}</td>
          <td>{{ row.耗材名称 }}</td>
          <td>{{ row.预警数量 }}</td>
          <td>{{ row.触发时库存 }}</td>
          <td>{{ row.触发时间 }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!alerts.length">
          <td colspan="7" class="empty-state">暂无预警中耗材</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">待发放领用单</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>领用单号</th>
          <th>耗材编号</th>
          <th>耗材名称</th>
          <th>领用数量</th>
          <th>领用人</th>
          <th>用途</th>
          <th>申请时间</th>
          <th>申请时库存</th>
          <th>申请时预警线</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in waitingRows" :key="String(row.id)">
          <td>{{ row.领用单号 }}</td>
          <td>{{ row.耗材编号 }}</td>
          <td>{{ row.耗材名称 }}</td>
          <td>{{ row.领用数量 }}</td>
          <td>{{ row.领用人 }}</td>
          <td>{{ row.用途 || '—' }}</td>
          <td>{{ row.申请时间 }}</td>
          <td>{{ row.申请时库存 }}</td>
          <td>{{ row.申请时预警线 }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!waitingRows.length">
          <td colspan="10" class="empty-state">没有待发放领用单</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">历史领用记录（保留申请时数量口径）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>领用单号</th>
          <th>耗材编号</th>
          <th>耗材名称</th>
          <th>领用数量</th>
          <th>领用人</th>
          <th>用途</th>
          <th>申请时间</th>
          <th>申请时库存</th>
          <th>申请时预警线</th>
          <th>发放时间</th>
          <th>发放后库存</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in issuedRows" :key="String(row.id)">
          <td>{{ row.领用单号 }}</td>
          <td>{{ row.耗材编号 }}</td>
          <td>{{ row.耗材名称 }}</td>
          <td>{{ row.领用数量 }}</td>
          <td>{{ row.领用人 }}</td>
          <td>{{ row.用途 || '—' }}</td>
          <td>{{ row.申请时间 }}</td>
          <td>{{ row.申请时库存 }}</td>
          <td>{{ row.申请时预警线 }}</td>
          <td>{{ row.发放时间 || '—' }}</td>
          <td>{{ row.发放后库存 === '' ? '—' : row.发放后库存 }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!issuedRows.length">
          <td colspan="12" class="empty-state">暂无历史领用记录</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  applyRequisition,
  BusinessError,
  listAlerts,
  listRequisitions,
  materialOptions,
  type MaterialAlertRow,
  type RequisitionRow,
} from '@/api/material-service'

const form = reactive({
  materialCode: '',
  quantity: 1,
  receiver: '',
  purpose: '',
})
const formMessage = ref('')
const formOk = ref(false)
const options = ref<{ id: number; code: string; name: string }[]>([])
const requisitionRows = ref<RequisitionRow[]>([])
const alerts = ref<MaterialAlertRow[]>([])

const waitingRows = computed(() =>
  requisitionRows.value.filter((row) => row.status === '待发放'),
)
const issuedRows = computed(() =>
  requisitionRows.value.filter((row) => row.status === '已发放'),
)

function reload() {
  options.value = materialOptions()
  requisitionRows.value = listRequisitions({}).items
  alerts.value = listAlerts(false)
}

function submitForm() {
  formMessage.value = ''
  formOk.value = false
  try {
    const result = applyRequisition({
      materialCode: form.materialCode,
      quantity: Number(form.quantity),
      receiver: form.receiver,
      purpose: form.purpose,
    })
    reload()
    formOk.value = true
    if (!result.issued) {
      formMessage.value = '库存不足，领用单已进入待发放待办，采购入库后自动补发'
    } else if (result.alertRaised) {
      formMessage.value = '领用已发放，库存已降至预警线以下，已生成一份预警提醒'
    } else {
      formMessage.value = '领用成功，库存已扣减'
    }
    form.quantity = 1
    form.purpose = ''
  } catch (error) {
    formMessage.value = error instanceof BusinessError ? error.message : '领用提交失败'
  }
}

onMounted(reload)
</script>
