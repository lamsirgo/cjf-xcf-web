<template>
  <div class="page">
    <van-nav-bar title="发票合并打印" left-arrow @click-left="router.back()">
      <template #right>
        <van-icon name="info-o" class="nav-info" @click="showChangelog = true" />
        <span v-if="fileCount > 0" class="nav-clear" @click="onClear">清空</span>
      </template>
    </van-nav-bar>

    <!-- ① 导入 -->
    <div class="import-card" @click="triggerPick">
      <van-icon name="add-o" class="ic-add" />
      <div class="ic-title">添加票据文件</div>
      <div class="ic-cap">支持 PDF / PNG / JPG，可多选；也可直接 Ctrl+V 粘贴截图</div>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".pdf,.png,.jpg,.jpeg"
      hidden
      @change="onFileInput"
    />

    <!-- 文件统计 / 管理入口 -->
    <div class="stat-row" @click="showFiles = true">
      <span>{{ fileCount }} 个文件 / {{ pageCount }} 张票据 · 导出 {{ sheets.length }} 页</span>
      <van-icon name="arrow" />
    </div>

    <!-- 去重与统计 -->
    <PrintStatsCard
      :scanning="scanning"
      :progress="progress"
      :has-scanned="hasScanned"
      :stats="stats"
      @scan="onScan"
      @rescan="onRescan"
      @copy="onCopyStats"
      @csv="onExportCsv"
      @dup="showDup = true"
      @manual="openManual(null)"
    />

    <!-- ② 版式设置 -->
    <div class="card">
      <PrintLayoutPanel :state="state" @select="selectPreset" />
    </div>

    <!-- ③ 装饰设置 -->
    <div class="card">
      <PrintDecorPanel :state="state" />
    </div>

    <!-- ④ 预览 -->
    <div class="card">
      <PrintPreview
        :sheets="sheets"
        :files="files"
        :decorator="decorator"
        @update:current="current = $event"
      />
    </div>

    <!-- ⑤ 导出 -->
    <div class="bottom-bar">
      <van-button
        plain
        type="primary"
        :disabled="sheets.length === 0"
        @click="onExport('current')"
      >导出当前页</van-button>
      <van-button
        type="primary"
        :loading="exporting"
        :disabled="sheets.length === 0"
        @click="onExport('all')"
      >导出合并 PDF</van-button>
    </div>

    <!-- 文件管理 -->
    <van-popup
      v-model:show="showFiles"
      position="bottom"
      round
      closeable
      :style="{ maxHeight: '76%' }"
    >
      <PrintFileList
        :files="files"
        @remove="onRemove"
        @move="moveFile"
        @clear="onClear"
      />
    </van-popup>

    <!-- 重复发票详情 -->
    <van-popup
      v-model:show="showDup"
      position="bottom"
      round
      closeable
      :style="{ maxHeight: '80%' }"
    >
      <PrintDupDetail
        :groups="dup.groups"
        :meta-of="(pid: string) => metaMap.get(pid)"
        :resolve-page="resolvePage"
        :ignored="ignoredSet"
        @toggle-ignore="toggleIgnore"
        @edit="onDupEdit"
      />
    </van-popup>

    <!-- 人工补录 -->
    <van-popup
      v-model:show="showManual"
      position="bottom"
      round
      closeable
      :style="{ maxHeight: '84%' }"
      @closed="manualTarget = null"
    >
      <PrintManualPanel
        :items="manualItems"
        :active-id="manualTarget"
        :meta-of="(pid: string) => metaMap.get(pid)"
        :resolve-page="resolvePage"
        @save="onManualSave"
      />
    </van-popup>

    <!-- 更新日志 -->
    <PrintChangelog v-model:show="showChangelog" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  closeToast,
  showConfirmDialog,
  showFailToast,
  showLoadingToast,
  showSuccessToast,
} from 'vant'
import { getPrintLimits } from '@/api/print'
import { computeLayout } from '@/lib/print/layout'
import {
  FALLBACK_LIMITS,
  type PrintLimits,
} from '@/lib/print/types'
import { useDraft } from '@/composables/print/useDraft'
import { useFileSet } from '@/composables/print/useFileSet'
import { usePdfExport } from '@/composables/print/usePdfExport'
import { usePrintSettings } from '@/composables/print/usePrintSettings'
import { useQrScan, type ManualInput } from '@/composables/print/useQrScan'
import { useInvoiceStats, type ResolvedPage } from '@/composables/print/useInvoiceStats'
import PrintChangelog from './components/PrintChangelog.vue'
import PrintDecorPanel from './components/PrintDecorPanel.vue'
import PrintDupDetail from './components/PrintDupDetail.vue'
import PrintFileList from './components/PrintFileList.vue'
import PrintLayoutPanel from './components/PrintLayoutPanel.vue'
import PrintManualPanel, { type ManualItem } from './components/PrintManualPanel.vue'
import PrintPreview from './components/PrintPreview.vue'
import PrintStatsCard from './components/PrintStatsCard.vue'

const router = useRouter()
const limits = ref<PrintLimits>({ ...FALLBACK_LIMITS })

const {
  files,
  parsing,
  allPages,
  fileCount,
  pageCount,
  addFiles,
  removeFile,
  clear,
  moveFile,
} = useFileSet(limits)

const { state, selectPreset, layoutSpec, decorator } = usePrintSettings()

const sheets = computed(() =>
  computeLayout(layoutSpec.value, allPages.value, { duplex: decorator.value.duplex }),
)
const current = ref(0)
const showFiles = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const { exporting, doExport } = usePdfExport(
  () => sheets.value,
  () => files.value,
  () => decorator.value,
  () => limits.value,
)

// ---------- 二维码扫描与统计 ----------
const {
  scanning,
  progress,
  metas,
  metaMap,
  dupIgnored,
  ignoredSet,
  scanAll,
  applyManual,
  toggleIgnore,
  hydrate,
  resetResults,
} = useQrScan(
  () => allPages.value,
  () => files.value,
)

function resolvePage(pageId: string): ResolvedPage | null {
  for (const f of files.value) {
    const page = f.pages.find((p) => p.id === pageId)
    if (page) return { page, fileName: f.name }
  }
  return null
}

const { hasScanned, dup, stats, pendingManual, copyStats, exportCsv } = useInvoiceStats(
  () => metas.value,
  () => ignoredSet.value,
  resolvePage,
)

const showDup = ref(false)
const showManual = ref(false)
const showChangelog = ref(false)
const manualTarget = ref<string | null>(null)

const manualItems = computed<ManualItem[]>(() => {
  const list: ManualItem[] = pendingManual.value.map((x) => ({ ...x }))
  // 从重复详情直接编辑某张票（可能已识别）：额外纳入
  if (manualTarget.value && !list.some((x) => x.meta.pageId === manualTarget.value)) {
    const resolved = resolvePage(manualTarget.value)
    const m = metaMap.get(manualTarget.value)
    if (resolved && m) list.unshift({ meta: m, page: resolved.page, fileName: resolved.fileName })
  }
  return list
})

function openManual(target: string | null) {
  manualTarget.value = target
  showManual.value = true
}

function onDupEdit(pageId: string) {
  showDup.value = false
  openManual(pageId)
}

async function onScan() {
  try {
    await scanAll()
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

async function onRescan() {
  try {
    await scanAll(true)
    showSuccessToast('重新扫描完成')
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

async function onCopyStats() {
  try {
    await copyStats()
    showSuccessToast('统计结果已复制')
  } catch {
    showFailToast('复制失败，请重试')
  }
}

function onExportCsv() {
  try {
    exportCsv()
    showSuccessToast('CSV 文件已导出')
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

function onManualSave(pageId: string, input: ManualInput) {
  applyManual(pageId, input)
  if (manualTarget.value === pageId) manualTarget.value = null
  showSuccessToast('补录已保存')
}

// ---------- 导入 ----------
function triggerPick() {
  fileInput.value?.click()
}

async function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  try {
    await addFiles(input.files)
  } catch (err) {
    showFailToast((err as Error).message)
  }
  input.value = ''
}

async function onPaste(e: ClipboardEvent) {
  const pasted = Array.from(e.clipboardData?.files ?? [])
  if (pasted.length === 0) return
  try {
    await addFiles(pasted)
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

// ---------- 清空 / 删除 ----------
async function onClear() {
  try {
    await showConfirmDialog({
      title: '清空全部文件？',
      message: '将移除全部已导入票据及本地草稿。',
    })
  } catch {
    return // 用户取消
  }
  clear()
  resetResults()
  await clearDraft().catch(() => {})
}

async function onRemove(id: string) {
  removeFile(id)
}

// ---------- 导出 ----------
async function onExport(scope: 'all' | 'current') {
  try {
    await doExport(scope, current.value)
    showSuccessToast('导出成功')
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

// ---------- 草稿 ----------
const { loadDraft, saveDraft, clearDraft } = useDraft()
let draftReady = false
let saveTimer: number | undefined

watch(
  [files, state],
  () => {
    if (!draftReady) return
    window.clearTimeout(saveTimer)
    if (files.value.length === 0) {
      void clearDraft()
      return
    }
    saveTimer = window.setTimeout(() => {
      const raws = files.value.map((f) => f.origFile).filter(Boolean) as File[]
      void saveDraft(raws, { ...state }, metas.value, dupIgnored.value).catch(() => {})
    }, 1500)
  },
  { deep: true },
)

// ---------- 解析中遮罩 ----------
watch(parsing, (val) => {
  if (val) {
    showLoadingToast({ message: '正在解析票据…', forbidClick: true, duration: 0 })
  } else {
    closeToast()
  }
})

onMounted(async () => {
  window.addEventListener('paste', onPaste)

  try {
    limits.value = await getPrintLimits()
  } catch {
    limits.value = { ...FALLBACK_LIMITS }
  }

  try {
    const draft = await loadDraft()
    if (draft && draft.files.length > 0) {
      try {
        await showConfirmDialog({
          title: '恢复草稿',
          message: `检测到上次有 ${draft.files.length} 个文件未处理，是否恢复？`,
        })
        await addFiles(draft.files)
        if (draft.metas?.length) hydrate(draft.metas, draft.dupIgnored)
        showSuccessToast('草稿已恢复')
      } catch {
        /* 用户拒绝恢复：保留草稿，下次再问 */
      }
    }
  } catch {
    /* IDB 不可用：静默，功能可正常在线使用 */
  }
  draftReady = true
})

onUnmounted(() => {
  window.removeEventListener('paste', onPaste)
  window.clearTimeout(saveTimer)
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 0 12px 88px;
  background: var(--van-background, #f6f7f9);
}
.nav-clear {
  font-size: 13px;
  color: var(--van-primary-color);
}
.nav-info {
  margin-right: 14px;
  font-size: 18px;
  color: var(--van-text-color-2, #646566);
}

.import-card {
  margin-top: 12px;
  padding: 24px 16px;
  border: 1px dashed var(--van-border-color, #dcdee0);
  border-radius: 12px;
  background: var(--van-background-2, #fff);
  text-align: center;
}
.ic-add {
  font-size: 26px;
  color: var(--van-primary-color);
}
.ic-title {
  margin-top: 8px;
  font-size: 15px;
  font-weight: 500;
  color: var(--van-text-color, #323233);
}
.ic-cap {
  margin-top: 6px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}

.stat-row {
  margin-top: 12px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--van-background-2, #fff);
  border-radius: 10px;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
}

.card {
  margin-top: 12px;
  padding: 12px 14px;
  background: var(--van-background-2, #fff);
  border-radius: 12px;
}

.bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  display: flex;
  gap: 10px;
  background: var(--van-background-2, #fff);
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.06);
}
.bottom-bar .van-button {
  flex: 1;
}
</style>
