/**
 * 票据导入解码（主线程侧适配层）。
 *
 * 真正的解析（PDF 逐页渲染 + 缩略图）在 print-parse.worker 内完成，
 * 主线程只负责：建 Worker、把 File 句柄递过去、把回传的缩略图 Blob 变成 objectURL。
 *
 * 内存约定：
 * - 文件字节由 Worker 读取后 **转移** 回主线程（SourceFile.buffer）；
 * - 缩略图为 blob: URL，移除文件/清空时必须 revokeObjectURL（见 useFileSet）。
 */

import * as Comlink from 'comlink'
import type { SourceFile, TicketPage } from './types'
import type { ParseWorkerApi } from '@/workers/print-parse.worker'

export const SUPPORTED_EXTS = ['pdf', 'png', 'jpg', 'jpeg']

export interface ParsedPagePayload extends Omit<TicketPage, 'thumbUrl'> {
  thumb: Blob
}

export interface ParsedFilePayload {
  id: string
  name: string
  ext: string
  size: number
  buffer: ArrayBuffer
  pages: ParsedPagePayload[]
}

let worker: Worker | null = null
let workerApi: Comlink.Remote<ParseWorkerApi> | null = null
let workerBroken = false

function resetWorker() {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = null
  workerApi = null
  workerBroken = false
}

function ensureWorker(): Comlink.Remote<ParseWorkerApi> {
  if (!workerApi) {
    const w = new Worker(new URL('@/workers/print-parse.worker.ts', import.meta.url), {
      type: 'module',
    })
    w.onerror = () => {
      workerBroken = true
      resetWorker()
    }
    w.onmessageerror = () => {
      workerBroken = true
      resetWorker()
    }
    worker = w
    workerApi = Comlink.wrap<ParseWorkerApi>(w)
  }
  return workerApi
}

/** 单个文件的解析超时（大 PDF 也远小于此值） */
const PARSE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 解析一个票据文件（PDF / PNG / JPG）。
 * @param forcedId 草稿恢复时复用原文件 id
 */
export async function parseFile(file: File, forcedId?: string): Promise<SourceFile> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new Error(`不支持的文件类型：${file.name}（仅支持 PDF / PNG / JPG）`)
  }
  if (file.size === 0) {
    throw new Error(`文件为空：${file.name}`)
  }

  const api = ensureWorker()
  const created: string[] = []
  try {
    const parsed = await new Promise<ParsedFilePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        workerBroken = true
        resetWorker()
        reject(new Error(`解析超时：${file.name}`))
      }, PARSE_TIMEOUT_MS)
      api.parse(file, forcedId).then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          if (workerBroken) resetWorker()
          reject(new Error(`解析失败：${file.name}（${(err as Error).message || '文件可能已损坏或加密'}）`))
        },
      )
    })

    const pages: TicketPage[] = parsed.pages.map((p) => {
      const url = URL.createObjectURL(p.thumb)
      created.push(url)
      return {
        id: p.id,
        fileId: p.fileId,
        sourcePage: p.sourcePage,
        name: p.name,
        widthPt: p.widthPt,
        heightPt: p.heightPt,
        thumbUrl: url,
      }
    })

    if (pages.length === 0) {
      throw new Error(`文件中没有可用页面：${file.name}`)
    }

    return {
      id: parsed.id,
      name: parsed.name,
      ext: parsed.ext,
      size: parsed.size,
      buffer: parsed.buffer,
      pages,
    }
  } catch (err) {
    // 失败时回收已创建的 objectURL，避免泄漏
    created.forEach((u) => URL.revokeObjectURL(u))
    throw err
  }
}

/** 释放一个票据文件的缩略图 URL */
export function releaseFileThumbs(file: Pick<SourceFile, 'pages'>) {
  for (const p of file.pages) {
    if (p.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(p.thumbUrl)
  }
}
