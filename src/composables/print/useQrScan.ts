/**
 * 二维码扫描编排：按文件分组派发到扫描 Worker，管理识别结果、人工补录与重复误判撤销。
 *
 * - 扫描为纯本地操作，不上传票据；
 * - 人工补录/覆盖会标记 manual，重新扫描时跳过；
 * - 未识别（unknown）票据在后续统计时自动重试。
 *
 * 性能与稳健性（M2 / E05）：
 * - 同一文件的所有页交给同一个 Worker，并且文件字节只发送一次（Worker 内缓存）；
 * - 首次扫描前先预热识别引擎（对应「正在准备识别引擎」进度）；
 * - 单页扫描带超时：超时/崩溃的 Worker 会被原地重建，不中断整批；
 * - 失败原因逐页记录并在 UI 呈现，不静默失败。
 */

import { computed, reactive, ref, watch } from 'vue'
import * as Comlink from 'comlink'
import { parseQrText, recognizeStatus } from '@/lib/print/qr'
import { SCAN_BUFFER_MISSING } from '@/lib/print/types'
import type { InvoiceMeta, SourceFile, TicketPage } from '@/lib/print/types'
import type { ScanWorkerApi } from '@/workers/print-scan.worker'

/** 扫描 Worker 池：2~3 个并行，CPU 核数自适应 */
const POOL_SIZE = Math.min(3, Math.max(2, (navigator.hardwareConcurrency || 4) - 1))
/** 单页扫描超时：pdfjs 解析畸形 PDF 可能长时间不返回 */
const SCAN_TIMEOUT_MS = 60_000
/** 识别引擎（WASM）准备超时 */
const ENGINE_TIMEOUT_MS = 120_000

interface PoolEntry {
  worker: Worker
  api: Comlink.Remote<ScanWorkerApi>
  /** 本 Worker 已缓存字节的文件 id */
  sent: Set<string>
  dead: boolean
}

const pool: PoolEntry[] = []

function createEntry(): PoolEntry {
  const worker = new Worker(new URL('@/workers/print-scan.worker.ts', import.meta.url), {
    type: 'module',
  })
  const entry: PoolEntry = {
    worker,
    api: Comlink.wrap<ScanWorkerApi>(worker),
    sent: new Set(),
    dead: false,
  }
  // Worker 崩溃：标记为死亡，下次使用前重建（避免后续调用永久挂起）
  worker.onerror = () => {
    entry.dead = true
  }
  worker.onmessageerror = () => {
    entry.dead = true
  }
  return entry
}

function disposeEntry(entry: PoolEntry) {
  try {
    entry.worker.terminate()
  } catch {
    /* ignore */
  }
  entry.dead = true
}

function ensurePool(): PoolEntry[] {
  if (pool.length === 0) {
    for (let i = 0; i < POOL_SIZE; i += 1) pool.push(createEntry())
  }
  return pool
}

function reviveEntry(idx: number): PoolEntry {
  disposeEntry(pool[idx])
  pool[idx] = createEntry()
  return pool[idx]
}

export interface ManualInput {
  invoiceNo: string
  invoiceCode?: string | null
  amount?: number | null
  issueDate?: string | null
  /** 号码被手工改动时置 true：原校验码不再对应，丢弃而不是继续沿用 */
  dropCheckCode?: boolean
}

export interface ScanFailure {
  pageId: string
  name: string
  reason: string
}

export type ScanPhase = 'idle' | 'engine' | 'scanning'

class ScanTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScanTimeout(`超过 ${Math.round(ms / 1000)} 秒未返回`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export function useQrScan(
  getPages: () => TicketPage[],
  getFiles: () => SourceFile[],
) {
  const scanning = ref(false)
  const phase = ref<ScanPhase>('idle')
  const progress = ref({ done: 0, total: 0 })
  const failures = ref<ScanFailure[]>([])
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

  /** 单页扫描：字节只发一次；缓存被淘汰或 Worker 重建时自动补发 */
  async function scanOne(
    idx: number,
    f: SourceFile,
    page: TicketPage,
  ): Promise<{ qrText: string | null; engine: 'jsqr' | 'zxing' | null }> {
    let lastReason = ''
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let entry = pool[idx]
      if (!entry || entry.dead) entry = reviveEntry(idx)
      const needBuffer = !entry.sent.has(f.id)
      try {
        const result = await withTimeout(
          entry.api.scan({
            ext: f.ext,
            buffer: needBuffer ? f.buffer : null,
            sourcePage: page.sourcePage,
            docId: f.id,
          }),
          SCAN_TIMEOUT_MS,
        )
        entry.sent.add(f.id)
        return result
      } catch (err) {
        const message = (err as Error)?.message || ''
        lastReason = message || lastReason
        if (message.includes(SCAN_BUFFER_MISSING)) {
          // Worker 缓存被淘汰：补发字节后重试
          entry.sent.delete(f.id)
          continue
        }
        if (err instanceof ScanTimeout) {
          // Worker 卡死：重建后重试（换一个 Worker，排除坏实例）
          reviveEntry(idx)
          continue
        }
        // 其它错误（PDF 损坏等）：重建 Worker 并换到下一个重试
        entry.sent.delete(f.id)
        reviveEntry(idx)
        idx = (idx + 1) % Math.max(1, pool.length)
      }
    }
    throw new Error(lastReason ? `扫描失败：${lastReason}` : '扫描失败（引擎未返回结果）')
  }

  async function scanAll(force = false) {
    if (scanning.value) return
    const pages = getPages()
    if (pages.length === 0) return

    scanning.value = true
    failures.value = []
    progress.value = { done: 0, total: pages.length }
    try {
      const workers = ensurePool()
      const fileById = new Map(getFiles().map((f) => [f.id, f]))

      interface Task {
        page: TicketPage
        existing: InvoiceMeta | undefined
        f: SourceFile | undefined
      }
      /** 按文件分组：同一文件的所有页由同一个 Worker 顺序处理（只解析一次） */
      const groups: Task[][] = []
      const groupIndex = new Map<string, number>()
      let done = 0

      for (const page of pages) {
        const existing = metaMap.get(page.id)
        // 人工补录/覆盖的结果永不自动覆盖（包括「重新扫描」）：
        // 否则用户手工校正过的号码/金额会被引擎结果静默回退。
        // 需要回到引擎结果时，用「清空识别结果」后再扫描。
        if (existing?.manual) {
          done += 1
          progress.value = { done, total: pages.length }
          continue
        }
        // 已有扫描结果（非未识别）默认跳过；unknown 自动重试
        if (!force && existing && existing.status !== 'unknown') {
          done += 1
          progress.value = { done, total: pages.length }
          continue
        }
        const f = fileById.get(page.fileId)
        const key = f ? f.id : `__missing__${page.fileId}`
        let gi = groupIndex.get(key)
        if (gi === undefined) {
          gi = groups.length
          groups.push([])
          groupIndex.set(key, gi)
        }
        groups[gi].push({ page, existing, f })
      }

      // 预热识别引擎（首次使用需加载 WASM，界面显示「正在准备识别引擎」）
      const needScan = groups.length > 0
      if (needScan) {
        phase.value = 'engine'
        // 只预热真正会被用到的 Worker（每个 Worker 都会独立加载 ~1MB wasm）
        const warmCount = Math.min(workers.length, groups.length)
        await Promise.all(
          Array.from({ length: warmCount }, async (_v, i) => {
            try {
              await withTimeout(pool[i].api.ready(), ENGINE_TIMEOUT_MS)
            } catch {
              // 引擎准备失败：重建该 Worker，识别时仍会走 jsQR 主引擎
              reviveEntry(i)
            }
          }),
        )
        phase.value = 'scanning'
      }

      let groupCursor = 0
      const run = async (workerIdx: number) => {
        for (;;) {
          const gi = groupCursor
          groupCursor += 1
          if (gi >= groups.length) return
          const group = groups[gi]
          for (const { page, existing, f } of group) {
            if (f) {
              try {
                const r = await scanOne(workerIdx, f, page)
                metaMap.set(page.id, buildMeta(page, r.qrText, r.engine))
              } catch (err) {
                const reason = (err as Error).message || '未知错误'
                failures.value = [
                  ...failures.value,
                  { pageId: page.id, name: f.name + (page.sourcePage > 0 ? ` 第${page.sourcePage + 1}页` : ''), reason },
                ]
                // 单页失败：保留旧结果；首次失败则落 unknown，不中断整批
                if (!existing) metaMap.set(page.id, buildMeta(page, null, null))
              }
            } else if (!existing) {
              metaMap.set(page.id, buildMeta(page, null, null))
            }
            done += 1
            progress.value = { done, total: pages.length }
          }
        }
      }

      await Promise.all(workers.map((_, idx) => run(idx)))
    } finally {
      scanning.value = false
      phase.value = 'idle'
    }
  }

  function applyManual(pageId: string, input: ManualInput) {
    const existing = metaMap.get(pageId)
    const invoiceNo = input.invoiceNo.trim()
    const qrText = existing?.qrText ?? null
    const invoiceCode = input.invoiceCode?.trim() || null
    const amount = input.amount ?? existing?.amount ?? null
    const issueDate = input.issueDate ?? existing?.issueDate ?? null
    const hasAny = Boolean(invoiceNo || invoiceCode || amount !== null || issueDate || qrText)
    metaMap.set(pageId, {
      pageId,
      qrText,
      invoiceCode,
      invoiceNo: invoiceNo || null,
      amount,
      issueDate,
      checkCode: input.dropCheckCode ? null : (existing?.checkCode ?? null),
      status: invoiceNo ? 'recognized' : hasAny ? 'partial' : 'unknown',
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
    failures.value = []
  }

  /** 文件被删除/清空后释放 Worker 缓存的字节 */
  function releaseFiles(ids?: string[]) {
    for (const entry of pool) {
      if (!entry || entry.dead) continue
      if (ids && ids.length > 0) ids.forEach((id) => entry.sent.delete(id))
      else entry.sent.clear()
      entry.api.releaseFiles(ids).catch(() => {
        entry.dead = true
      })
    }
  }

  // 文件删除/清空后清理孤儿结果（按 page id 列表变化触发）
  const pageKey = computed(() => getPages().map((p) => p.id).join('|'))
  watch(pageKey, () => {
    const ids = new Set(getPages().map((p) => p.id))
    for (const key of metaMap.keys()) {
      if (!ids.has(key)) metaMap.delete(key)
    }
    dupIgnored.value = dupIgnored.value.filter((id) => ids.has(id))
    failures.value = failures.value.filter((f) => ids.has(f.pageId))
  })

  return {
    scanning,
    phase,
    progress,
    failures,
    metas,
    metaMap,
    dupIgnored,
    ignoredSet,
    scanAll,
    applyManual,
    toggleIgnore,
    hydrate,
    resetResults,
    releaseFiles,
  }
}
