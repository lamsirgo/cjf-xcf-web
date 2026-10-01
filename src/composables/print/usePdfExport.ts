/** 合并 / 当前页导出：Worker 渲染 + 免费页数上限校验 + 本地保存 + 进度与失败恢复。 */

import { ref } from 'vue'
import * as Comlink from 'comlink'
import { consumePrintQuota } from '@/api/print'
import { buildSheetDecor } from '@/lib/print/decor'
import type { PrintWorkerApi } from '@/workers/print-render.worker'
import { normalizeLimits, type DecoratorSpec, type PrintLimits, type SheetLayout, type SourceFile } from '@/lib/print/types'

type FilePayload = { id: string; name: string; ext: string; buffer: ArrayBuffer }

/** 单次导出超时（毫秒）：超过则判定 Worker 卡死/崩溃并重置 */
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

let worker: Worker | null = null
let workerApi: Comlink.Remote<PrintWorkerApi> | null = null
/** 已发送到 Worker 的文件 id（避免每次导出整包克隆） */
let sentIds = new Set<string>()
/** Worker 是否已崩溃（onerror/超时）；业务性报错不重置，保留字节缓存 */
let workerBroken = false

export interface ExportProgress {
  done: number
  total: number
}

/** 导出/分享结果：status 之外还带回页数与一次性配额令牌，供用量上报核销 */
export interface ExportOutcome {
  status: 'saved' | 'cancelled' | 'busy' | 'shared'
  pages: number
  quotaToken: string | null
}

function genRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 导出前申请配额许可（K02）。
 * - 平台拒绝（超额/未开通）：抛出可读错误，阻止本次导出；
 * - 网络异常：降级放行（与平台 fail-open 一致），返回 null 令牌。
 */
async function requestQuota(pages: number): Promise<string | null> {
  try {
    const grant = await consumePrintQuota(pages, genRequestId())
    return grant.enforced ? grant.token : null
  } catch (err) {
    // 业务拒绝（平台明确不给额度）→ 必须中断导出
    const msg = (err as Error)?.message ?? ''
    if (/额度|许可|未开通|阈值|频繁/.test(msg)) throw err
    // 网络/离线等原因：不阻断本地能力，用量上报时按降级处理
    return null
  }
}

function resetWorker() {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = null
  workerApi = null
  sentIds = new Set()
  workerBroken = false
}

function ensureWorker(): Comlink.Remote<PrintWorkerApi> {
  if (!workerApi) {
    const w = new Worker(new URL('@/workers/print-render.worker.ts', import.meta.url), {
      type: 'module',
    })
    // Worker 未捕获异常/消息反序列化失败：立刻作废，避免后续调用永久挂起
    w.onerror = () => {
      workerBroken = true
      resetWorker()
    }
    w.onmessageerror = () => {
      workerBroken = true
      resetWorker()
    }
    worker = w
    workerApi = Comlink.wrap<PrintWorkerApi>(w)
  }
  return workerApi
}

/**
 * 带超时的 Worker 调用：渲染进程卡死或崩溃时不再让 UI 永久转圈。
 * 超时/异常一律重置 Worker（下次调用自动重建）。
 */
function rpc<T>(
  label: string,
  run: (api: Comlink.Remote<PrintWorkerApi>) => Promise<T>,
  timeoutMs = EXPORT_TIMEOUT_MS,
): Promise<T> {
  const api = ensureWorker()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      workerBroken = true
      resetWorker()
      reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒），已重置渲染进程；请减少票据数量或重试`))
    }, timeoutMs)
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    try {
      run(api).then(
        (v) => finish(() => resolve(v)),
        (err) => {
          const message = (err as Error)?.message || '渲染进程执行失败'
          // 业务性失败（如 PDF 损坏）不重置 Worker，避免丢掉已缓存的文件字节
          if (workerBroken) resetWorker()
          finish(() => reject(new Error(`${label}失败：${message}`)))
        },
      )
    } catch (err) {
      finish(() => reject(new Error(`${label}失败：${(err as Error).message}`)))
    }
  })
}

function downloadPdf(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收，确保浏览器已接管下载
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

interface SavePickerOptions {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}

type PickerWindow = Window & {
  showSaveFilePicker?: (opts: SavePickerOptions) => Promise<FileSystemFileHandle>
}

/**
 * Chromium 系：弹出系统保存对话框，由用户选择保存位置。
 * 返回 saved/cancelled/unavailable。
 */
async function saveWithPicker(bytes: Uint8Array, name: string) {
  const picker = (window as PickerWindow).showSaveFilePicker
  if (!picker) return 'unavailable' as const
  let handle: FileSystemFileHandle
  try {
    handle = await picker({
      suggestedName: name,
      types: [{ description: 'PDF 文件', accept: { 'application/pdf': ['.pdf'] } } as const],
    })
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return 'cancelled' as const
    throw new Error(`保存位置选择失败：${(err as Error).message}`)
  }
  const writable = await (
    handle as FileSystemFileHandle & {
      createWritable: () => Promise<FileSystemWritableFileStream>
    }
  ).createWritable()
  try {
    await writable.write(bytes)
  } finally {
    await writable.close()
  }
  return 'saved' as const
}

/** 统一保存：优先系统保存对话框，不可用则回退下载；用户取消时明确返回 cancelled */
async function persistPdf(bytes: Uint8Array, name: string): Promise<'saved' | 'cancelled'> {
  const result = await saveWithPicker(bytes, name)
  if (result === 'saved') return 'saved'
  if (result === 'cancelled') return 'cancelled'
  downloadPdf(bytes, name)
  return 'saved'
}

/** 导出文件名：带时间戳，避免重复导出互相覆盖 */
function exportName(scope: 'all' | 'current', pages: number): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  return scope === 'current'
    ? `发票打印-当前页-${stamp}.pdf`
    : `发票合并打印-${pages}页-${stamp}.pdf`
}

export function usePdfExport(
  getSheets: () => SheetLayout[],
  getFiles: () => SourceFile[],
  getDecorator: () => DecoratorSpec,
  getLimits: () => PrintLimits,
) {
  const exporting = ref(false)
  const progress = ref<ExportProgress>({ done: 0, total: 0 })
  /** 进度回调代理按实例缓存：既避免每次导出新建代理，也不会绑定到已卸载实例的 ref */
  let progressProxy: ((done: number, total: number) => void) | null = null

  /** 只发送本次排版真正用到的文件；已发送过的不再克隆（M3） */
  function buildPayload(sheets: SheetLayout[], force = false): FilePayload[] {
    const needed = new Set<string>()
    for (const s of sheets) for (const p of s.placements) needed.add(p.fileId)
    const files = getFiles()
    const known = new Set(files.map((f) => f.id))
    for (const id of needed) {
      if (!known.has(id)) {
        throw new Error('排版引用了已删除的票据文件，请重新导入后再导出')
      }
    }
    const out: FilePayload[] = []
    for (const f of files) {
      if (!needed.has(f.id)) continue
      if (!force && sentIds.has(f.id)) continue
      out.push({ id: f.id, name: f.name, ext: f.ext, buffer: f.buffer })
      sentIds.add(f.id)
    }
    return out
  }

  async function renderSheets(sheets: SheetLayout[]): Promise<Uint8Array> {
    const decor = sheets.map((s) => buildSheetDecor(s, getDecorator()))
    progress.value = { done: 0, total: sheets.length }

    const attempt = async (force: boolean): Promise<Uint8Array> =>
      rpc('导出渲染', (api) =>
        api.render(
          sheets,
          decor,
          buildPayload(sheets, force),
          (progressProxy ??= Comlink.proxy((done: number, total: number) => {
            progress.value = { done, total }
          })),
        ),
      )

    try {
      return await attempt(false)
    } catch (err) {
      // Worker 刚被重建（缓存丢失）时补发一次文件字节
      const message = (err as Error).message || ''
      if (/缺少文件字节/.test(message)) {
        sentIds = new Set()
        return await attempt(true)
      }
      throw err
    }
  }

  function assertExportable(sheetCount: number) {
    if (sheetCount === 0) throw new Error('暂无可导出的内容')
    const max = normalizeLimits(getLimits()).maxExportPages
    if (sheetCount > max) {
      throw new Error(
        `单次导出不能超过 ${max} 页（当前 ${sheetCount} 页），请减少票据或分批导出`,
      )
    }
  }

  async function doExport(
    scope: 'all' | 'current',
    currentIndex = 0,
  ): Promise<ExportOutcome> {
    if (exporting.value) return { status: 'busy', pages: 0, quotaToken: null }
    const allSheets = getSheets()
    // 删除文件后 current 可能已越界：钳制到有效范围，避免"导出当前页"莫名失败
    const idx = Math.min(Math.max(0, Math.trunc(currentIndex) || 0), Math.max(0, allSheets.length - 1))
    const sheets = scope === 'current' ? allSheets.slice(idx, idx + 1) : allSheets
    assertExportable(sheets.length)

    exporting.value = true
    try {
      // 导出前取得配额许可（K02）
      const quotaToken = await requestQuota(sheets.length)
      const bytes = await renderSheets(sheets)
      const status = await persistPdf(bytes, exportName(scope, sheets.length))
      return { status, pages: sheets.length, quotaToken }
    } finally {
      exporting.value = false
    }
  }

  /** 系统分享：把合并 PDF 交给微信/邮件等（不支持的浏览器抛错） */
  async function sharePdf(): Promise<ExportOutcome> {
    if (exporting.value) return { status: 'busy', pages: 0, quotaToken: null }
    const sheets = getSheets()
    assertExportable(sheets.length)

    exporting.value = true
    try {
      const quotaToken = await requestQuota(sheets.length)
      const bytes = await renderSheets(sheets)
      const file = new File([bytes], exportName('all', sheets.length), { type: 'application/pdf' })
      if (!navigator.canShare?.({ files: [file] })) {
        throw new Error('当前浏览器不支持分享文件，请改用「导出合并 PDF」')
      }
      await navigator.share({ files: [file], title: '发票合并打印' })
      return { status: 'shared', pages: sheets.length, quotaToken }
    } finally {
      exporting.value = false
    }
  }

  /** 打印校准测试页 */
  async function printTestPage(
    widthPt: number,
    heightPt: number,
    offsetXPt: number,
    offsetYPt: number,
  ): Promise<void> {
    if (exporting.value) return
    exporting.value = true
    try {
      const bytes = await rpc(
        '校准页生成',
        (api) => api.renderCalibration(widthPt, heightPt, offsetXPt, offsetYPt),
        60_000,
      )
      await persistPdf(bytes, exportName('current', 1).replace('当前页', '校准测试页'))
    } finally {
      exporting.value = false
    }
  }

  /** 文件被删除/清空时释放 Worker 内的字节缓存 */
  async function releaseFiles(ids?: string[]) {
    if (ids && ids.length > 0) ids.forEach((id) => sentIds.delete(id))
    else sentIds = new Set()
    if (!workerApi) return
    try {
      await workerApi.clearFiles(ids)
    } catch {
      resetWorker()
    }
  }

  return { exporting, progress, doExport, sharePdf, printTestPage, releaseFiles }
}
