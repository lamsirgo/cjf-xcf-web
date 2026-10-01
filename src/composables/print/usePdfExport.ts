/** 合并 / 当前页导出：Worker 渲染 + 免费页数上限校验 + 本地保存 + 进度与失败恢复。 */

import { ref } from 'vue'
import * as Comlink from 'comlink'
import { buildSheetDecor } from '@/lib/print/decor'
import type { PrintWorkerApi } from '@/workers/print-render.worker'
import type { DecoratorSpec, PrintLimits, SheetLayout, SourceFile } from '@/lib/print/types'

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
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  return scope === 'current' ? `发票打印-当前页-${stamp}.pdf` : `发票合并打印-${pages}页-${stamp}.pdf`
}

export function usePdfExport(
  getSheets: () => SheetLayout[],
  getFiles: () => SourceFile[],
  getDecorator: () => DecoratorSpec,
  getLimits: () => PrintLimits,
) {
  const exporting = ref(false)
  const progress = ref<ExportProgress>({ done: 0, total: 0 })
  const lastError = ref<string | null>(null)

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
          Comlink.proxy((done: number, total: number) => {
            progress.value = { done, total }
          }),
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
    const max = getLimits().maxExportPages
    if (sheetCount > max) {
      throw new Error(
        `单次导出不能超过 ${max} 页（当前 ${sheetCount} 页），请减少票据或分批导出`,
      )
    }
  }

  async function doExport(
    scope: 'all' | 'current',
    currentIndex = 0,
  ): Promise<'saved' | 'cancelled' | 'busy'> {
    if (exporting.value) return 'busy'
    const allSheets = getSheets()
    const sheets = scope === 'current' ? allSheets.slice(currentIndex, currentIndex + 1) : allSheets
    assertExportable(sheets.length)

    exporting.value = true
    lastError.value = null
    try {
      const bytes = await renderSheets(sheets)
      return await persistPdf(bytes, exportName(scope, sheets.length))
    } catch (err) {
      lastError.value = (err as Error).message || '导出失败'
      throw err
    } finally {
      exporting.value = false
    }
  }

  /** 系统分享：把合并 PDF 交给微信/邮件等（不支持的浏览器抛错） */
  async function sharePdf(): Promise<'shared' | 'busy'> {
    if (exporting.value) return 'busy'
    const sheets = getSheets()
    assertExportable(sheets.length)

    exporting.value = true
    lastError.value = null
    try {
      const bytes = await renderSheets(sheets)
      const file = new File([bytes], exportName('all', sheets.length), { type: 'application/pdf' })
      if (!navigator.canShare?.({ files: [file] })) {
        throw new Error('当前浏览器不支持分享文件，请改用「导出合并 PDF」')
      }
      await navigator.share({ files: [file], title: '发票合并打印' })
      return 'shared'
    } catch (err) {
      lastError.value = (err as Error).message || '分享失败'
      throw err
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
    lastError.value = null
    try {
      const bytes = await rpc(
        '校准页生成',
        (api) => api.renderCalibration(widthPt, heightPt, offsetXPt, offsetYPt),
        60_000,
      )
      await persistPdf(bytes, exportName('current', 1).replace('当前页', '校准测试页'))
    } catch (err) {
      lastError.value = (err as Error).message || '校准页生成失败'
      throw err
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

  return { exporting, progress, lastError, doExport, sharePdf, printTestPage, releaseFiles }
}
