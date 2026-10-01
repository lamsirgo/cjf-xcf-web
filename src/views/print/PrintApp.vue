<template>
  <div
    class="page"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <van-nav-bar title="发票合并打印" left-arrow @click-left="goBack">
      <template #right>
        <van-icon name="info-o" class="nav-info" @click="showChangelog = true" />
        <span v-if="fileCount > 0" class="nav-clear" @click="openCleanup">清空</span>
      </template>
    </van-nav-bar>

    <!-- 门禁：停用 / 需要联网校验 / 需要更新（MD §8.1 强制失效 + I05 版本对齐） -->
    <div v-if="gateReason !== 'ok'" class="disabled-card">
      <van-icon :name="gateIcon" class="dc-icon" />
      <div class="dc-title">{{ gateTitle }}</div>
      <div class="dc-cap">{{ gateCap }}</div>
      <div v-if="gateDiagnostic" class="dc-diag">{{ gateDiagnostic }}</div>
      <van-button
        size="small"
        plain
        type="primary"
        :loading="gateChecking"
        @click="gateReason === 'update-required' ? reloadPage() : checkGate()"
      >
        {{ gateReason === 'update-required' ? '刷新页面' : '重新检查' }}
      </van-button>
    </div>

    <template v-else>
      <div v-if="dragging" class="drop-hint">松开即导入票据文件</div>

      <!-- ① 导入 -->
      <div class="import-card" @click="triggerPick">
        <van-icon name="add-o" class="ic-add" />
        <div class="ic-title">添加票据文件</div>
        <div class="ic-cap">
          支持 PDF / PNG / JPG，可多选、可拖入文件；也可直接 Ctrl+V 粘贴截图
        </div>
        <div class="ic-folder" @click.stop="triggerPickFolder">
          <van-icon name="directory" /> 选择整个文件夹
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        multiple
        accept=".pdf,.png,.jpg,.jpeg"
        hidden
        @change="onFileInput"
      />
      <input
        ref="folderInput"
        type="file"
        multiple
        webkitdirectory
        directory
        hidden
        @change="onFolderInput"
      />

      <!-- 文件统计 / 管理入口 -->
      <div class="stat-row" @click="showFiles = true">
        <span>{{ fileCount }} 个文件 / {{ pageCount }} 张票据 · 导出 {{ sheets.length }} 页</span>
        <van-icon name="arrow" />
      </div>

      <!-- 去重与统计 -->
      <PrintStatsCard
        v-if="capabilities.stats || capabilities.dedup"
        :scanning="scanning"
        :phase="phase"
        :progress="progress"
        :has-scanned="hasScanned"
        :stats="stats"
        :failures="failures"
        :dedup-enabled="capabilities.dedup"
        :has-files="pageCount > 0"
        @scan="onScan"
        @rescan="onRescan"
        @copy="onCopyStats"
        @csv="onExportCsv"
        @dup="showDup = true"
        @manual="openManual(null)"
      />

      <!-- ② 版式设置 -->
      <div v-if="capabilities.layout" class="card">
        <PrintLayoutPanel
          :state="state"
          :presets="namedPresets"
          :usage-pages="usagePages"
        :daily-cap="dailyCap"
        :used-today="usedToday"
          @select="selectPreset"
          @test="onPrintTest"
          @save-preset="onSavePreset"
          @apply-preset="onApplyPreset"
          @delete-preset="deletePreset"
        />
      </div>

      <!-- ③ 装饰设置 -->
      <div class="card">
        <PrintDecorPanel :state="state" :duplex-enabled="capabilities.duplex" />
      </div>

      <!-- ④ 预览 -->
      <div class="card">
        <PrintPreview
          :sheets="sheets"
          :files="files"
          :decorator="effectiveDecorator"
          @update:current="onCurrentChange"
        />
      </div>

      <!-- 隐私声明（G04） -->
      <p class="privacy">
        <van-icon name="shield-o" /> 票据全程在浏览器本地处理（排版、识别、导出），
        <b>不上传服务器</b>；平台仅下发用量阈值并记录不含票面的导出页数。本地草稿按账号隔离并保留 7 天，可在「清空」中一键删除。<template v-if="appVersion">（应用版本 {{ appVersion }}）</template>
      </p>
    </template>

    <!-- ⑤ 导出 -->
    <div v-if="gateReason === 'ok'" class="bottom-bar">
      <div v-if="exporting && exportProgress.total > 0" class="export-progress">
        <van-progress
          :percentage="exportPercent"
          stroke-width="4"
          :show-pivot="false"
        />
        <span>正在生成 PDF {{ exportProgress.done }}/{{ exportProgress.total }} 页</span>
      </div>
      <div v-if="dailyCap > 0" class="quota-line">
        今日导出额度：{{ usedToday }} / {{ dailyCap }} 页
      </div>
      <div class="bb-actions">
        <van-button
          plain
          type="primary"
          class="share-btn"
          icon="share-o"
          :loading="exporting"
          :disabled="sheets.length === 0"
          @click="onShare"
        />
        <van-button
          plain
          type="primary"
          :disabled="sheets.length === 0 || exporting"
          @click="onExport('current')"
        >导出当前页</van-button>
        <van-button
          type="primary"
          :loading="exporting"
          :disabled="sheets.length === 0"
          @click="onExport('all')"
        >导出合并 PDF</van-button>
      </div>
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
        :view="fileView"
        @update:view="fileView = $event"
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
        @view-original="openOriginal"
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
        @view-original="openOriginal"
      />
    </van-popup>

    <!-- 原图查看（人工校正时核对票面） -->
    <van-popup
      v-model:show="originalVisible"
      position="bottom"
      round
      closeable
      :style="{ maxHeight: '92%' }"
      @closed="closeOriginal"
    >
      <div class="ov-wrap">
        <div class="ov-head">
          <span class="ov-title">{{ originalTarget?.pageLabel || '原图' }}</span>
          <span class="ov-sub">{{ originalTarget?.name }}</span>
        </div>
        <div v-if="originalLoading" class="ov-loading">正在渲染原图…</div>
        <div v-else-if="originalError" class="ov-error">{{ originalError }}</div>
        <img v-else-if="originalTarget" :src="originalTarget.url" class="ov-img" alt="票据原图" />
        <div class="ov-tip">原图仅在本地渲染，用于核对票面号码/金额，不会上传。</div>
      </div>
    </van-popup>

    <!-- 更新日志 -->
    <PrintChangelog v-model:show="showChangelog" />

    <!-- 分级清理 -->
    <van-action-sheet
      v-model:show="showCleanup"
      title="本地数据清理"
      :actions="cleanupActions"
      cancel-text="取消"
      close-on-click-action
      @select="onCleanupSelect"
    />
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
  showToast,
} from 'vant'
import { getPrintManifest, reportPrintUsage } from '@/api/print'
import { BizError } from '@/api/request'
import {
  CLIENT_VERSION,
  classifyGateFailure,
  evaluateGate,
  gateMessage,
  type GateFailure,
  type GateReason,
} from '@/lib/print/gate'
import type { PrintCapabilities, PrintManifest } from '@/api/print'
import { clampOffsets, computeLayout } from '@/lib/print/layout'
import {
  FALLBACK_LIMITS,
  normalizeLimits,
  numberBandPt,
  paperSize,
  type DecoratorSpec,
  type PrintLimits,
} from '@/lib/print/types'
import { useDraft } from '@/composables/print/useDraft'
import { useFileSet } from '@/composables/print/useFileSet'
import { usePdfExport } from '@/composables/print/usePdfExport'
import { usePrintSettings } from '@/composables/print/usePrintSettings'
import { useOriginalView } from '@/composables/print/useOriginalView'
import { useQrScan, type ManualInput } from '@/composables/print/useQrScan'
import { useInvoiceStats, type ResolvedPage } from '@/composables/print/useInvoiceStats'
import { useAuthStore } from '@/stores/auth'
import PrintChangelog from './components/PrintChangelog.vue'
import PrintDecorPanel from './components/PrintDecorPanel.vue'
import PrintDupDetail from './components/PrintDupDetail.vue'
import PrintFileList from './components/PrintFileList.vue'
import PrintLayoutPanel from './components/PrintLayoutPanel.vue'
import PrintManualPanel, { type ManualItem } from './components/PrintManualPanel.vue'
import PrintPreview from './components/PrintPreview.vue'
import PrintStatsCard from './components/PrintStatsCard.vue'

const router = useRouter()
const auth = useAuthStore()
const limits = ref<PrintLimits>(normalizeLimits(FALLBACK_LIMITS))

/** ---------- 应用开关与能力位（H2 / I04） ---------- */
const ALL_CAPS: PrintCapabilities = {
  layout: true,
  dedup: true,
  stats: true,
  duplex: true,
  cloudBatch: false,
}
const capabilities = ref<PrintCapabilities>({ ...ALL_CAPS })
/** 门禁结果：ok / 应用停用 / 需要联网校验 / 需要更新客户端 */
const gateReason = ref<GateReason | 'disabled'>('ok')
const gateChecking = ref(false)
const usagePages = ref(0)
const dailyCap = ref(0)
const usedToday = ref(0)
const appVersion = ref('')
/** 上次校验失败的具体原因（用于给出准确提示与诊断信息） */
const gateFailure = ref<GateFailure | null>(null)
/** 上次成功校验时间 + 平台下发的离线宽限期一起持久化（否则重载后宽限期退化为 0） */
const GATE_STATE_KEY = 'print_gate_state'

const gateTitle = computed(() => {
  if (gateReason.value === 'disabled') return '应用已停用'
  if (gateReason.value === 'update-required') return '请更新应用'
  return '需要联网校验'
})
const gateCap = computed(() => {
  if (gateReason.value === 'disabled') {
    return '「发票合并打印」当前未开通或已被管理员停用，请联系平台管理员。'
  }
  if (gateReason.value === 'update-required') {
    return '当前版本已不受支持，请刷新页面以加载最新版本后再使用。'
  }
  // need-online：按真实失败原因给提示（接口不存在 / 接口报错 / 登录失效 / 断网）
  return gateMessage(gateFailure.value ?? { kind: 'offline' }).cap
})
const gateIcon = computed(() => {
  if (gateReason.value === 'disabled') return 'lock'
  if (gateReason.value === 'update-required') return 'upgrade'
  const kind = gateFailure.value?.kind
  if (kind === 'not-deployed' || kind === 'server') return 'warning-o'
  if (kind === 'auth') return 'lock'
  return 'wifi-o'
})
/** 诊断信息：页面上直接给出接口/状态码，避免运维盲查 */
const gateDiagnostic = computed(() => {
  const f = gateFailure.value
  if (!f || gateReason.value !== 'need-online') return ''
  const parts = [`接口：${window.location.origin}/api/v1/print/manifest`]
  if (f.status) parts.push(`状态：${f.status}`)
  if (f.detail) parts.push(`信息：${f.detail}`)
  return parts.join(' · ')
})

interface GateState {
  lastOkAt: number | null
  graceMinutes: number
}

function readGateState(): GateState {
  try {
    const raw = localStorage.getItem(GATE_STATE_KEY)
    if (!raw) return { lastOkAt: null, graceMinutes: 0 }
    const parsed = JSON.parse(raw) as Partial<GateState>
    const lastOkAt =
      typeof parsed.lastOkAt === 'number' && Number.isFinite(parsed.lastOkAt) && parsed.lastOkAt > 0
        ? parsed.lastOkAt
        : null
    const graceMinutes =
      typeof parsed.graceMinutes === 'number' && Number.isFinite(parsed.graceMinutes) && parsed.graceMinutes >= 0
        ? parsed.graceMinutes
        : 0
    return { lastOkAt, graceMinutes }
  } catch {
    return { lastOkAt: null, graceMinutes: 0 }
  }
}

function writeGateState(next: GateState) {
  try {
    localStorage.setItem(GATE_STATE_KEY, JSON.stringify(next))
  } catch {
    /* 隐私模式等场景存不了，本次仍可继续 */
  }
}

/** 启动/重试门禁：联网校验成功才允许进入（宽限期由平台下发） */
async function checkGate(): Promise<void> {
  gateChecking.value = true
  try {
    const m: PrintManifest = await getPrintManifest()
    // 平台可以返回 enabled=false（例如灰度收口）；此时一律不进入应用
    if (m.enabled === false) {
      gateReason.value = 'disabled'
      return
    }
    lastGraceMinutes = Math.max(0, Number(m.offlineGraceMinutes ?? 0))
    const state0 = readGateState()
    const result = evaluateGate({
      validationOk: true,
      lastOkAt: state0.lastOkAt,
      now: Date.now(),
      graceMinutes: state0.graceMinutes,
      clientVersion: CLIENT_VERSION,
      minClientVersion: m.minClientVersion,
    })
    if (result.reason !== 'ok') {
      gateReason.value = result.reason
      gateFailure.value = null
      return
    }
    // 成功校验：把「校验时间 + 平台下发的宽限期」一起持久化，
    // 否则离线重载时读不到宽限期，platform 配的 grace 会退化为 0。
    writeGateState({
      lastOkAt: result.recordOk ? Date.now() : state0.lastOkAt,
      graceMinutes: lastGraceMinutes,
    })
    gateFailure.value = null
    gateReason.value = 'ok'
    capabilities.value = { ...ALL_CAPS, ...(m.capabilities ?? {}) }
    // 未授权能力必须真正失效，而不是只隐藏入口（见下方 effectiveDecorator 的硬收口）
    if (!capabilities.value.duplex) state.duplex = false
    limits.value = normalizeLimits({ ...FALLBACK_LIMITS, ...(m.limits ?? {}) })
    usagePages.value = m.usage?.exportPages ?? 0
    dailyCap.value = m.usage?.dailyCap ?? 0
    usedToday.value = m.usage?.usedToday ?? 0
    appVersion.value = m.appVersion ?? ''
  } catch (err) {
    if (err instanceof BizError && err.code === 1002) {
      // 平台明确拒绝：应用未开通/已停用 → 不进入应用
      gateReason.value = 'disabled'
      gateFailure.value = null
      return
    }
    const failure = classifyGateFailure(err)
    gateFailure.value = failure
    // 便于现场排查：把接口/状态/原始信息打到控制台（不含票面数据）
    console.warn('[print] 启动校验失败', { kind: failure.kind, status: failure.status, detail: failure.detail })
    // 只有真正的网络离线才允许走宽限；平台明确拒绝（auth/server/接口版本过旧）
    // 一律硬挡，不得借离线宽限绕过停用/服务端拒绝（MD §8.1 关闭应用=强制失效）
    if (failure.kind !== 'offline') {
      gateReason.value = 'need-online'
      return
    }
    const state = readGateState()
    const result = evaluateGate({
      validationOk: false,
      lastOkAt: state.lastOkAt,
      now: Date.now(),
      graceMinutes: state.graceMinutes,
      clientVersion: CLIENT_VERSION,
      minClientVersion: null,
    })
    limits.value = normalizeLimits({ ...FALLBACK_LIMITS, ...limits.value })
    if (result.reason === 'ok') {
      showToast('离线模式：使用上次校验结果与本地默认限量（票据仍全程本地处理）')
    } else {
      gateReason.value = 'need-online'
    }
  } finally {
    gateChecking.value = false
  }
}

/** 最近一次 manifest 下发的离线宽限期（成功后写入 GATE_STATE_KEY，随校验时间一起持久化） */
let lastGraceMinutes = 0

const {
  files,
  parsing,
  parseProgress,
  orientationAdjusted,
  allPages,
  fileCount,
  pageCount,
  addFiles,
  removeFile,
  clear,
  moveFile,
} = useFileSet(limits)

const {
  state,
  namedPresets,
  selectPreset,
  layoutSpec,
  decorator,
  resetSettings,
  savePreset,
  applyPreset,
  deletePreset,
} = usePrintSettings()

/**
 * 能力位硬收口：未授权的装饰能力在这里被强制关闭，
 * 无论设置面板是否隐藏、命名预设里存了什么，都不会产生越权输出。
 */
const effectiveDecorator = computed<DecoratorSpec>(() =>
  capabilities.value.duplex ? decorator.value : { ...decorator.value, duplex: false },
)

/** 开了序号时给票面留出票面外的序号带（装饰只在票面外绘制） */
const numberBand = computed(() => numberBandPt(effectiveDecorator.value))
const sheets = computed(() =>
  computeLayout(layoutSpec.value, allPages.value, {
    duplex: effectiveDecorator.value.duplex,
    numberBand: numberBand.value,
  }),
)
const current = ref(0)

/** 预览可视页变化：钳制到有效范围，避免删除文件后 current 越界导致"导出当前页"失败 */
function onCurrentChange(i: number) {
  const max = Math.max(0, sheets.value.length - 1)
  current.value = Math.min(Math.max(0, Math.trunc(i) || 0), max)
}

// 票据数量变化（删除/清空）时同步钳制
watch(
  () => sheets.value.length,
  (len) => {
    if (current.value > len - 1) current.value = Math.max(0, len - 1)
  },
)

const showFiles = ref(false)
/** 文件集视图：顺序列表 / 缩略图网格（A04） */
const fileView = ref<'list' | 'grid'>(localStorage.getItem('print_file_view') === 'grid' ? 'grid' : 'list')
watch(fileView, (v) => {
  try {
    localStorage.setItem('print_file_view', v)
  } catch {
    /* ignore */
  }
})
const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)

const { exporting, progress: exportProgress, doExport, sharePdf, printTestPage, releaseFiles } =
  usePdfExport(
    () => sheets.value,
    () => files.value,
    () => effectiveDecorator.value,
    () => limits.value,
  )

const exportPercent = computed(() =>
  exportProgress.value.total > 0
    ? Math.round((exportProgress.value.done / exportProgress.value.total) * 100)
    : 0,
)

/** ---------- 二维码扫描与统计 ---------- */
const {
  scanning,
  phase,
  progress,
  failures,
  metas,
  metaMap,
  dupIgnored,
  ignoredSet,
  scanAll,
  applyManual,
  toggleIgnore,
  hydrate,
  resetResults,
  releaseFiles: releaseScanFiles,
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

const {
  visible: originalVisible,
  loading: originalLoading,
  error: originalError,
  target: originalTarget,
  open: openOriginalView,
  close: closeOriginal,
} = useOriginalView()

/** 打开某张票据的原图（需要按 pageId 反查所属文件） */
function openOriginal(pageId: string) {
  for (const f of files.value) {
    const page = f.pages.find((p) => p.id === pageId)
    if (page) {
      void openOriginalView(f, page)
      return
    }
  }
  showFailToast('未找到该票据文件')
}

const showDup = ref(false)
const showManual = ref(false)
const showChangelog = ref(false)
const manualTarget = ref<string | null>(null)

const manualItems = computed<ManualItem[]>(() => {
  const list: ManualItem[] = pendingManual.value.map((x) => ({ ...x }))
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
  if (allPages.value.length === 0) {
    showToast('请先添加票据文件')
    return
  }
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

/** ---------- 导入（选择 / 文件夹 / 粘贴 / 拖拽） ---------- */
function triggerPick() {
  fileInput.value?.click()
}

function triggerPickFolder() {
  folderInput.value?.click()
}

async function importFiles(list: File[] | FileList, okText?: string) {
  const before = orientationAdjusted.value.length
  try {
    await addFiles(list)
    if (okText) showSuccessToast(okText)
    if (orientationAdjusted.value.length > before) {
      const n = orientationAdjusted.value.length - before
      showToast({
        message: `已按照片方向信息（EXIF）自动转正 ${n} 张图片，预览与导出均为正立效果`,
        duration: 4000,
      })
    }
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

async function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  const picked = input.files
  if (!picked || picked.length === 0) return
  await importFiles(picked)
  input.value = ''
}

async function onFolderInput(e: Event) {
  const input = e.target as HTMLInputElement
  const picked = input.files
  if (!picked || picked.length === 0) return
  // 文件夹内只取受支持的票据类型，忽略 .DS_Store 等无关文件
  const supported = Array.from(picked).filter((f) => /\.(pdf|png|jpe?g)$/i.test(f.name))
  input.value = ''
  if (supported.length === 0) {
    showFailToast('该文件夹中未找到 PDF/PNG/JPG 票据文件')
    return
  }
  await importFiles(supported)
}

async function onPaste(e: ClipboardEvent) {
  if (gateReason.value !== 'ok') return
  const pasted = Array.from(e.clipboardData?.files ?? [])
  if (pasted.length === 0) return
  await importFiles(pasted)
}

/** ---------- 拖拽导入（A01）与同域链接拖入（A07） ---------- */
const dragging = ref(false)

function onDragOver(e: DragEvent) {
  const types = e.dataTransfer?.types ?? []
  if (!types.includes('Files') && !types.includes('text/uri-list') && !types.includes('text/plain')) {
    return
  }
  // dragover 会连续触发，不能用累加计数（否则 dragleave 永远减不到 0，提示会残留）
  dragging.value = true
}

function onDragLeave(e: DragEvent) {
  const to = e.relatedTarget as Node | null
  const root = e.currentTarget as Node | null
  if (to && root && root.contains(to)) return // 仍在页面内部移动
  dragging.value = false
}

/**
 * 拖入 URL 时只接受**同源**链接：外域链接会被 CSP/隐私策略阻断，
 * 且会让票据来源不可控，因此直接给出明确提示而不是静默失败。
 */
async function importFromUrl(raw: string): Promise<boolean> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (!/^https?:$/.test(url.protocol)) return false
  if (url.origin !== window.location.origin) {
    showFailToast('出于隐私与安全考虑，仅支持拖入本站链接；外部链接请先下载再拖入')
    return true
  }
  try {
    const resp = await fetch(url.toString(), { credentials: 'same-origin' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const blob = await resp.blob()
    const name = decodeURIComponent(url.pathname.split('/').pop() || 'ticket.pdf')
    const file = new File([blob], name, { type: blob.type || 'application/pdf' })
    await importFiles([file])
    return true
  } catch (err) {
    showFailToast(`链接导入失败：${(err as Error).message}`)
    return true
  }
}

async function onDrop(e: DragEvent) {
  dragging.value = false
  const dt = e.dataTransfer
  if (!dt) return
  const dropped = Array.from(dt.files ?? [])
  if (dropped.length > 0) {
    await importFiles(dropped)
    return
  }
  const text = dt.getData('text/uri-list') || dt.getData('text/plain')
  if (text) await importFromUrl(text.trim().split('\n')[0])
}

function reloadPage() {
  window.location.reload()
}

function goBack() {
  if (window.history.length > 1) router.back()
  else void router.push('/workbench')
}

/** ---------- 清空 / 删除 ---------- */
async function onClear() {
  try {
    await showConfirmDialog({
      title: '清空全部文件？',
      message: '将移除全部已导入票据、本地草稿与识别结果。',
    })
  } catch {
    return // 用户取消
  }
  const ids = files.value.map((f) => f.id)
  clear()
  resetResults()
  void releaseFiles(ids)
  releaseScanFiles(ids)
  await clearDraft().catch(() => {})
}

/** 立即把当前识别结果写回草稿（供分级清理后同步） */
function persistNow() {
  if (files.value.length === 0) {
    void clearDraft()
    return
  }
  const raws = files.value.map((f) => f.origFile).filter(Boolean) as File[]
  void saveDraftFiles(raws, files.value.map((f) => f.id))
    .then(() => saveDraftMeta({ ...state }, metas.value, dupIgnored.value))
    .catch(() => {})
}

/** 分级清理：全部 / 仅识别结果 / 仅设置 */
const showCleanup = ref(false)
const cleanupActions = [
  { name: '清空全部文件与本地数据' },
  { name: '仅清空识别结果（保留文件）' },
  { name: '仅恢复默认设置（保留文件）' },
]

async function onCleanupSelect(_action: unknown, index: number) {
  if (index === 0) {
    await onClear()
  } else if (index === 1) {
    resetResults()
    persistNow()
    showSuccessToast('识别结果已清空')
  } else {
    resetSettings()
    showSuccessToast('已恢复默认设置')
  }
}

function openCleanup() {
  showCleanup.value = true
}

async function onRemove(id: string) {
  removeFile(id)
  void releaseFiles([id])
  releaseScanFiles([id])
}

/** ---------- 版式预设（H02） ---------- */
function onSavePreset(name: string) {
  const saved = savePreset(name)
  if (saved) showSuccessToast(`已保存预设「${saved.name}」`)
  else showFailToast('预设名称不能为空')
}

function onApplyPreset(id: string) {
  if (applyPreset(id)) showSuccessToast('已套用预设')
}

/** ---------- 导出与用量上报（K01/K03） ---------- */
function genEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function reportExport(pages: number, scope: 'all' | 'current', quotaToken: string | null) {
  const spec = layoutSpec.value
  void reportPrintUsage({
    eventType: 'local_export',
    quantity: Math.max(1, Math.min(5000, pages)),
    clientEventId: genEventId(),
    quotaToken,
    // 仅版式元数据，绝不包含任何票面字段
    detail: {
      scope,
      pages,
      rows: spec.rows,
      cols: spec.cols,
      paper: spec.paper,
      orientation: spec.orientation,
      numbering: effectiveDecorator.value.numbering,
      divider: effectiveDecorator.value.divider,
      duplex: effectiveDecorator.value.duplex,
    },
  })
    .then((r) => {
      if (typeof r?.exportPages === 'number') usagePages.value = r.exportPages
      usedToday.value = Math.min(dailyCap.value || Number.MAX_SAFE_INTEGER, usedToday.value + pages)
    })
    .catch(() => {
      /* 离线或网络失败：不影响本地导出，用量以平台服务端为准 */
    })
}

async function onExport(scope: 'all' | 'current') {
  try {
    const result = await doExport(scope, current.value)
    if (result.status === 'busy') return
    if (result.status === 'cancelled') {
      showToast('已取消保存')
      return
    }
    showSuccessToast('导出成功')
    reportExport(result.pages, scope, result.quotaToken)
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

async function onShare() {
  try {
    const result = await sharePdf()
    if (result.status === 'busy') return
    reportExport(result.pages, 'all', result.quotaToken)
  } catch (err) {
    const name = (err as DOMException).name
    if (name === 'AbortError') return // 用户在系统分享面板取消
    showFailToast((err as Error).message)
  }
}

/** 打印校准测试页 */
async function onPrintTest() {
  try {
    const spec = layoutSpec.value
    const base = paperSize(spec)
    const [pageMmW, pageMmH] =
      spec.orientation === 'portrait'
        ? [base.widthMm, base.heightMm]
        : [base.heightMm, base.widthMm]
    const MM = 72 / 25.4
    // 与排版使用同一偏移钳制，保证校准页显示的偏移就是实际生效的偏移
    const off = clampOffsets(spec, numberBand.value)
    await printTestPage(pageMmW * MM, pageMmH * MM, off.xMm * MM, off.yMm * MM)
  } catch (err) {
    showFailToast((err as Error).message)
  }
}

/** ---------- 草稿（按登录用户分区，M6） ---------- */
const { loadDraft, saveDraftFiles, saveDraftMeta, clearDraft } = useDraft(() =>
  auth.user?.id ? String(auth.user.id) : '',
)
let draftReady = false
let saveTimer: number | undefined
let lastFileSig = ''

function fileSignature(): string {
  return files.value.map((f) => `${f.id}:${f.size}`).join('|')
}

/** 文件集变化 → 写字节；仅设置/识别结果变化 → 只写小元数据（不再整包重写） */
function scheduleDraftSave() {
  if (!draftReady) return
  window.clearTimeout(saveTimer)
  if (files.value.length === 0) {
    lastFileSig = ''
    void clearDraft()
    return
  }
  saveTimer = window.setTimeout(() => {
    const sig = fileSignature()
    if (sig !== lastFileSig) {
      lastFileSig = sig
      const raws = files.value.map((f) => f.origFile).filter(Boolean) as File[]
      void saveDraftFiles(raws, files.value.map((f) => f.id)).catch(() => {})
      // 文件集变化时也顺手落一次元数据，避免恢复到"旧设置"
      window.setTimeout(() => {
        void saveDraftMeta({ ...state }, metas.value, dupIgnored.value).catch(() => {})
      }, 400)
      return
    }
    void saveDraftMeta({ ...state }, metas.value, dupIgnored.value).catch(() => {})
  }, 1500)
}

watch([files, state, metas, dupIgnored], scheduleDraftSave, { deep: true })

/** ---------- 解析中遮罩 ---------- */
watch(parsing, (val) => {
  if (val) {
    showLoadingToast({
      message:
        parseProgress.value.total > 1
          ? `正在解析票据…（${parseProgress.value.done}/${parseProgress.value.total}）`
          : '正在解析票据…',
      forbidClick: true,
      duration: 0,
    })
  } else {
    closeToast()
  }
})

onMounted(async () => {
  window.addEventListener('paste', onPaste)
  await checkGate()
  if (gateReason.value !== 'ok') return

  // 草稿按用户分区：先确保拿到用户信息，避免存到 anon 分区
  if (!auth.user) {
    await auth.fetchMe().catch(() => {})
  }

  try {
    const draft = await loadDraft()
    if (draft && draft.files.length > 0) {
      try {
        await showConfirmDialog({
          title: '恢复草稿',
          message: `检测到上次有 ${draft.files.length} 个文件未处理，是否恢复？`,
        })
      } catch {
        draftReady = true
        return // 用户拒绝恢复：保留草稿，下次再问
      }
      try {
        await addFiles(draft.files, draft.fileIds)
        lastFileSig = fileSignature()
        if (draft.metas?.length) hydrate(draft.metas, draft.dupIgnored)
        showSuccessToast('草稿已恢复')
      } catch (err) {
        showFailToast(`草稿恢复失败：${(err as Error).message}`)
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
  // 释放 Worker 内的票据字节缓存 + 主线程文件集（含缩略图 blob URL，避免 SPA 内泄漏）
  const ids = files.value.map((f) => f.id)
  releaseScanFiles(ids)
  void releaseFiles(ids)
  clear()
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 0 12px 120px;
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

.disabled-card {
  margin-top: 60px;
  padding: 28px 20px;
  text-align: center;
  background: var(--van-background-2, #fff);
  border-radius: 12px;
}
.dc-icon {
  font-size: 34px;
  color: var(--van-text-color-3, #969799);
}
.dc-title {
  margin-top: 10px;
  font-size: 16px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.dc-diag {
  margin: 0 0 14px;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
  color: var(--van-text-color-3, #969799);
  background: var(--van-background, #f7f8fa);
  border-radius: 6px;
}
.dc-cap {
  margin: 8px 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--van-text-color-3, #969799);
}

.drop-hint {
  position: fixed;
  inset: 0;
  z-index: 99;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: var(--van-primary-color);
  background: rgba(31, 104, 235, 0.08);
  border: 2px dashed var(--van-primary-color);
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
  line-height: 1.5;
  color: var(--van-text-color-3, #969799);
}
.ic-folder {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--van-primary-color);
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

.privacy {
  margin: 14px 2px 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--van-text-color-3, #969799);
}

.bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  background: var(--van-background-2, #fff);
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.06);
}
.ov-wrap {
  padding: 16px 14px 20px;
}
.ov-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}
.ov-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.ov-sub {
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
  word-break: break-all;
}
.ov-img {
  display: block;
  width: 100%;
  max-height: 68vh;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--van-border-color, #ebedf0);
  border-radius: 6px;
}
.ov-loading,
.ov-error {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
}
.ov-error {
  color: var(--van-danger-color, #ee0a24);
}
.ov-tip {
  margin-top: 10px;
  font-size: 11px;
  color: var(--van-text-color-3, #969799);
}
.quota-line {
  padding: 0 2px 6px;
  font-size: 11px;
  color: var(--van-text-color-3, #969799);
}
.export-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 8px;
  font-size: 11px;
  color: var(--van-text-color-3, #969799);
}
.export-progress :deep(.van-progress) {
  flex: 1;
}
.bb-actions {
  display: flex;
  gap: 10px;
}
.bb-actions .van-button {
  flex: 1;
}
.share-btn {
  flex: 0 0 52px;
  padding: 0;
}
</style>
