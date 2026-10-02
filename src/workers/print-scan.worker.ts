/**
 * 发票二维码扫描 Worker（Comlink）。
 *
 * - PDF：pdfjs 按 ~1600px 宽度重新逐页渲染（缩略图分辨率不足以识别二维码）；
 * - 图片：createImageBitmap 解码，超宽降采样；
 * - 双引擎：jsQR（主）→ zxing-wasm（回退）→ 灰度对比度拉伸后 jsQR 兜底；
 * - WASM 显式从本地打包资源加载（覆盖默认的 jsDelivr CDN，零外发）。
 *
 * 内存/性能（M2）：
 * - 文件字节按 docId 缓存在本 Worker 内，主线程只在首次调用时发送（避免每页整包克隆）；
 * - PDF 文档按 docId LRU 复用（同一文件只解析一次）；
 * - 缓存被淘汰后主线程会收到 SCAN_BUFFER_MISSING，可补发一次后重试。
 */

import * as Comlink from 'comlink'
import jsQR from 'jsqr'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import { SCAN_BUFFER_MISSING } from '@/lib/print/types'
import { createPdfjsWorkerLoadParams } from '@/lib/print/pdfjs-worker-doc'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import zxingWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string

const SCAN_WIDTH = 1600
const IMG_MAX_WIDTH = 2400
/** 文件字节缓存条数（与 PDF 文档缓存一致） */
const FILE_CACHE_SIZE = 2

export interface ScanArgs {
  /** 小写扩展名：pdf/png/jpg/jpeg */
  ext: string
  /** 文件字节；null 表示使用本 Worker 内的缓存 */
  buffer: ArrayBuffer | null
  /** PDF 页索引（从 0 起）；图片传 0 */
  sourcePage: number
  /** 文件级标识：同一文件复用已打开的 PDF 文档与字节缓存 */
  docId?: string
}

export interface ScanResult {
  qrText: string | null
  engine: 'jsqr' | 'zxing' | null
}

let zxingPrepared = false
let zxingLoading: Promise<void> | null = null
/**
 * wasm 引擎不可用（离线未缓存 / CSP 拦截 / 内存不足）。
 * 一旦失败就不再逐页重试加载：否则每页都会重新发起一次失败的加载，
 * 大批量票据下会拖慢整体扫描。此时退化为 jsQR + 图像增强兜底。
 */
let zxingUnavailable = false

/**
 * 注册 wasm 加载覆盖：zxing-wasm 默认 locateFile 指向 jsDelivr CDN，
 * 必须覆盖为打包进产物的同源 wasm（零外发，CSP connect-src 'self' 兜底）。
 */
function registerZxingOverrides(): void {
  prepareZXingModule({ overrides: { locateFile: () => zxingWasmUrl as string } })
}

/** 预加载识别引擎（D01：主线程据此显示「正在准备识别引擎」） */
async function ready(): Promise<boolean> {
  if (zxingPrepared) return true
  if (zxingUnavailable) return false
  if (!zxingLoading) {
    zxingLoading = Promise.resolve(
      prepareZXingModule({
        overrides: { locateFile: () => zxingWasmUrl as string },
        fireImmediately: true,
      }),
    )
      .then(() => {
        zxingPrepared = true
      })
      .catch((err) => {
        // 加载失败：标记不可用，避免每页重复失败
        zxingUnavailable = true
        zxingLoading = null
        throw err
      })
  }
  await zxingLoading
  return zxingPrepared
}

function tryJsQR(img: ImageData): string | null {
  const r = jsQR(img.data, img.width, img.height, {
    inversionAttempts: 'attemptBoth',
  })
  return r?.data || null
}

async function tryZxing(img: ImageData): Promise<string | null> {
  if (zxingUnavailable) return null
  // 即使未走 ready()，也先确保使用同源 wasm（覆盖库默认 CDN）
  if (!zxingPrepared) registerZxingOverrides()
  try {
    const results = await readBarcodes(img, {
      formats: ['QRCode'],
      maxNumberOfSymbols: 1,
    })
    return results[0]?.text || null
  } catch (err) {
    // wasm 加载/运行失败：本 Worker 内不再重试该引擎（jsQR + enhance 仍可用）
    zxingUnavailable = true
    zxingPrepared = false
    throw err
  }
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

/** PDF 文档缓存：同一文件的连续页面复用同一文档，避免逐页全量解析。LRU。 */
const PDF_CACHE_SIZE = 2
const pdfCache = new Map<string, { task: PDFDocumentLoadingTask; pdf: PDFDocumentProxy }>()
/** 文件字节缓存（主线程只补发缺失文件） */
const fileCache = new Map<string, { ext: string; buffer: ArrayBuffer }>()

async function destroyPdf(docId: string): Promise<void> {
  const hit = pdfCache.get(docId)
  if (!hit) return
  pdfCache.delete(docId)
  try {
    await hit.task.destroy()
  } catch {
    /* ignore */
  }
}

async function evictFile(docId: string): Promise<void> {
  fileCache.delete(docId)
  await destroyPdf(docId)
}

async function cacheFile(docId: string, ext: string, buffer: ArrayBuffer): Promise<void> {
  if (fileCache.has(docId)) fileCache.delete(docId)
  fileCache.set(docId, { ext, buffer })
  if (fileCache.size > FILE_CACHE_SIZE) {
    const oldest = fileCache.keys().next().value as string | undefined
    if (oldest) await evictFile(oldest)
  }
}

async function getCachedPdf(docId: string, buffer: ArrayBuffer): Promise<PDFDocumentProxy> {
  const hit = pdfCache.get(docId)
  if (hit) {
    // 触活：刷新 LRU 顺序
    pdfCache.delete(docId)
    pdfCache.set(docId, hit)
    return hit.pdf
  }
  // Worker 内无 document：参数工厂按字体能力切换 FontFace / 矢量字形回退
  const task = getDocument(createPdfjsWorkerLoadParams(new Uint8Array(buffer.slice(0))))
  const pdf = await task.promise
  pdfCache.set(docId, { task, pdf })
  if (pdfCache.size > PDF_CACHE_SIZE) {
    const oldestKey = pdfCache.keys().next().value as string
    if (oldestKey && oldestKey !== docId) await destroyPdf(oldestKey)
  }
  return pdf
}

async function rasterizePage(pdf: PDFDocumentProxy, sourcePage: number): Promise<ImageData> {
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
}

async function resolveBuffer(args: ScanArgs): Promise<ArrayBuffer> {
  const docId = args.docId
  if (args.buffer) {
    if (docId) await cacheFile(docId, args.ext, args.buffer)
    return args.buffer
  }
  const hit = docId ? fileCache.get(docId) : undefined
  if (hit) {
    // 触活
    fileCache.delete(docId as string)
    fileCache.set(docId as string, hit)
    return hit.buffer
  }
  throw new Error(SCAN_BUFFER_MISSING)
}

async function renderPdfPage(
  buffer: ArrayBuffer,
  sourcePage: number,
  docId?: string,
): Promise<ImageData> {
  if (docId) {
    const pdf = await getCachedPdf(docId, buffer)
    return rasterizePage(pdf, sourcePage)
  }
  // 无 docId（兼容路径）：用完即毁
  const task = getDocument(createPdfjsWorkerLoadParams(new Uint8Array(buffer.slice(0))))
  try {
    const pdf = await task.promise
    return await rasterizePage(pdf, sourcePage)
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
  const buffer = await resolveBuffer(args)
  const img =
    args.ext === 'pdf'
      ? await renderPdfPage(buffer, args.sourcePage, args.docId)
      : await renderImageFile(args.ext, buffer)

  let text = tryJsQR(img)
  if (text) return { qrText: text, engine: 'jsqr' }

  text = await tryZxing(img)
  if (text) return { qrText: text, engine: 'zxing' }

  text = tryJsQR(enhance(img))
  if (text) return { qrText: text, engine: 'jsqr' }

  return { qrText: null, engine: null }
}

/** 释放缓存（文件被删除/清空时由主线程调用） */
async function releaseFiles(ids?: string[]): Promise<void> {
  if (!ids || ids.length === 0) {
    const keys = [...fileCache.keys()]
    fileCache.clear()
    for (const k of keys) await destroyPdf(k)
    for (const k of [...pdfCache.keys()]) await destroyPdf(k)
    return
  }
  for (const id of ids) await evictFile(id)
}

const api = { scan, ready, releaseFiles }
Comlink.expose(api)
export type ScanWorkerApi = typeof api
