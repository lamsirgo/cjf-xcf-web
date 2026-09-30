/** 合并 / 当前页导出：Worker 渲染 + 免费页数上限校验 + 本地保存。 */

import { ref } from 'vue'
import * as Comlink from 'comlink'
import { buildSheetDecor } from '@/lib/print/decor'
import type { PrintWorkerApi } from '@/workers/print-render.worker'
import type { DecoratorSpec, PrintLimits, SheetLayout, SourceFile } from '@/lib/print/types'

let worker: Worker | null = null
let workerApi: PrintWorkerApi | null = null

function ensureWorker(): PrintWorkerApi {
  if (!workerApi) {
    worker = new Worker(new URL('@/workers/print-render.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerApi = Comlink.wrap<PrintWorkerApi>(worker)
  }
  return workerApi
}

function downloadPdf(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' })
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
    throw err
  }
  const writable = await (
    handle as FileSystemFileHandle & {
      createWritable: () => Promise<FileSystemWritableFileStream>
    }
  ).createWritable()
  try {
    await writable.write(bytes.slice())
  } finally {
    await writable.close()
  }
  return 'saved' as const
}

/** 统一保存：优先系统保存对话框，不可用或取消则回退下载 */
async function persistPdf(bytes: Uint8Array, name: string): Promise<'saved' | 'cancelled'> {
  const result = await saveWithPicker(bytes, name)
  if (result === 'saved') return 'saved'
  if (result === 'cancelled') return 'cancelled'
  downloadPdf(bytes, name)
  return 'saved'
}

export function usePdfExport(
  getSheets: () => SheetLayout[],
  getFiles: () => SourceFile[],
  getDecorator: () => DecoratorSpec,
  getLimits: () => PrintLimits,
) {
  const exporting = ref(false)

  async function doExport(scope: 'all' | 'current', currentIndex = 0) {
    if (exporting.value) return
    const allSheets = getSheets()
    const sheets = scope === 'current' ? allSheets.slice(currentIndex, currentIndex + 1) : allSheets
    if (sheets.length === 0) throw new Error('暂无可导出的内容')

    if (sheets.length > getLimits().maxExportPages) {
      throw new Error(
        `单次导出不能超过 ${getLimits().maxExportPages} 页（当前 ${sheets.length} 页），请减少票据或分批导出`,
      )
    }

    const decorator = getDecorator()
    const decor = sheets.map((s) => buildSheetDecor(s, decorator))
    const filePayload = getFiles().map((f) => ({ id: f.id, ext: f.ext, buffer: f.buffer }))

    exporting.value = true
    try {
      const bytes = await ensureWorker().render(sheets, decor, filePayload)
      const name = scope === 'current' ? '发票打印-当前页.pdf' : `发票合并打印-${sheets.length}页.pdf`
      await persistPdf(bytes, name)
    } finally {
      exporting.value = false
    }
  }

  /** 系统分享：把合并 PDF 交给微信/邮件等（不支持的浏览器抛错） */
  async function sharePdf() {
    if (exporting.value) return
    const sheets = getSheets()
    if (sheets.length === 0) throw new Error('暂无可分享的内容')

    const decor = sheets.map((s) => buildSheetDecor(s, getDecorator()))
    const filePayload = getFiles().map((f) => ({ id: f.id, ext: f.ext, buffer: f.buffer }))

    exporting.value = true
    try {
      const bytes = await ensureWorker().render(sheets, decor, filePayload)
      const file = new File([bytes.slice()], `发票合并打印-${sheets.length}页.pdf`, {
        type: 'application/pdf',
      })
      if (!navigator.canShare?.({ files: [file] })) {
        throw new Error('当前浏览器不支持分享文件')
      }
      await navigator.share({ files: [file], title: '发票合并打印' })
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
  ) {
    if (exporting.value) return
    exporting.value = true
    try {
      const bytes = await ensureWorker().renderCalibration(widthPt, heightPt, offsetXPt, offsetYPt)
      await persistPdf(bytes, '发票打印-校准测试页.pdf')
    } finally {
      exporting.value = false
    }
  }

  return { exporting, doExport, sharePdf, printTestPage }
}
