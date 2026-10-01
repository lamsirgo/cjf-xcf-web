/**
 * 版式排版引擎（纯函数）。
 *
 * 职责：在纸张上划分 rows×cols 单元格，把每张票据等比缩放、居中放入，
 * 超出容量自动续页。禁止拉伸变形。
 *
 * 安全边界（均为显式钳制，任何脏配置/脏 localStorage 都不会产生负尺寸或抛错）：
 * - rows/cols ∈ [1, 50]；纸张规格未知时回退 A4；
 * - 页边距不超过纸张短边一半（再留 1pt），保证单元格恒为正；
 * - 开启序号时通过 numberBand 把票面内缩，为序号留出票面外的空白带。
 */

import {
  MM_TO_PT,
  numberBandPt,
  paperSize,
  type LayoutSpec,
  type Placement,
  type SheetLayout,
  type TicketPage,
} from './types'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutOptions {
  duplex?: boolean
  /** 票面外序号带宽度（pt）；>0 时票面四周内缩，保证序号不覆盖票面 */
  numberBand?: number
}

const MAX_GRID = 50
const MAX_OFFSET_MM = 20

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function clampInt(v: unknown, lo: number, hi: number): number {
  return clamp(Math.trunc(num(v, lo)), lo, hi)
}

/** 把 (pageW×pageH) 等比 fit 进 (boxX,boxY,boxW,boxH)，居中。保证结果恒为正。 */
function fitRect(
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  pageW: number,
  pageH: number,
): Rect {
  const w = Math.max(1e-6, boxW)
  const h = Math.max(1e-6, boxH)
  const pw = Math.max(1e-6, pageW)
  const ph = Math.max(1e-6, pageH)
  const scale = Math.min(w / pw, h / ph)
  const width = Math.max(1e-6, pw * scale)
  const height = Math.max(1e-6, ph * scale)
  return {
    x: boxX + (w - width) / 2,
    y: boxY + (h - height) / 2,
    width,
    height,
  }
}

export function computeLayout(
  spec: LayoutSpec,
  pages: TicketPage[],
  options: LayoutOptions = {},
): SheetLayout[] {
  if (pages.length === 0) return []

  const rows = clampInt(spec.rows, 1, MAX_GRID)
  const cols = clampInt(spec.cols, 1, MAX_GRID)
  const portrait = spec.orientation !== 'landscape'

  // 纸张物理尺寸（竖版基准，横版旋转）；未知规格回退 A4
  const base = paperSize(spec)
  const baseW = base.widthMm * MM_TO_PT
  const baseH = base.heightMm * MM_TO_PT
  const sheetWidth = portrait ? baseW : baseH
  const sheetHeight = portrait ? baseH : baseW

  // 页边距上限：短边一半再留 1pt，避免单元格宽度/高度非正
  const maxMarginPt = Math.max(0, Math.min(sheetWidth, sheetHeight) / 2 - 1)
  const margin = clamp(num(spec.marginMm, 0), 0, maxMarginPt / MM_TO_PT) * MM_TO_PT
  // 校准偏移：整体网格平移
  const offsetX = clamp(num(spec.offsetXMm, 0), -MAX_OFFSET_MM, MAX_OFFSET_MM) * MM_TO_PT
  const offsetY = clamp(num(spec.offsetYMm, 0), -MAX_OFFSET_MM, MAX_OFFSET_MM) * MM_TO_PT

  const cellWidth = Math.max(1, (sheetWidth - margin * 2) / cols)
  const cellHeight = Math.max(1, (sheetHeight - margin * 2) / rows)

  // 序号带：不超过单元格的四分之一，票面仍有足够空间
  const requestedBand = Math.max(0, num(options.numberBand, 0))
  const band = clamp(requestedBand, 0, Math.min(cellWidth, cellHeight) / 4)
  const boxW = Math.max(1, cellWidth - band * 2)
  const boxH = Math.max(1, cellHeight - band * 2)
  const capacity = rows * cols

  const sheets: SheetLayout[] = []
  let placements: Placement[] = []
  let indexInSheet = 0
  let seq = 0

  const flush = () => {
    sheets.push({ width: sheetWidth, height: sheetHeight, placements })
    placements = []
    indexInSheet = 0
  }

  for (const page of pages) {
    const row = Math.floor(indexInSheet / cols)
    const col = indexInSheet % cols
    const cellX = margin + offsetX + col * cellWidth
    const cellY = margin + offsetY + row * cellHeight
    const cell = { cellX, cellY, cellWidth, cellHeight }
    const boxX = cellX + band
    const boxY = cellY + band
    const pageW = num(page.widthPt, 595.28)
    const pageH = num(page.heightPt, 841.89)

    if (options.duplex) {
      // 同一票据在单元格内上下各放一份（便于中间裁开），共享同一序号
      const halfH = boxH / 2
      const rects = [
        fitRect(boxX, boxY, boxW, halfH, pageW, pageH),
        fitRect(boxX, boxY + halfH, boxW, halfH, pageW, pageH),
      ]
      for (const rect of rects) {
        placements.push({
          pageId: page.id,
          fileId: page.fileId,
          sourcePage: page.sourcePage,
          seq: seq + 1,
          ...rect,
          ...cell,
        })
      }
    } else {
      placements.push({
        pageId: page.id,
        fileId: page.fileId,
        sourcePage: page.sourcePage,
        seq: seq + 1,
        ...fitRect(boxX, boxY, boxW, boxH, pageW, pageH),
        ...cell,
      })
    }

    seq += 1
    indexInSheet += 1
    if (indexInSheet >= capacity) flush()
  }

  if (placements.length > 0) flush()
  return sheets
}

/** 供调用方（页面/预览）取序号带宽度，保证「排版内缩」与「装饰绘制」用同一口径。 */
export function layoutNumberBand(decor: Pick<Parameters<typeof numberBandPt>[0], 'numbering' | 'numberFontPt'>): number {
  return numberBandPt(decor)
}
