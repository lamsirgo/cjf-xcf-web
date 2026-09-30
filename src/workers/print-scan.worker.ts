/**
 * 发票二维码扫描 Worker（Comlink）。
 *
 * - PDF：pdfjs 按 ~1600px 宽度重新逐页渲染（缩略图分辨率不足以识别二维码）；
 * - 图片：createImageBitmap 解码，超宽降采样；
 * - 双引擎：jsQR（主）→ zxing-wasm（回退）→ 灰度对比度拉伸后 jsQR 兜底；
 * - WASM 显式从本地打包资源加载（覆盖默认的 jsDelivr CDN，零外发）。
 * 位图随扫随弃，不跨页缓存。
 */

import * as Comlink from 'comlink'
import jsQR from 'jsqr'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string

const SCAN_WIDTH = 1600
const IMG_MAX_WIDTH = 2400

export interface ScanArgs {
  /** 小写扩展名：pdf/png/jpg/jpeg */
  ext: string
  buffer: ArrayBuffer
  /** PDF 页索引（从 0 起）；图片传 0 */
  sourcePage: number
}

export interface ScanResult {
  qrText: string | null
  engine: 'jsqr' | 'zxing' | null
}

let zxingPrepared = false
function ensureZxing(): void {
  if (zxingPrepared) return
  // 默认 locateFile 指向 jsDelivr CDN；必须覆盖为同源的本地 WASM
  prepareZXingModule({
    overrides: { locateFile: () => zxingWasmUrl as string },
  })
  zxingPrepared = true
}

function tryJsQR(img: ImageData): string | null {
  const r = jsQR(img.data, img.width, img.height, {
    inversionAttempts: 'attemptBoth',
  })
  return r?.data || null
}

async function tryZxing(img: ImageData): Promise<string | null> {
  ensureZxing()
  const results = await readBarcodes(img, {
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
  })
  return results[0]?.text || null
}

/** 灰度 + 对比度拉伸（双引擎失败后的兜底预处理）。 */
function enhance(img: ImageData): ImageData {
  const src = img.data
  const gray = new Uint8ClampedArray(img.width * img.height)
  let min = 255
  let max = 0
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    const g = Math.round(src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114)
    gray[j] = g
    if (g < min) min = g
    if (g > max) max = g
  }
  const range = Math.max(1, max - min)
  const out = new Uint8ClampedArray(src.length)
  for (let i = 0, j = 0; i < src.length; i += 4, j++) {
    const v = ((gray[j] - min) * 255) / range
    out[i] = v
    out[i + 1] = v
    out[i + 2] = v
    out[i + 3] = 255
  }
  return new ImageData(out, img.width, img.height)
}

async function renderPdfPage(buffer: ArrayBuffer, sourcePage: number): Promise<ImageData> {
  const task = getDocument({ data: new Uint8Array(buffer.slice(0)) })
  const pdf = await task.promise
  try {
    const page = await pdf.getPage(sourcePage + 1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: SCAN_WIDTH / base.width })
    const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建画布')
    await page.render({
      canvas: null,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } finally {
    await task.destroy()
  }
}

async function renderImageFile(ext: string, buffer: ArrayBuffer): Promise<ImageData> {
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime }))
  try {
    const scale = Math.min(1, IMG_MAX_WIDTH / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('无法创建画布')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  } finally {
    bitmap.close()
  }
}

async function scan(args: ScanArgs): Promise<ScanResult> {
  const img =
    args.ext === 'pdf'
      ? await renderPdfPage(args.buffer, args.sourcePage)
      : await renderImageFile(args.ext, args.buffer)

  let text = tryJsQR(img)
  if (text) return { qrText: text, engine: 'jsqr' }

  text = await tryZxing(img)
  if (text) return { qrText: text, engine: 'zxing' }

  text = tryJsQR(enhance(img))
  if (text) return { qrText: text, engine: 'jsqr' }

  return { qrText: null, engine: null }
}

const api = { scan }
Comlink.expose(api)
export type ScanWorkerApi = typeof api
