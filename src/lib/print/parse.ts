/**
 * 票据导入解码（浏览器运行时）。
 *
 * - PDF：pdfjs 逐页拆为独立票据项，保留原始字节（导出时矢量嵌入）；
 * - 图片：PNG / JPG，按 96dpi 换算 pt，保留原始字节（导出时图片嵌入）；
 * - 缩略图统一输出 dataURL，由 GC 回收，无需手动 revoke。
 */

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { SourceFile, TicketPage } from './types'

GlobalWorkerOptions.workerSrc = workerUrl as string

export const SUPPORTED_EXTS = ['pdf', 'png', 'jpg', 'jpeg']

const THUMB_WIDTH = 400
const PX_TO_PT = 72 / 96

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function makeThumbCanvas(srcW: number, srcH: number): HTMLCanvasElement {
  const w = Math.min(THUMB_WIDTH, Math.max(1, Math.round(srcW)))
  const h = Math.max(1, Math.round((srcH * w) / srcW))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

async function decodePdf(id: string, fileName: string, buffer: ArrayBuffer): Promise<TicketPage[]> {
  // 传副本：pdfjs 会接管传入数据，原始 buffer 必须保留给导出时矢量嵌入
  const task = getDocument({ data: new Uint8Array(buffer.slice(0)) })
  const pdf = await task.promise
  const pages: TicketPage[] = []

  try {
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1)
      const baseViewport = page.getViewport({ scale: 1 })
      const thumbScale = THUMB_WIDTH / baseViewport.width

      const canvas = makeThumbCanvas(baseViewport.width, baseViewport.height)
      await page.render({
        canvas,
        viewport: page.getViewport({ scale: thumbScale }),
      }).promise

      const suffix = pdf.numPages > 1 ? ` 第${i + 1}页` : ''
      pages.push({
        id: `${id}:${i}`,
        fileId: id,
        sourcePage: i,
        name: `${fileName}${suffix}`,
        widthPt: baseViewport.width,
        heightPt: baseViewport.height,
        thumbUrl: canvas.toDataURL('image/jpeg', 0.72),
      })
    }
  } finally {
    await task.destroy()
  }
  return pages
}

async function decodeImage(id: string, fileName: string, buffer: ArrayBuffer): Promise<TicketPage[]> {
  const blob = new Blob([buffer])
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = makeThumbCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return [
      {
        id: `${id}:0`,
        fileId: id,
        sourcePage: 0,
        name: fileName,
        widthPt: bitmap.width * PX_TO_PT,
        heightPt: bitmap.height * PX_TO_PT,
        thumbUrl: canvas.toDataURL('image/jpeg', 0.72),
      },
    ]
  } finally {
    bitmap.close()
  }
}

export async function parseFile(file: File): Promise<SourceFile> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new Error(`不支持的文件类型：${file.name}（仅支持 PDF / PNG / JPG）`)
  }

  const id = genId()
  const buffer = await file.arrayBuffer()
  const displayName = file.name.replace(/\.[^.]+$/, '')
  const pages = ext === 'pdf' ? await decodePdf(id, displayName, buffer) : await decodeImage(id, displayName, buffer)

  return {
    id,
    name: file.name,
    ext,
    size: file.size,
    buffer,
    pages,
  }
}
