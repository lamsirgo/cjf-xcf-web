<template>
  <div class="page">
    <van-nav-bar title="发票库" left-arrow @click-left="$router.back()">
      <template #right>
        <span class="nav-action" @click="openExport">导出</span>
        <span class="manage-entry" @click="toggleManage">{{ manageMode ? '完成' : '管理' }}</span>
      </template>
    </van-nav-bar>
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

    <div class="list-wrap" :class="{ 'with-bar': manageMode }">
      <!-- 空状态：加载完成且无数据（区分“无发票”与“筛选无结果”） -->
      <van-empty v-if="finished && list.length === 0" :description="emptyText" />
      <van-list
        v-else
        v-model:loading="loading"
        v-model:error="loadError"
        :finished="finished"
        finished-text="没有更多了"
        error-text="加载失败，点击重试"
        @load="onLoad"
      >
        <div
          v-for="inv in list"
          :key="inv.id"
          class="inv-card"
          :class="{ dup: inv.duplicate, selected: manageMode && selectedIds.has(inv.id) }"
          @click="onCardClick(inv)"
        >
          <van-icon
            v-if="manageMode"
            :name="selectedIds.has(inv.id) ? 'success' : 'circle'"
            class="check-icon"
            :class="{ active: selectedIds.has(inv.id) }"
          />
          <div class="row1">
            <span class="no">{{ inv.invoice_num || '（无号码）' }}</span>
            <span class="amount">¥{{ Number(inv.total_amount ?? 0).toFixed(2) }}</span>
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

    <!-- 批量管理底栏：软删除发票 -->
    <div v-if="manageMode" class="manage-bar van-safe-area-bottom">
      <van-button size="small" plain @click="toggleSelectAll">
        {{ allSelected ? '取消全选' : '全选' }}
      </van-button>
      <van-button
        size="small"
        type="danger"
        :disabled="selectedIds.size === 0"
        @click="onBatchDelete"
      >
        删除{{ selectedIds.size ? `（${selectedIds.size}）` : '' }}
      </van-button>
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

    <!-- 导出：按当前筛选条件 + 字段选择 -->
    <van-popup v-model:show="showExport" round position="bottom">
      <div class="export-pop">
        <div class="export-title">导出发票</div>
        <p class="export-scope">导出范围：{{ exportScopeText }}</p>
        <div class="export-sub">选择导出字段</div>
        <van-checkbox-group v-model="exportFields">
          <van-cell-group :border="false">
            <van-cell
              v-for="f in EXPORT_FIELD_OPTIONS"
              :key="f.key"
              :title="f.label"
              clickable
              @click="toggleField(f.key)"
            >
              <template #right-icon>
                <van-checkbox :name="f.key" @click.stop />
              </template>
            </van-cell>
          </van-cell-group>
        </van-checkbox-group>
        <div class="export-foot van-safe-area-bottom">
          <van-button block @click="showExport = false">取消</van-button>
          <van-button block type="primary" :loading="exporting" @click="onConfirmExport">创建导出</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { deleteInvoices, listInvoices, createExport, type InvoiceRow } from '@/api/invoices'

const router = useRouter()

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

const emptyText = computed(() =>
  keywords.value || result.value || hasDateFilter.value ? '没有符合条件的发票' : '暂无发票，去上传解析吧'
)

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
  // 后端 date 类型序列化为纯日期 "YYYY-MM-DD"：直接 new Date 会按 UTC 零点解析，
  // 东八区显示成前一天。纯日期补本地 00:00:00 按本地时区解析
  const local = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s
  const d = new Date(local)
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
  selectedIds.value = new Set()
  loading.value = true
  load()
}

// ---------- 导出（按当前筛选 + 字段选择） ----------
const showExport = ref(false)
const exporting = ref(false)
const EXPORT_FIELD_OPTIONS = [
  { key: 'invoice_code', label: '发票代码' },
  { key: 'invoice_num', label: '发票号码' },
  { key: 'invoice_type', label: '发票类型' },
  { key: 'invoice_date', label: '开票日期' },
  { key: 'purchaser_name', label: '购买方' },
  { key: 'purchaser_register_num', label: '购买方税号' },
  { key: 'seller_name', label: '销售方' },
  { key: 'seller_register_num', label: '销售方税号' },
  { key: 'total_amount', label: '价税合计' },
  { key: 'status', label: '解析状态' },
  { key: 'fail_reason', label: '失败原因' },
  { key: 'items', label: '货物明细' },
]
const exportFields = ref<string[]>(EXPORT_FIELD_OPTIONS.map((f) => f.key))

const exportScopeText = computed(() => {
  const parts: string[] = []
  if (keywords.value) parts.push(`关键词“${keywords.value}”`)
  if (result.value) parts.push(resultOptions.find((o) => o.value === result.value)?.text || '')
  if (hasDateFilter.value) parts.push(`开票日期 ${fmtDay(startDate.value!)}~${fmtDay(endDate.value!)}`)
  return parts.length ? parts.join('，') : '全部发票'
})

function openExport() {
  exportFields.value = EXPORT_FIELD_OPTIONS.map((f) => f.key)
  showExport.value = true
}

function toggleField(key: string) {
  const i = exportFields.value.indexOf(key)
  if (i >= 0) exportFields.value.splice(i, 1)
  else exportFields.value.push(key)
}

async function onConfirmExport() {
  if (!exportFields.value.length) {
    showToast('请至少选择一个导出字段')
    return
  }
  exporting.value = true
  try {
    await createExport({
      keywords: keywords.value,
      date_start: startDate.value ? fmtDay(startDate.value) : '',
      date_end: endDate.value ? fmtDay(endDate.value) : '',
      result: result.value,
      fields: exportFields.value,
    })
    showToast('导出任务已创建，完成后可在消息中下载')
    showExport.value = false
  } catch {
    /* 拦截器已提示 */
  } finally {
    exporting.value = false
  }
}

// ---------- 批量管理（软删除）----------
const manageMode = ref(false)
const selectedIds = ref<Set<number>>(new Set())
const allSelected = computed(() => list.value.length > 0 && list.value.every((inv) => selectedIds.value.has(inv.id)))

function toggleManage() {
  manageMode.value = !manageMode.value
  selectedIds.value = new Set()
}

function onCardClick(inv: InvoiceRow) {
  if (manageMode.value) {
    const next = new Set(selectedIds.value)
    if (next.has(inv.id)) next.delete(inv.id)
    else next.add(inv.id)
    selectedIds.value = next
    return
  }
  router.push(`/app/invoice/${inv.id}`)
}

function toggleSelectAll() {
  if (allSelected.value) selectedIds.value = new Set()
  else selectedIds.value = new Set(list.value.map((inv) => inv.id))
}

async function onBatchDelete() {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  try {
    await showConfirmDialog({
      title: '删除发票',
      message: `确定删除选中的 ${ids.length} 张发票吗？删除后不可恢复。`,
      confirmButtonText: '删除',
      confirmButtonColor: '#ee0a24',
    })
  } catch {
    return // 取消
  }
  try {
    const res = await deleteInvoices(ids)
    showToast(`已删除 ${res.deleted ?? ids.length} 张`)
    manageMode.value = false
    selectedIds.value = new Set()
    onSearch()
  } catch {
    /* 拦截器已提示 */
  }
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
  background: var(--van-background-2, #fff);
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
.inv-card { position: relative; background: var(--van-background-2, #fff); border-radius: 8px; margin: 10px; padding: 12px; cursor: pointer; }
.list-wrap.with-bar { padding-bottom: 64px; }
.inv-card.dup { border-left: 3px solid var(--van-danger-color); }
.inv-card.selected { outline: 2px solid var(--van-primary-color, #1989fa); }
.check-icon { position: absolute; top: 12px; right: 12px; font-size: 20px; color: var(--van-gray-5); }
.check-icon.active { color: var(--van-primary-color, #1989fa); }
.manage-entry { color: var(--van-primary-color, #1989fa); font-size: 14px; }
.nav-action { color: var(--van-primary-color, #1989fa); font-size: 14px; margin-right: 14px; }
.export-pop { padding-bottom: 8px; }
.export-title { padding: 16px 16px 4px; font-weight: 600; text-align: center; }
.export-scope { margin: 0 16px 8px; font-size: 12px; color: var(--van-text-color-3, #969799); text-align: center; }
.export-sub { margin: 4px 16px 8px; font-size: 13px; color: var(--van-text-color-2, #646566); }
.export-foot { display: flex; gap: 12px; padding: 10px 16px; }
.row1 { display: flex; justify-content: space-between; font-weight: 600; }
.amount { color: var(--van-danger-color); }
.row2 { color: var(--van-text-color-2, #646566); font-size: 13px; margin: 6px 0; }
.row3 { display: flex; align-items: center; gap: 8px; color: var(--van-text-color-3, #969799); font-size: 12px; }
.cal-footer { display: flex; gap: 12px; padding: 10px 16px; }
.manage-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--van-background-2, #fff);
  box-shadow: 0 -2px 12px rgba(100, 101, 102, 0.12);
}
</style>
