<template>
  <div class="page">
    <van-nav-bar title="发票详情" left-arrow @click-left="$router.back()" />
    <van-loading v-if="!inv" class="center" />
    <template v-else>
      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="发票号码" :value="inv.invoice_num" />
        <van-cell title="发票代码" :value="inv.invoice_code || '—'" />
        <van-cell title="发票类型" :value="inv.invoice_type || '—'" />
        <van-cell title="开票日期" :value="fmtDateTime(inv.invoice_date)" />
        <van-cell title="价税合计" :value="`¥${inv.total_amount.toFixed(2)}`" value-class="amount" />
      </van-cell-group>
      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="购买方" :label="inv.purchaser_name || '—'" />
        <van-cell title="购买方税号" :value="inv.purchaser_register_num || '—'" />
        <van-cell title="销售方" :label="inv.seller_name || '—'" />
        <van-cell title="销售方税号" :value="inv.seller_register_num || '—'" />
      </van-cell-group>
      <div class="section">货物明细</div>
      <div v-for="(item, i) in inv.items" :key="i" class="item-card">
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
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getInvoice } from '@/api/invoices'

const route = useRoute()
const inv = ref<any>(null)

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function fmtDateTime(s: string) {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return day
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

onMounted(async () => {
  inv.value = await getInvoice(Number(route.params.id))
})
</script>

<style scoped>
.amount { color: #ee0a24; }
.section { margin: 16px 16px 0; font-weight: 600; }
.item-card { background: #fff; border-radius: 8px; margin: 10px 16px; padding: 12px; }
.i-name { font-weight: 500; margin-bottom: 6px; }
.i-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; color: #646566; font-size: 13px; }
</style>
