/**
 * 合并 PDF 渲染 Worker：导出不阻塞主线程。
 *
 * 内存策略（M3）：
 * - 文件字节由主线程**首次使用时**克隆进来，之后按 fileId 缓存在 Worker 内，
 *   重复导出不再整包克隆；
 * - 渲染结果用 Comlink.transfer 转移 ArrayBuffer，避免再复制一份 PDF；
 * - 缓存由主线程通过 clearFiles() 显式释放（清空文件/重置 Worker 时）。
 */

import * as Comlink from 'comlink'
import type { DecorItem } from '@/lib/print/decor'
import { renderCalibrationPdf, renderPdf } from '@/lib/print/render'
import type { SheetLayout } from '@/lib/print/types'

type FileEntry = { id: string; name: string; ext: string; buffer: ArrayBuffer }

/** 文件字节缓存：主线程只补发缺失的文件 */
const fileCache = new Map<string, FileEntry>()

const api = {
  async render(
    sheets: SheetLayout[],
    decor: DecorItem[][],
    files: FileEntry[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Uint8Array> {
    for (const f of files) {
      if (f && f.id && f.buffer) fileCache.set(f.id, f)
    }
    const missing = new Set<string>()
    for (const s of sheets) for (const p of s.placements) if (!fileCache.has(p.fileId)) missing.add(p.fileId)
    if (missing.size > 0) {
      throw new Error(`渲染缺少文件字节：${[...missing].join(', ')}`)
    }
    const bytes = await renderPdf({
      sheets,
      decor,
      files: [...fileCache.values()],
      onProgress,
    })
    // 转移而非克隆（Comlink.transfer）
    return Comlink.transfer(bytes, [bytes.buffer])
  },

  async renderCalibration(
    widthPt: number,
    heightPt: number,
    offsetXPt: number,
    offsetYPt: number,
  ): Promise<Uint8Array> {
    const bytes = await renderCalibrationPdf({ widthPt, heightPt, offsetXPt, offsetYPt })
    return Comlink.transfer(bytes, [bytes.buffer])
  },

  /** 释放文件字节缓存（清空文件/切换文件集时由主线程调用） */
  clearFiles(ids?: string[]): void {
    if (!ids || ids.length === 0) fileCache.clear()
    else for (const id of ids) fileCache.delete(id)
  },

  /** 供主线程查询已缓存的文件 id（调试/自检用） */
  cachedFileIds(): string[] {
    return [...fileCache.keys()]
  },
}

Comlink.expose(api)

export type PrintWorkerApi = typeof api
