/**
 * 二维码文本解析 · 去重判定 · 统计聚合（纯函数，零 DOM/IO）。
 *
 * 支持的二维码原文形态：
 * - 国标增值税发票（含票种码）：
 *   `01,票种(2位),发票代码(10-12位),发票号码(8位),金额,开票日期YYYYMMDD,校验码,随机码`
 *   例：`01,10,011001605111,80100798,64.9,20161018,85342965681116380258`
 *   注：票种码 01=专票 04=普票 10=电子普票 11/14/31 等为电子/卷式票。老解析器漏掉票种码，
 *   会把「发票号码」当金额、把 20 位「校验码」当发票号码，故必须按位序严格识别。
 * - 国标无票种码变体：`01,发票代码,发票号码,金额,日期[,校验码]`
 * - 数电票（全电票）：`01,20位号码,金额,日期` 或带 `fphm=/je=/kprq=` 的 URL、字段化文本
 * - 数电票国标（2024-12 全国推广；票种 31=专票 32=普票，动态二维码）：
 *   `01,票种(2位),,20位号码,金额,日期,,随机码` —— 发票代码字段为空（连续逗号），
 *   金额在第 5 段。老解析器三个分支都匹配不到，号码能靠兜底捞到、金额必丢。
 * - 火车票等无法解析要素的票据：退化为「二维码原文指纹」参与去重
 *
 * 所有正则都不使用 lookbehind（Safari 16.4 以下会在解析期抛 SyntaxError，导致整个模块不可用）。
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

/** 金额上限（元）：超过视为无效，避免把长数字串（票号/校验码）当金额 */
const AMOUNT_MAX = 1e8

/** 金额数字形态：支持千分位（1,234.56）与普通小数（1234.5） */
const MONEY = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`

function pad2(n: string): string {
  return n.length === 1 ? `0${n}` : n
}

/** 日期合法性（含大小月与闰年） */
function validYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  )
}

/**
 * 解析金额：去空格与货币符号；仅在形态符合千分位时去掉逗号；
 * 范围 (0, 1e8]，最多两位小数。
 */
export function toAmount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim().replace(/[￥¥\s]/g, '')
  if (!s) return null
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0 || n > AMOUNT_MAX) return null
  return Math.round(n * 100) / 100
}

/** 8 位日期串（YYYYMMDD）→ YYYY-MM-DD。 */
export function normalizeCompactDate(raw: string | null | undefined): string | null {
  if (!raw || !/^20\d{6}$/.test(raw)) return null
  const year = Number(raw.slice(0, 4))
  const month = Number(raw.slice(4, 6))
  const day = Number(raw.slice(6, 8))
  if (!validYmd(year, month, day)) return null
  return `${raw.slice(0, 4)}-${pad2(raw.slice(4, 6))}-${pad2(raw.slice(6, 8))}`
}

/**
 * 从任意文本提取开票日期（2000-2099）。
 * 逐个候选校验，遇到非法候选继续向后找（不能因票号里的数字串而提前放弃）。
 */
export function findDate(text: string): string | null {
  // ① 带分隔符：2024-03-12 / 2024年3月12日 / 2024.3.12
  const separated = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/g
  for (const m of text.matchAll(separated)) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    if (validYmd(year, month, day)) {
      return `${m[1]}-${pad2(String(month))}-${pad2(String(day))}`
    }
  }
  // ② 紧凑 8 位（必须是独立数字段，避免命中 20 位票号内部）
  const compact = /20\d{6}/g
  for (const m of text.matchAll(compact)) {
    const at = m.index ?? -1
    if (at < 0) continue
    const end = at + m[0].length
    if (at > 0 && /\d/.test(text[at - 1])) continue
    if (end < text.length && /\d/.test(text[end])) continue
    const hit = normalizeCompactDate(m[0])
    if (hit) return hit
  }
  return null
}

/** 校验码：取末 6 位（票面/查验平台通行展示形态）；空串或异常形态返回 null。 */
function checksum(raw: string | undefined): string | null {
  if (!raw) return null
  return /^[0-9A-Za-z]{6,30}$/.test(raw) ? raw.slice(-6) : null
}

/**
 * 逗号分隔的国标二维码：按位序解析。
 * 位序明确时直接返回（不让通用兜底覆盖已经确定正确的字段）。
 */
function parseDelimited(text: string): ParsedInvoice | null {
  const segs = text.split(/[,，]/).map((s) => s.trim())
  if (segs.length < 3 || !/^\d{2}$/.test(segs[0] ?? '')) return null
  const out = { ...EMPTY_PARSED }

  // A. 01,票种(2位),代码(10-12位),号码(8位),金额,日期[,校验码[,随机码]]
  if (
    /^\d{2}$/.test(segs[1] ?? '') &&
    /^\d{10,12}$/.test(segs[2] ?? '') &&
    /^\d{8}$/.test(segs[3] ?? '')
  ) {
    out.invoiceCode = segs[2]
    out.invoiceNo = segs[3]
    out.amount = toAmount(segs[4])
    out.issueDate = normalizeCompactDate(segs[5])
    out.checkCode = checksum(segs[6])
    return out
  }

  // D. 数电票国标：01,票种(2位),空代码,20位号码,金额,日期,空校验码,随机码
  //    票种 31/32 等只验形态（2 位数字），不写死；代码段必须为空，号码必须独立 20 位。
  if (
    /^\d{2}$/.test(segs[1] ?? '') &&
    (segs[2] ?? '') === '' &&
    /^\d{20}$/.test(segs[3] ?? '')
  ) {
    out.invoiceNo = segs[3]
    out.amount = toAmount(segs[4])
    out.issueDate =
      normalizeCompactDate(segs[5]) ?? findDate(segs.slice(3).join(' '))
    out.checkCode = checksum(segs[6])
    return out
  }

  // B. 01,代码(10-12位),号码(8位),金额,日期[,校验码]
  if (/^\d{10,12}$/.test(segs[1] ?? '') && /^\d{8}$/.test(segs[2] ?? '')) {
    out.invoiceCode = segs[1]
    out.invoiceNo = segs[2]
    out.amount = toAmount(segs[3])
    out.issueDate = normalizeCompactDate(segs[4])
    out.checkCode = checksum(segs[5])
    return out
  }

  // C. 数电票：01,20位号码,金额,日期
  if (/^\d{20}$/.test(segs[1] ?? '')) {
    out.invoiceNo = segs[1]
    out.amount = toAmount(segs[2])
    out.issueDate =
      normalizeCompactDate(segs[3]) ?? findDate(segs.slice(2).join(' '))
    return out
  }

  return null
}

/** 独立数字段判定：不是更长数字串的一部分。 */
function isStandaloneDigits(text: string, at: number, len: number): boolean {
  const end = at + len
  if (at > 0 && /\d/.test(text[at - 1])) return false
  return !(end < text.length && /\d/.test(text[end]))
}

/** 字段名 / URL 参数 / 货币符号锚点提取（补齐位序解析之外的形态）。 */
function extractByAnchors(text: string): ParsedInvoice {
  const out = { ...EMPTY_PARSED }

  const code = text.match(/(?:invoiceCode|invoice_code|发票代码)\s*[=:："'\s]*(\d{10,12})/i)
  if (code) out.invoiceCode = code[1]

  const no = text.match(/(?:fphm|invoiceNo|invoice_no|发票号码)\s*[=:："'\s]*(\d{8,20})/i)
  if (no) out.invoiceNo = no[1]
  if (!out.invoiceNo) {
    // 独立的 20 位数电票号码
    for (const m of text.matchAll(/\d{20}/g)) {
      const at = m.index ?? -1
      if (at < 0 || !isStandaloneDigits(text, at, 20)) continue
      out.invoiceNo = m[0]
      break
    }
  }
  if (!out.invoiceNo) {
    // 8 位老号码：仅在有「号码」语义或与 10/12 位代码成对出现时才采信，避免误吞金额
    const m8 = text.match(/(?:invoiceNo|invoice_no|发票号码)\D{0,4}(\d{8})(?!\d)/i)
    if (m8) out.invoiceNo = m8[1]
  }

  const amountRes = [
    new RegExp(
      `(?:价税合计|金额合计|合计金额|总金额|开票金额|金额)\\s*[（(]?[^0-9￥¥]{0,12}[￥¥]?\\s*(${MONEY})`,
    ),
    new RegExp(`(?:^|[?&\\s])(?:je|amount|invoiceAmount)\\s*=\\s*(${MONEY})`, 'i'),
    new RegExp(`[￥¥]\\s*(${MONEY})`),
  ]
  for (const re of amountRes) {
    const m = text.match(re)
    const v = m ? toAmount(m[1]) : null
    if (v !== null) {
      out.amount = v
      break
    }
  }

  out.issueDate = findDate(text)
  return out
}

export function parseQrText(raw: string): ParsedInvoice {
  const text = (raw ?? '').trim()
  if (!text) return { ...EMPTY_PARSED }

  const positional = parseDelimited(text)
  const scanned = extractByAnchors(text)

  return {
    invoiceCode: positional?.invoiceCode ?? scanned.invoiceCode,
    invoiceNo: positional?.invoiceNo ?? scanned.invoiceNo,
    amount: positional?.amount ?? scanned.amount,
    issueDate: positional?.issueDate ?? scanned.issueDate,
    checkCode: positional?.checkCode ?? scanned.checkCode,
  }
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
 * 票据身份键（去重判定用），按可信度分三级：
 * 1. 有发票代码 + 发票号码 → `inv:代码|号码`（代码+号码全局唯一，复扫/重复打印必然同键）；
 * 2. 只有号码（数电票等）→ `inv:?|号码|日期|金额`：必须叠加日期与金额，
 *    否则「不同年份/不同销方的同号票」会被误判为重复（会直接扣减去重金额）；
 * 3. 都无法解析（火车票等）→ 二维码原文指纹。
 *
 * 返回 null 表示无法判定重复。
 * 注：形态 2 中若同一张票的两次识别要素不完全一致（例如其中一张未解析出金额），
 * 不会自动合并；人工补录后重新统计即可对齐。宁可漏判，不可误扣金额。
 */
export function buildIdentityKey(
  p: ParsedInvoice,
  qrText: string | null,
): string | null {
  if (p.invoiceNo) {
    const code = p.invoiceCode?.trim()
    if (code) return `inv:${code}|${p.invoiceNo}`
    const date = p.issueDate ?? '?'
    const amount = p.amount !== null ? p.amount.toFixed(2) : '?'
    return `inv:?|${p.invoiceNo}|${date}|${amount}`
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
