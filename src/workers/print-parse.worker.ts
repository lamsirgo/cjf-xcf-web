/**
 * 票据解码 Worker（M5）：PDF 逐页拆分为独立票据 + 生成缩略图，全部离开主线程。
 *
 * - 传入 File 句柄（结构化克隆不复制字节），Worker 内读取并**转移**字节回主线程，
 *   主线程既不重复读盘也不额外复制；
 * - 缩略图以 Blob 形式回传（主线程 createObjectURL），避免 base64 字符串膨胀；
 * - pdfjs 在 Worker 内运行，导入 100 页 PDF 也不再卡死界面。
 */

import * as Comlink from 'comlink'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ParsedFilePayload, ParsedPagePayload } from '@/lib/print/parse'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string

const THUMB_WIDTH = 900
const PX_TO_PT = 72 / 96

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function extOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

async function thumbBlobFromCanvas(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
}

async function decodePdf(id: string, fileName: string, buffer: ArrayBuffer): Promise<ParsedPagePayload[]> {
  // 传副本：pdfjs 会接管（transfer）传入数据，原始 buffer 必须保留给导出时矢量嵌入
  // pdfjs 6 已移除 eval/new Function 路径（构建产物中零命中，见 scripts/audit-external.mjs），
  // 因此处理不可信 PDF 时不需要 CSP 的 unsafe-eval。
  const task = getDocument({ data: new Uint8Array(buffer.slice(0)) })
  const pdf = await task.promise
  const pages: ParsedPagePayload[] = []
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1)
      const baseViewport = page.getViewport({ scale: 1 })
      const w = Math.max(1, Math.min(THUMB_WIDTH, Math.round(baseViewport.width)))
      const h = Math.max(1, Math.round((baseViewport.height * w) / baseViewport.width))
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('无法创建画布')
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: page.getViewport({ scale: w / baseViewport.width }),
      }).promise
      const suffix = pdf.numPages > 1 ? ` 第${i + 1}页` : ''
      pages.push({
        id: `${id}:${i}`,
        fileId: id,
        sourcePage: i,
        name: `${fileName}${suffix}`,
        widthPt: baseViewport.width,
        heightPt: baseViewport.height,
        thumb: await thumbBlobFromCanvas(canvas),
      })
    }
  } finally {
    await task.destroy()
  }
  return pages
}

async function decodeImage(id: string, fileName: string, buffer: ArrayBuffer, ext: string): Promise<ParsedPagePayload[]> {
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime }))
  try {
    const w = Math.max(1, Math.min(THUMB_WIDTH, Math.round(bitmap.width)))
    const h = Math.max(1, Math.round((bitmap.height * w) / bitmap.width))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return [
      {
        id: `${id}:0`,
        fileId: id,
        sourcePage: 0,
        name: fileName,
        widthPt: bitmap.width * PX_TO_PT,
        heightPt: bitmap.height * PX_TO_PT,
        thumb: await thumbBlobFromCanvas(canvas),
      },
    ]
  } finally {
    bitmap.close()
  }
}

/**
 * @param forcedId 草稿恢复时复用原文件 id，保证 pageId 稳定、识别结果可匹配
 */
async function parse(file: File, forcedId?: string): Promise<ParsedFilePayload> {
  const ext = extOf(file.name)
  const id = forcedId ?? genId()
  const buffer = await file.arrayBuffer()
  const displayName = file.name.replace(/\.[^.]+$/, '')
  const pages =
    ext === 'pdf'
      ? await decodePdf(id, displayName, buffer)
      : await decodeImage(id, displayName, buffer, ext)

  return Comlink.transfer(
    { id, name: file.name, ext, size: file.size, buffer, pages },
    [buffer],
  )
}

const api = { parse }
Comlink.expose(api)
export type ParseWorkerApi = typeof api
