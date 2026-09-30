/**
 * 二维码扫描编排：逐页调用扫描 Worker，管理识别结果、人工补录与重复误判撤销。
 *
 * - 扫描为纯本地操作，不上传票据；
 * - 人工补录/覆盖会标记 manual，重新扫描时跳过；
 * - 未识别（unknown）票据在后续统计时自动重试。
 */

import { computed, reactive, ref, watch } from 'vue'
import * as Comlink from 'comlink'
import { parseQrText, recognizeStatus } from '@/lib/print/qr'
import type { InvoiceMeta, SourceFile, TicketPage } from '@/lib/print/types'
import type { ScanWorkerApi } from '@/workers/print-scan.worker'

/** 扫描 Worker 池：2~3 个并行，CPU 核数自适应 */
const POOL_SIZE = Math.min(3, Math.max(2, (navigator.hardwareConcurrency || 4) - 1))
const pool: { worker: Worker; api: ScanWorkerApi }[] = []

function ensurePool() {
  if (pool.length === 0) {
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const w = new Worker(new URL('@/workers/print-scan.worker.ts', import.meta.url), {
        type: 'module',
      })
      pool.push({ worker: w, api: Comlink.wrap<ScanWorkerApi>(w) })
    }
  }
  return pool
}

export interface ManualInput {
  invoiceNo: string
  invoiceCode?: string | null
  amount?: number | null
  issueDate?: string | null
}

export function useQrScan(
  getPages: () => TicketPage[],
  getFiles: () => SourceFile[],
) {
  const scanning = ref(false)
  const progress = ref({ done: 0, total: 0 })
  const metaMap = reactive(new Map<string, InvoiceMeta>())
  const dupIgnored = ref<string[]>([])

  const metas = computed<InvoiceMeta[]>(() =>
    getPages()
      .map((p) => metaMap.get(p.id))
      .filter((m): m is InvoiceMeta => Boolean(m)),
  )

  const ignoredSet = computed(() => new Set(dupIgnored.value))

  function buildMeta(
    page: TicketPage,
    qrText: string | null,
    engine: 'jsqr' | 'zxing' | null,
  ): InvoiceMeta {
    const parsed = qrText ? parseQrText(qrText) : null
    return {
      pageId: page.id,
      qrText,
      invoiceCode: parsed?.invoiceCode ?? null,
      invoiceNo: parsed?.invoiceNo ?? null,
      amount: parsed?.amount ?? null,
      issueDate: parsed?.issueDate ?? null,
      checkCode: parsed?.checkCode ?? null,
      status: parsed ? recognizeStatus(parsed, qrText) : 'unknown',
      engine,
      manual: false,
    }
  }

  async function scanAll(force = false) {
    if (scanning.value) return
    const pages = getPages()
    if (pages.length === 0) return

    scanning.value = true
    progress.value = { done: 0, total: pages.length }
    try {
      const workers = ensurePool()
      const fileById = new Map(getFiles().map((f) => [f.id, f]))

      interface Task {
        page: TicketPage
        existing: InvoiceMeta | undefined
        f: SourceFile | undefined
      }
      const tasks: Task[] = []
      let done = 0
      for (const page of pages) {
        const existing = metaMap.get(page.id)
        // 已有扫描/补录结果（非未识别）默认跳过；unknown 自动重试
        if (!force && existing && existing.status !== 'unknown') {
          done += 1
          progress.value = { done, total: pages.length }
          continue
        }
        tasks.push({ page, existing, f: fileById.get(page.fileId) })
      }

      let cursor = 0
      const run = async (workerIdx: number) => {
        for (;;) {
          const i = cursor
          cursor += 1
          if (i >= tasks.length) return
          const { page, existing, f } = tasks[i]
          if (f) {
            let ok = false
            // 失败重试一次，第二次换池内另一个 Worker（排除坏 Worker 干扰）
            for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
              const api = workers[(workerIdx + attempt) % workers.length].api
              try {
                const r = await api.scan({
                  ext: f.ext,
                  buffer: f.buffer,
                  sourcePage: page.sourcePage,
                })
                metaMap.set(page.id, buildMeta(page, r.qrText, r.engine))
                ok = true
              } catch {
                /* 下一轮重试 */
              }
            }
            // 单页最终失败：保留旧结果；首次失败则落 unknown，不中断整批
            if (!ok && !existing) metaMap.set(page.id, buildMeta(page, null, null))
          } else if (!existing) {
            metaMap.set(page.id, buildMeta(page, null, null))
          }
          done += 1
          progress.value = { done, total: pages.length }
        }
      }

      await Promise.all(workers.map((_, idx) => run(idx)))
    } finally {
      scanning.value = false
    }
  }

  function applyManual(pageId: string, input: ManualInput) {
    const existing = metaMap.get(pageId)
    const invoiceNo = input.invoiceNo.trim()
    const qrText = existing?.qrText ?? null
    metaMap.set(pageId, {
      pageId,
      qrText,
      invoiceCode: input.invoiceCode?.trim() || null,
      invoiceNo: invoiceNo || null,
      amount: input.amount ?? existing?.amount ?? null,
      issueDate: input.issueDate ?? existing?.issueDate ?? null,
      checkCode: existing?.checkCode ?? null,
      status: invoiceNo ? 'recognized' : qrText ? 'partial' : 'unknown',
      engine: null,
      manual: true,
    })
  }

  function toggleIgnore(pageId: string) {
    if (dupIgnored.value.includes(pageId)) {
      dupIgnored.value = dupIgnored.value.filter((x) => x !== pageId)
    } else {
      dupIgnored.value = [...dupIgnored.value, pageId]
    }
  }

  function hydrate(list: InvoiceMeta[], ignored: string[] = []) {
    list.forEach((m) => metaMap.set(m.pageId, m))
    dupIgnored.value = [...ignored]
  }

  function resetResults() {
    metaMap.clear()
    dupIgnored.value = []
  }

  // 文件删除/清空后清理孤儿结果（按 page id 列表变化触发）
  const pageKey = computed(() => getPages().map((p) => p.id).join('|'))
  watch(pageKey, () => {
    const ids = new Set(getPages().map((p) => p.id))
    for (const key of metaMap.keys()) {
      if (!ids.has(key)) metaMap.delete(key)
    }
    dupIgnored.value = dupIgnored.value.filter((id) => ids.has(id))
  })

  return {
    scanning,
    progress,
    metas,
    metaMap,
    dupIgnored,
    ignoredSet,
    scanAll,
    applyManual,
    toggleIgnore,
    hydrate,
    resetResults,
  }
}
