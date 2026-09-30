<template>
  <div class="manual-panel">
    <!-- 列表态 -->
    <template v-if="!editing">
      <div class="mp-head">人工补录 · {{ items.length }} 张待处理</div>
      <div class="mp-tip">对未识别 / 部分识别的票据手工补录，补录结果参与去重与金额统计。</div>

      <div v-if="items.length === 0" class="mp-empty">暂无待补录票据</div>

      <div
        v-for="item in items"
        :key="item.meta.pageId"
        class="mp-item"
        @click="startEdit(item.meta.pageId)"
      >
        <img :src="item.page.thumbUrl" class="mp-thumb" alt="" />
        <div class="mp-meta">
          <div class="mp-name">{{ item.meta.invoiceNo || item.fileName }}</div>
          <div class="mp-sub">
            <van-tag plain :type="item.meta.status === 'partial' ? 'warning' : 'default'">
              {{ item.meta.status === 'partial' ? '部分识别' : '未识别' }}
            </van-tag>
            <span v-if="item.meta.amount !== null">¥{{ fmt(item.meta.amount ?? 0) }}</span>
          </div>
        </div>
        <van-button size="small" type="primary" plain>补录</van-button>
      </div>
    </template>

    <!-- 表单态 -->
    <template v-else>
      <div class="mp-form-head">
        <van-icon name="arrow-left" @click="editing = null" />
        <span>人工补录</span>
      </div>

      <img :src="thumbOf(editing)" class="mp-form-thumb" alt="" />

      <van-cell-group inset>
        <van-field
          v-model="form.invoiceNo"
          label="发票号码"
          placeholder="8 位老号码或 20 位数电票号码"
          type="digit"
        />
        <van-field
          v-model="form.invoiceCode"
          label="发票代码"
          placeholder="选填，10/12 位"
          type="digit"
        />
        <van-field
          v-model="form.amount"
          label="金额（元）"
          placeholder="选填"
          type="number"
        />
        <van-field
          v-model="form.issueDate"
          label="开票日期"
          placeholder="选填，点击选择"
          readonly
          is-link
          @click="openDatePicker"
        />
      </van-cell-group>

      <div class="mp-save">
        <van-button type="primary" block round @click="onSave">保存补录</van-button>
      </div>
    </template>

    <!-- 日期选择 -->
    <van-popup v-model:show="showDatePicker" position="bottom">
      <van-date-picker
        v-model="datePickerVal"
        :min-date="minDate"
        :max-date="maxDate"
        @confirm="onDateConfirm"
        @cancel="showDatePicker = false"
      />
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { showFailToast } from 'vant'
import { fmtMoney, type ResolvedPage } from '@/composables/print/useInvoiceStats'
import type { ManualInput } from '@/composables/print/useQrScan'
import type { InvoiceMeta, TicketPage } from '@/lib/print/types'

export interface ManualItem {
  meta: InvoiceMeta
  page: TicketPage
  fileName: string
}

const props = defineProps<{
  items: ManualItem[]
  /** 指定直接编辑的票据 pageId（从重复详情跳转） */
  activeId: string | null
  metaOf: (pageId: string) => InvoiceMeta | undefined
  resolvePage: (pageId: string) => ResolvedPage | null
}>()

const emit = defineEmits<{
  (e: 'save', pageId: string, input: ManualInput): void
}>()

const editing = ref<string | null>(null)
const showDatePicker = ref(false)
const datePickerVal = ref<string[]>([])

const minDate = new Date(2020, 0, 1)
const maxDate = new Date()

const form = reactive({
  invoiceNo: '',
  invoiceCode: '',
  amount: '',
  issueDate: '',
})

watch(
  () => props.activeId,
  (id) => {
    if (id) startEdit(id)
  },
  { immediate: true },
)

function startEdit(pid: string) {
  const m = props.metaOf(pid)
  form.invoiceNo = m?.invoiceNo ?? ''
  form.invoiceCode = m?.invoiceCode ?? ''
  form.amount = m?.amount !== null && m?.amount !== undefined ? String(m.amount) : ''
  form.issueDate = m?.issueDate ?? ''
  editing.value = pid
}

function thumbOf(pid: string) {
  return props.resolvePage(pid)?.page.thumbUrl || ''
}

function openDatePicker() {
  datePickerVal.value = form.issueDate
    ? form.issueDate.split('-')
    : [String(maxDate.getFullYear()), String(maxDate.getMonth() + 1), String(maxDate.getDate())]
  showDatePicker.value = true
}

function onDateConfirm({ selectedValues }: { selectedValues: string[] }) {
  form.issueDate = selectedValues.join('-')
  showDatePicker.value = false
}

function onSave() {
  const trimmedNo = form.invoiceNo.trim()
  if (trimmedNo && !/^(\d{8}|\d{20})$/.test(trimmedNo)) {
    showFailToast('发票号码应为 8 位或 20 位数字')
    return
  }
  const amountRaw = form.amount.trim()
  const amountVal = amountRaw ? Number(amountRaw) : null
  if (amountVal !== null && (!Number.isFinite(amountVal) || amountVal <= 0 || amountVal > 1e8)) {
    showFailToast('金额需为 0 ~ 1 亿之间的正数')
    return
  }
  if (!trimmedNo && !form.invoiceCode.trim() && amountVal === null && !form.issueDate) {
    showFailToast('请至少补录一项内容')
    return
  }

  emit('save', editing.value as string, {
    invoiceNo: trimmedNo,
    invoiceCode: form.invoiceCode.trim() || null,
    amount: amountVal,
    issueDate: form.issueDate || null,
  })
  editing.value = null
}

function fmt(n: number) {
  return fmtMoney(n)
}
</script>

<style scoped>
.manual-panel {
  padding: 14px;
}
.mp-head {
  font-size: 15px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.mp-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.mp-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
}
.mp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.mp-thumb {
  width: 46px;
  height: 62px;
  object-fit: contain;
  border: 1px solid var(--van-border-color, #ebedf0);
  border-radius: 4px;
  background: #fff;
  flex-shrink: 0;
}
.mp-meta {
  flex: 1;
  min-width: 0;
}
.mp-name {
  font-size: 13px;
  color: var(--van-text-color, #323233);
  word-break: break-all;
}
.mp-sub {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}

.mp-form-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.mp-form-thumb {
  display: block;
  width: 90px;
  height: 120px;
  margin: 14px auto;
  object-fit: contain;
  border: 1px solid var(--van-border-color, #ebedf0);
  border-radius: 6px;
  background: #fff;
}
.mp-save {
  margin-top: 18px;
  padding: 0 16px;
}
</style>
