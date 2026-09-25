<template>
  <div class="page">
    <van-nav-bar title="发票详情" left-arrow @click-left="$router.back()" />
    <van-loading v-if="loading" class="center" />
    <template v-else-if="inv">
      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="发票号码" :value="inv.invoice_num || '—'" />
        <van-cell title="发票代码" :value="inv.invoice_code || '—'" />
        <van-cell title="发票类型" :value="inv.invoice_type || '—'" />
        <van-cell title="开票日期" :value="fmtDateTime(inv.invoice_date)" />
        <van-cell title="价税合计" :value="`¥${Number(inv.total_amount ?? 0).toFixed(2)}`" value-class="amount" />
      </van-cell-group>
      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="购买方" :label="inv.purchaser_name || '—'" />
        <van-cell title="购买方税号" :value="inv.purchaser_register_num || '—'" />
        <van-cell title="销售方" :label="inv.seller_name || '—'" />
        <van-cell title="销售方税号" :value="inv.seller_register_num || '—'" />
      </van-cell-group>
      <div class="section">货物明细</div>
      <div v-for="(item, i) in inv.items || []" :key="i" class="item-card">
        <div class="i-name">{{ item.commodity_name || '—' }}</div>
        <div class="i-grid">
          <span>规格: {{ item.commodity_type || '—' }}</span>
          <span>单位: {{ item.commodity_unit || '—' }}</span>
          <span>数量: {{ item.commodity_num || '—' }}</span>
          <span>单价: {{ item.commodity_price || '—' }}</span>
          <span>金额: {{ item.commodity_amount || '—' }}</span>
          <span>税率: {{ item.commodity_tax_rate || '—' }}</span>
        </div>
      </div>
      <div v-if="inv.fail_reason" class="fail-reason">解析失败原因：{{ inv.fail_reason }}</div>
      <div class="del-wrap">
        <van-button plain type="danger" block @click="onDelete">删除该发票</van-button>
      </div>
    </template>
    <div v-else class="error-block">
      <p>{{ loadError || '发票不存在或已被删除' }}</p>
      <van-button size="small" type="primary" @click="$router.back()">返回</van-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { deleteInvoices, getInvoice } from '@/api/invoices'

const route = useRoute()
const router = useRouter()
const inv = ref<any>(null)
const loading = ref(true)
const loadError = ref('')

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function fmtDateTime(s: string) {
  if (!s) return '—'
  // 纯日期按本地时区解析，避免 UTC 零点在东八区显示成前一天
  const local = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return s
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return day
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function onDelete() {
  if (!inv.value) return
  try {
    await showConfirmDialog({
      title: '删除发票',
      message: '确定删除该发票吗？删除后不可恢复。',
      confirmButtonText: '删除',
      confirmButtonColor: '#ee0a24',
    })
  } catch {
    return
  }
  try {
    await deleteInvoices([inv.value.id])
    showToast('已删除')
    router.replace('/app/invoices')
  } catch {
    /* 拦截器已提示 */
  }
}

onMounted(async () => {
  try {
    inv.value = await getInvoice(Number(route.params.id))
  } catch {
    // 404/无权限/网络错误：进入明确的错误态，而不是永久转圈
    loadError.value = '发票加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.center { display: flex; justify-content: center; padding-top: 120px; }
.amount { color: #ee0a24; }
.section { margin: 16px 16px 0; font-weight: 600; }
.item-card { background: var(--van-background-2, #fff); border-radius: 8px; margin: 10px 16px; padding: 12px; }
.i-name { font-weight: 500; margin-bottom: 6px; }
.i-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; color: var(--van-text-color-2, #646566); font-size: 13px; }
.fail-reason { margin: 12px 16px 0; color: #ee0a24; font-size: 13px; }
.del-wrap { margin: 20px 16px; }
.error-block { display: flex; flex-direction: column; align-items: center; gap: 12px; padding-top: 120px; color: var(--van-text-color-3, #969799); }
</style>
