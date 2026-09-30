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

let worker: Worker | null = null
let workerApi: ScanWorkerApi | null = null

function ensureWorker(): ScanWorkerApi {
  if (!workerApi) {
    worker = new Worker(new URL('@/workers/print-scan.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerApi = Comlink.wrap<ScanWorkerApi>(worker)
  }
  return workerApi
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
      const api = ensureWorker()
      const fileById = new Map(getFiles().map((f) => [f.id, f]))
      for (const page of pages) {
        const existing = metaMap.get(page.id)
        // 已有扫描/补录结果（非未识别）默认跳过；unknown 自动重试
        if (!force && existing && existing.status !== 'unknown') {
          progress.value = { done: progress.value.done + 1, total: pages.length }
          continue
        }
        const f = fileById.get(page.fileId)
        if (f) {
          try {
            const r = await api.scan({
              ext: f.ext,
              buffer: f.buffer,
              sourcePage: page.sourcePage,
            })
            metaMap.set(page.id, buildMeta(page, r.qrText, r.engine))
          } catch {
            // 单页异常：保留旧结果；首次失败则落 unknown，不中断整批
            if (!existing) metaMap.set(page.id, buildMeta(page, null, null))
          }
        }
        progress.value = { done: progress.value.done + 1, total: pages.length }
      }
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
