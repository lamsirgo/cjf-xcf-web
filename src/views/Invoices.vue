<template>
  <div class="page">
    <van-nav-bar title="发票库" left-arrow @click-left="$router.back()" />
    <div class="filter-bar">
      <van-search v-model="keywords" placeholder="搜索发票号码/购买方/销售方" @search="onSearch" />
      <div class="filter-row">
        <van-dropdown-menu class="result-menu">
          <van-dropdown-item v-model="result" :options="resultOptions" @change="onSearch" />
        </van-dropdown-menu>
        <div class="date-filter" :class="{ active: showCalendar || hasDateFilter }" @click="openCalendar">
          <template v-if="hasDateFilter">
            <span class="date-filter__title date-filter__title--range">{{ rangeText }}</span>
            <van-icon
              name="cross"
              class="date-filter__clear"
              aria-label="清除日期筛选"
              @click.stop="clearDateFilter"
            />
          </template>
          <span v-else class="date-filter__title">选择日期</span>
        </div>
      </div>
    </div>

    <div class="list-wrap">
      <van-list
        v-model:loading="loading"
        v-model:error="loadError"
        :finished="finished"
        finished-text="没有更多了"
        error-text="加载失败，点击重试"
        @load="onLoad"
      >
        <div v-for="inv in list" :key="inv.id" class="inv-card" :class="{ dup: inv.duplicate }" @click="$router.push(`/app/invoice/${inv.id}`)">
          <div class="row1">
            <span class="no">{{ inv.invoice_num || '（无号码）' }}</span>
            <span class="amount">¥{{ inv.total_amount.toFixed(2) }}</span>
          </div>
          <div class="row2">{{ inv.seller_name || '—' }} → {{ inv.purchaser_name || '—' }}</div>
          <div class="row3">
            <span>{{ fmtDateTime(inv.invoice_date) }}</span>
            <van-tag v-if="inv.duplicate" type="danger" plain>{{ inv.dup_count > 1 ? `重复×${inv.dup_count}` : '重复' }}</van-tag>
            <van-tag :type="inv.result === '成功' ? 'success' : 'danger'">{{ inv.result }}</van-tag>
          </div>
        </div>
      </van-list>
    </div>

    <van-calendar
      ref="calendarRef"
      v-model:show="showCalendar"
      type="range"
      title="选择开票日期区间"
      :min-date="minDate"
      :max-date="maxDate"
      :poppable="true"
      teleport="body"
    >
      <template #footer>
        <div class="cal-footer van-safe-area-bottom">
          <van-button block @click="onCalendarCancel">取消</van-button>
          <van-button block type="primary" @click="onCalendarConfirm">确定</van-button>
        </div>
      </template>
    </van-calendar>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { showToast } from 'vant'
import { listInvoices, type InvoiceRow } from '@/api/invoices'

const keywords = ref('')
const result = ref('')
const resultOptions = [
  { text: '全部结果', value: '' },
  { text: '仅成功', value: 'success' },
  { text: '仅失败', value: 'failed' },
  { text: '仅重复', value: 'duplicate' },
]
const showCalendar = ref(false)
const calendarRef = ref<any>(null)
const minDate = new Date(2000, 0, 1)
const maxDate = new Date()
// null 表示未设置日期筛选（全量）
const startDate = ref<Date | null>(null)
const endDate = ref<Date | null>(null)

const list = ref<InvoiceRow[]>([])
const loading = ref(false)
const loadError = ref(false)
const finished = ref(false)
const page = ref(1)
// 防止搜索触发与 van-list 自动加载并发导致重复/翻页错位
let reqSeq = 0

const hasDateFilter = computed(() => !!(startDate.value && endDate.value))

/** 紧凑区间文案：同年 MM-DD~MM-DD，跨年显示完整年份 */
const rangeText = computed(() => {
  if (!startDate.value || !endDate.value) return ''
  const s = startDate.value
  const e = endDate.value
  const md = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (s.getFullYear() === e.getFullYear()) return `${md(s)}~${md(e)}`
  return `${fmtDay(s)}~${fmtDay(e)}`
})

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** 时分秒全为 0 时只显示 YYYY-MM-DD，否则显示到秒 */
function fmtDateTime(s: string) {
  if (!s) return '日期未知'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return day
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** YYYY-MM-DD */
function fmtDay(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function openCalendar() {
  showCalendar.value = true
}

// 每次打开日历时回显当前已生效的区间；未设置筛选时清空选择
watch(showCalendar, (visible) => {
  if (visible) {
    nextTick(() =>
      calendarRef.value?.reset(
        startDate.value && endDate.value ? [startDate.value, endDate.value] : []
      )
    )
  }
})

function onCalendarConfirm() {
  const dates = calendarRef.value?.getSelectedDate()
  if (!Array.isArray(dates) || dates.length < 2) {
    showToast('请选择完整的日期区间')
    return
  }
  startDate.value = dates[0]
  endDate.value = dates[1]
  showCalendar.value = false
  onSearch()
}

function onCalendarCancel() {
  showCalendar.value = false
  onSearch()
}

function clearDateFilter() {
  startDate.value = null
  endDate.value = null
  onSearch()
}

async function load() {
  const seq = ++reqSeq
  const currentPage = page.value
  try {
    const data = await listInvoices({
      page: currentPage,
      page_size: 20,
      keywords: keywords.value,
      result: result.value,
      date_start: startDate.value ? fmtDay(startDate.value) : '',
      date_end: endDate.value ? fmtDay(endDate.value) : '',
    })
    // 期间又触发了新的搜索/翻页请求，丢弃过期响应
    if (seq !== reqSeq) return
    if (currentPage === 1) list.value = data.list
    else list.value.push(...data.list)
    finished.value = list.value.length >= data.total
    page.value++
    loadError.value = false
  } catch {
    if (seq !== reqSeq) return
    loadError.value = true
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function onLoad() {
  load()
}

function onSearch() {
  page.value = 1
  finished.value = false
  loadError.value = false
  list.value = []
  loading.value = true
  load()
}
</script>

<style scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.filter-bar {
  flex-shrink: 0;
  background: #fff;
}
.filter-row {
  display: flex;
  height: var(--van-dropdown-menu-height, 48px);
  background: var(--van-dropdown-menu-background, #fff);
  box-shadow: var(--van-dropdown-menu-shadow, 0 2px 12px rgba(100, 101, 102, 0.12));
}
.result-menu {
  flex: 1;
}
.result-menu :deep(.van-dropdown-menu__bar) {
  box-shadow: none;
}
.date-filter {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-user-select: none;
  user-select: none;
}
.date-filter__title {
  position: relative;
  max-width: 100%;
  padding: 0 var(--van-padding-xs, 8px);
  color: var(--van-dropdown-menu-title-text-color, var(--van-text-color));
  font-size: var(--van-dropdown-menu-title-font-size, 15px);
  line-height: var(--van-dropdown-menu-title-line-height, var(--van-line-height-lg));
}
.date-filter__title::after {
  position: absolute;
  top: 50%;
  right: -4px;
  margin-top: -5px;
  border: 3px solid;
  border-color: transparent transparent var(--van-gray-4) var(--van-gray-4);
  transform: rotate(-45deg);
  opacity: 0.8;
  content: '';
}
.date-filter.active .date-filter__title {
  color: var(--van-dropdown-menu-title-active-text-color, var(--van-primary-color));
}
.date-filter.active .date-filter__title::after {
  margin-top: -1px;
  border-color: transparent transparent currentColor currentColor;
  transform: rotate(135deg);
}
.date-filter__title--range {
  padding-right: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.date-filter__title--range::after {
  display: none;
}
.date-filter__clear {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: var(--van-gray-6);
  padding: 4px;
}
.list-wrap {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.inv-card { background: #fff; border-radius: 8px; margin: 10px; padding: 12px; cursor: pointer; }
.inv-card.dup { border-left: 3px solid #ee0a24; }
.row1 { display: flex; justify-content: space-between; font-weight: 600; }
.amount { color: #ee0a24; }
.row2 { color: #646566; font-size: 13px; margin: 6px 0; }
.row3 { display: flex; align-items: center; gap: 8px; color: #969799; font-size: 12px; }
.cal-footer { display: flex; gap: 12px; padding: 10px 16px; }
</style>
