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
      downloadPdf(
        bytes,
        scope === 'current' ? '发票打印-当前页.pdf' : `发票合并打印-${sheets.length}页.pdf`,
      )
    } finally {
      exporting.value = false
    }
  }

  return { exporting, doExport }
}
