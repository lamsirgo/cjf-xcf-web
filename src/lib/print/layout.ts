/**
 * 版式排版引擎（纯函数）。
 *
 * 职责：在 A4 页面上划分 rows×cols 单元格，把每张票据等比缩放、居中放入，
 * 超出容量自动续页。禁止拉伸变形。
 */

import {
  A4_HEIGHT_PT,
  A4_WIDTH_PT,
  MM_TO_PT,
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

/** 把 (pageW×pageH) 等比 fit 进 (boxX,boxY,boxW,boxH)，居中。 */
function fitRect(
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  pageW: number,
  pageH: number,
): Rect {
  const scale = Math.min(boxW / pageW, boxH / pageH)
  const width = pageW * scale
  const height = pageH * scale
  return {
    x: boxX + (boxW - width) / 2,
    y: boxY + (boxH - height) / 2,
    width,
    height,
  }
}

export function computeLayout(
  spec: LayoutSpec,
  pages: TicketPage[],
  options: { duplex?: boolean } = {},
): SheetLayout[] {
  if (pages.length === 0) return []

  const rows = Math.max(1, Math.trunc(spec.rows))
  const cols = Math.max(1, Math.trunc(spec.cols))
  const portrait = spec.orientation === 'portrait'
  const sheetWidth = portrait ? A4_WIDTH_PT : A4_HEIGHT_PT
  const sheetHeight = portrait ? A4_HEIGHT_PT : A4_WIDTH_PT

  const margin = Math.max(0, spec.marginMm) * MM_TO_PT
  const cellWidth = (sheetWidth - margin * 2) / cols
  const cellHeight = (sheetHeight - margin * 2) / rows
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
    const cellX = margin + col * cellWidth
    const cellY = margin + row * cellHeight
    const cell = { cellX, cellY, cellWidth, cellHeight }

    if (options.duplex) {
      // 同一票据在单元格内上下各放一份（便于中间裁开），共享同一序号
      const halfH = cellHeight / 2
      const rects = [
        fitRect(cellX, cellY, cellWidth, halfH, page.widthPt, page.heightPt),
        fitRect(cellX, cellY + halfH, cellWidth, halfH, page.widthPt, page.heightPt),
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
        ...fitRect(cellX, cellY, cellWidth, cellHeight, page.widthPt, page.heightPt),
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
