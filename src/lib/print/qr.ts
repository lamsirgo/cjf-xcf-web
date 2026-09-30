/**
 * 二维码文本解析 · 去重判定 · 统计聚合（纯函数，零 DOM/IO）。
 *
 * 支持的二维码原文形态：
 * - 国标增值税发票：`01,发票代码,发票号码,金额,开票日期,校验码,...`（逗号分隔）；
 * - 数电票 / URL / 结构化文本：按字段名与数字模式提取（20 位号码、金额、日期）；
 * - 火车票等无法解析要素的票据：退化为「二维码原文指纹」参与去重。
 */

import type { InvoiceMeta, RecognizeStatus } from './types'

export interface ParsedInvoice {
  invoiceCode: string | null
  invoiceNo: string | null
  amount: number | null
  issueDate: string | null
  checkCode: string | null
}

const EMPTY_PARSED: ParsedInvoice = {
  invoiceCode: null,
  invoiceNo: null,
  amount: null,
  issueDate: null,
  checkCode: null,
}

function pad2(n: string): string {
  return n.length === 1 ? `0${n}` : n
}

/** 解析金额字符串；范围 0.01 ~ 100,000,000，其余视为无效。 */
function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 1e8) return null
  return Math.round(n * 100) / 100
}

/** 8 位日期串（YYYYMMDD）→ YYYY-MM-DD。 */
function normalizeCompactDate(raw: string | undefined): string | null {
  if (!raw || !/^20\d{6}$/.test(raw)) return null
  const y = raw.slice(0, 4)
  const m = Number(raw.slice(4, 6))
  const d = Number(raw.slice(6, 8))
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${y}-${pad2(raw.slice(4, 6))}-${pad2(raw.slice(6, 8))}`
}

/** 从任意文本提取日期（2000-2099）。 */
function extractDate(text: string): string | null {
  const m = text.match(/(20\d{2})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})/)
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
}

export function parseQrText(raw: string): ParsedInvoice {
  const text = raw.trim()
  if (!text) return { ...EMPTY_PARSED }

  let invoiceCode: string | null = null
  let invoiceNo: string | null = null
  let amount: number | null = null
  let issueDate: string | null = null
  let checkCode: string | null = null

  // ① 国标逗号格式：01,代码(10-12位),号码(8位),金额,YYYYMMDD[,校验码...]
  const segs = text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (/^\d{2}$/.test(segs[0] ?? '') && segs.length >= 5) {
    if (/^\d{10,12}$/.test(segs[1])) invoiceCode = segs[1]
    if (/^\d{8}$/.test(segs[2])) invoiceNo = segs[2]
    amount = parseAmount(segs[3])
    issueDate = normalizeCompactDate(segs[4])
    if (segs[5] && /^[0-9A-Za-z]{6,30}$/.test(segs[5])) checkCode = segs[5].slice(-6)
  }

  // ② 通用字段提取
  if (!invoiceNo) {
    // 20 位数电票号码（独立连续数字）
    const m20 = text.match(/(?<!\d)(\d{20})(?!\d)/)
    if (m20) invoiceNo = m20[1]
  }
  if (!invoiceNo) {
    // fphm= / 发票号码：8-20 位
    const mNo = text.match(/(?:fphm|invoiceNo|发票号码)[=:"\s]*([0-9]{8,20})/i)
    if (mNo) invoiceNo = mNo[1]
  }
  if (!invoiceCode) {
    const mCode = text.match(/(?:invoiceCode|发票代码)[=:"\s]*([0-9]{10,12})/i)
    if (mCode) invoiceCode = mCode[1]
  }
  if (amount === null) {
    // 价税合计（小写）后的金额；其次"金额合计/合计金额/金额"；最后裸 ¥/￥
    const mTotal = text.match(
      /(?:价税合计|金额合计|合计金额|总金额|金额)[^0-9￥¥]{0,14}[￥¥]?\s*([0-9]+(?:\.[0-9]{1,2})?)/,
    )
    if (mTotal) amount = parseAmount(mTotal[1])
  }
  if (amount === null) {
    const mCur = text.match(/[￥¥]\s*([0-9]+(?:\.[0-9]{1,2})?)/)
    if (mCur) amount = parseAmount(mCur[1])
  }
  if (!issueDate) issueDate = extractDate(text)

  return { invoiceCode, invoiceNo, amount, issueDate, checkCode }
}

/** 识别状态：无二维码原文 → unknown；有原文且解析出号码 → recognized；否则 partial。 */
export function recognizeStatus(p: ParsedInvoice, qrText: string | null): RecognizeStatus {
  if (!qrText) return 'unknown'
  return p.invoiceNo ? 'recognized' : 'partial'
}

/** djb2 字符串指纹（去重场景足够，非加密用途）。 */
function fingerprint(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

/**
 * 票据身份键：优先「发票代码+号码」，其次「号码」，再次「二维码原文指纹」。
 * 返回 null 表示无法判定重复。
 */
export function buildIdentityKey(
  p: ParsedInvoice,
  qrText: string | null,
): string | null {
  if (p.invoiceNo) {
    return p.invoiceCode ? `no:${p.invoiceCode}_${p.invoiceNo}` : `no:${p.invoiceNo}`
  }
  if (qrText) return `qr:${fingerprint(qrText)}`
  return null
}

function metaToParsed(m: InvoiceMeta): ParsedInvoice {
  return {
    invoiceCode: m.invoiceCode,
    invoiceNo: m.invoiceNo,
    amount: m.amount,
    issueDate: m.issueDate,
    checkCode: m.checkCode,
  }
}

export interface DuplicateGroup {
  key: string
  /** 组内第一张（非撤销）票据 pageId，视为原始票 */
  representativeId: string
  pageIds: string[]
}

export interface DupResult {
  /** 被标记为重复副本的 pageId（组内除代表外的全部） */
  dupPageIds: Set<string>
  groups: DuplicateGroup[]
}

/**
 * 去重判定：同身份键 ≥2 张即判重复，每组首张为原始、其余标记。
 * 仅标记不删除；ignored 中的票据（用户已撤销误判）不参与分组。
 */
export function computeDuplicates(
  metas: InvoiceMeta[],
  ignored: ReadonlySet<string>,
): DupResult {
  const grouped = new Map<string, string[]>()
  for (const m of metas) {
    if (ignored.has(m.pageId)) continue
    const key = buildIdentityKey(metaToParsed(m), m.qrText)
    if (!key) continue
    const arr = grouped.get(key)
    if (arr) arr.push(m.pageId)
    else grouped.set(key, [m.pageId])
  }

  const dupPageIds = new Set<string>()
  const groups: DuplicateGroup[] = []
  for (const [key, ids] of grouped) {
    if (ids.length < 2) continue
    ids.slice(1).forEach((id) => dupPageIds.add(id))
    groups.push({ key, representativeId: ids[0], pageIds: ids })
  }
  return { dupPageIds, groups }
}

export interface InvoiceStats {
  total: number
  recognized: number
  partial: number
  unknown: number
  /** 已识别率 0~1（recognized / total） */
  coverage: number
  /** 全部有金额票据的金额合计 */
  amountTotal: number
  amountCount: number
  /** 去重后金额：重复副本金额从合计中扣除（每组只算一张） */
  uniqueAmount: number
  dupGroupCount: number
  /** 被标记为重复副本的票据张数 */
  dupTicketCount: number
}

export function computeStats(metas: InvoiceMeta[], dup: DupResult): InvoiceStats {
  const total = metas.length
  let recognized = 0
  let partial = 0
  let unknown = 0
  let amountTotal = 0
  let amountCount = 0

  for (const m of metas) {
    if (m.status === 'recognized') recognized++
    else if (m.status === 'partial') partial++
    else unknown++
    if (m.amount !== null) {
      amountTotal += m.amount
      amountCount++
    }
  }

  let dupAmount = 0
  for (const m of metas) {
    if (dup.dupPageIds.has(m.pageId) && m.amount !== null) dupAmount += m.amount
  }

  return {
    total,
    recognized,
    partial,
    unknown,
    coverage: total > 0 ? recognized / total : 0,
    amountTotal: Math.round(amountTotal * 100) / 100,
    amountCount,
    uniqueAmount: Math.round((amountTotal - dupAmount) * 100) / 100,
    dupGroupCount: dup.groups.length,
    dupTicketCount: dup.dupPageIds.size,
  }
}
