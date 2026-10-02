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
import {
  needsOrientationFix,
  orientationMatrix,
  readImageInfo,
} from '@/lib/print/imageinfo'
import { createPdfjsWorkerLoadParams } from '@/lib/print/pdfjs-worker-doc'
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
  // pdfjs 锁定 5.4.x：6.x 起使用 Chrome 144+ 才有的 Map.getOrInsertComputed，
  // 旧内核用户全量解析失败。5.x 残留的 new Function 仅在 PS 阴影编译路径，
  // 受 isEvalSupported 守卫，CSP 无 unsafe-eval 时自动回退（见 audit-external.mjs）。
  // Worker 内无 document：参数工厂按字体能力切换 FontFace / 矢量字形回退。
  const task = getDocument(createPdfjsWorkerLoadParams(new Uint8Array(buffer.slice(0))))
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

async function decodeImage(
  id: string,
  fileName: string,
  buffer: ArrayBuffer,
  ext: string,
): Promise<{ pages: ParsedPagePayload[]; buffer: ArrayBuffer }> {
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  // 文件头尺寸 + EXIF 方向（用于判断浏览器是否已按方向解码，以及探测降采样）
  const info = readImageInfo(new Uint8Array(buffer), ext)
  const orientation = info?.exifOrientation ?? null
  const needFix = needsOrientationFix(orientation)

  // 不传 imageOrientation：实测 Chrome 对 Blob 源始终按 EXIF 解码
  // （显式传 'none' 也被忽略），因此拿到的通常已经是"正立"位图。
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime }))
  try {
    // 浏览器是否真的应用了 EXIF：5~8 会用交换宽高暴露出来（2/3/4 无法从尺寸判断，按已应用处理）
    const storedW = info?.width ?? bitmap.width
    const storedH = info?.height ?? bitmap.height
    const dimsSwapped = bitmap.width === storedH && bitmap.height === storedW && storedW !== storedH
    const dimsKept = bitmap.width === storedW && bitmap.height === storedH
    const browserApplied = !needFix ? true : orientation !== null && orientation >= 5 ? dimsSwapped : true
    const browserIgnored = needFix && !browserApplied && dimsKept

    let dispW = needFix && !browserIgnored ? bitmap.width : storedW
    let dispH = needFix && !browserIgnored ? bitmap.height : storedH
    let source: OffscreenCanvas | ImageBitmap = bitmap
    let reencode = false

    if (needFix) {
      if (browserIgnored) {
        // 兜底：浏览器没按 EXIF 处理（老版本或非 Chrome 内核）→ 自己用画布矩阵转正
        const m = orientationMatrix(orientation as number, bitmap.width, bitmap.height)
        const full = new OffscreenCanvas(m.outWidth, m.outHeight)
        const fctx = full.getContext('2d')
        if (!fctx) throw new Error('无法创建画布')
        fctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
        fctx.drawImage(bitmap, 0, 0)
        source = full
        dispW = m.outWidth
        dispH = m.outHeight
      }
      // 统一重新编码：把方向烘焙进像素，PDF 里不再残留 EXIF（否则下游可能二次旋转）
      reencode = true
    }

    // ① 需要时重新编码为"已转正且无 EXIF"的字节（导出使用的就是它）
    let outBuffer = buffer
    if (reencode) {
      const canvas =
        source instanceof OffscreenCanvas
          ? source
          : (() => {
              const c = new OffscreenCanvas(source.width, source.height)
              const cx = c.getContext('2d')
              if (!cx) throw new Error('无法创建画布')
              cx.drawImage(source as ImageBitmap, 0, 0)
              return c
            })()
      const blob =
        ext === 'png'
          ? await canvas.convertToBlob({ type: 'image/png' })
          : await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
      outBuffer = await blob.arrayBuffer()
    }

    // ② 缩略图：始终来自同一份"最终像素"，保证预览与导出一致
    const tw = Math.max(1, Math.min(THUMB_WIDTH, Math.round(dispW)))
    const th = Math.max(1, Math.round((dispH * tw) / dispW))
    const thumbCanvas = new OffscreenCanvas(tw, th)
    const tctx = thumbCanvas.getContext('2d')
    if (!tctx) throw new Error('无法创建画布')
    if (source instanceof OffscreenCanvas) {
      tctx.drawImage(source, 0, 0, dispW, dispH, 0, 0, tw, th)
    } else {
      tctx.drawImage(bitmap, 0, 0, tw, th)
    }

    return {
      buffer: outBuffer,
      pages: [
        {
          id: `${id}:0`,
          fileId: id,
          sourcePage: 0,
          name: fileName,
          widthPt: dispW * PX_TO_PT,
          heightPt: dispH * PX_TO_PT,
          exifOrientation: needFix ? (orientation as number) : null,
          thumb: await thumbBlobFromCanvas(thumbCanvas),
        },
      ],
    }
  } finally {
    bitmap.close()
  }
}

async function parse(file: File, forcedId?: string): Promise<ParsedFilePayload> {
  const ext = extOf(file.name)
  const id = forcedId ?? genId()
  const rawBuffer = await file.arrayBuffer()
  const displayName = file.name.replace(/\.[^.]+$/, '')

  let buffer = rawBuffer
  let pages: ParsedPagePayload[]
  if (ext === 'pdf') {
    pages = await decodePdf(id, displayName, rawBuffer)
  } else {
    const decoded = await decodeImage(id, displayName, rawBuffer, ext)
    pages = decoded.pages
    // 转正时用的是重新编码后的字节（原始字节不再需要，随 transfer 释放）
    buffer = decoded.buffer
  }

  return Comlink.transfer(
    { id, name: file.name, ext, size: file.size, buffer, pages },
    [buffer],
  )
}

export interface RenderPageArgs {
  buffer: ArrayBuffer
  /** pdf / png / jpg / jpeg */
  ext: string
  sourcePage: number
  /** 目标宽度（px），用于原图查看（比缩略图清晰得多） */
  width: number
}

/** 按需渲染一页"原图"（人工校正时需要看清票面号码/金额） */
async function renderPage(args: RenderPageArgs): Promise<Blob> {
  const width = Math.min(2400, Math.max(200, Math.round(args.width) || 1200))
  if (args.ext === 'pdf') {
    const task = getDocument(createPdfjsWorkerLoadParams(new Uint8Array(args.buffer.slice(0))))
    const pdf = await task.promise
    try {
      const page = await pdf.getPage(args.sourcePage + 1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / base.width })
      const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height))
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('无法创建画布')
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    } finally {
      await task.destroy()
    }
  }
  const mime = args.ext === 'png' ? 'image/png' : 'image/jpeg'
  const bitmap = await createImageBitmap(new Blob([args.buffer], { type: mime }))
  try {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round((bitmap.height * w) / bitmap.width))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  } finally {
    bitmap.close()
  }
}

const api = { parse, renderPage }
Comlink.expose(api)
export type ParseWorkerApi = typeof api
