/**
 * 标记装饰（纯函数）。
 *
 * 输出与渲染无关的图元（实线线段 / 白色填充块 / 文本），由 canvas 预览与
 * pdf-lib 导出各自解释，保证两条路径装饰一致。虚线在此展开为短实线段。
 *
 * 合规：只在票面外围画序号与裁切标记，不接触票面内容。
 */

import type { DecoratorSpec, Placement, SheetLayout } from './types'

export interface DecorLine {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
}
export interface DecorFill {
  kind: 'fill'
  x: number
  y: number
  width: number
  height: number
}
export interface DecorText {
  kind: 'text'
  x: number
  y: number
  text: string
}
export type DecorItem = DecorLine | DecorFill | DecorText

const DASH_LEN = 3.2
const DASH_GAP = 2.6
const SEQ_FONT_PT = 10

/** 把一条直线展开为虚线短段。 */
function dashedLine(x1: number, y1: number, x2: number, y2: number): DecorLine[] {
  const horizontal = y1 === y2
  const dx = Math.sign(x2 - x1)
  const dy = Math.sign(y2 - y1)
  const length = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)

  const out: DecorLine[] = []
  for (let t = 0; t < length; t += DASH_LEN + DASH_GAP) {
    const a = t
    const b = Math.min(t + DASH_LEN, length)
    out.push(
      horizontal
        ? { kind: 'line', x1: x1 + dx * a, y1, x2: x1 + dx * b, y2: y1 }
        : { kind: 'line', x1, y1: y1 + dy * a, x2, y2: y1 + dy * b },
    )
  }
  return out
}

/** 同 sheet 内按票据页分组（duplex 一张票有两个 placement）。 */
function groupPlacements(sheet: SheetLayout): Map<string, Placement[]> {
  const map = new Map<string, Placement[]>()
  for (const p of sheet.placements) {
    const list = map.get(p.pageId)
    if (list) list.push(p)
    else map.set(p.pageId, [p])
  }
  return map
}

/** 四角 L 形裁剪线。 */
function cornerMarks(bx: number, by: number, bw: number, bh: number): DecorLine[] {
  const len = Math.min(12, bw * 0.12, bh * 0.12)
  const defs: Array<[number, number, number, number]> = [
    [bx, by, 1, 1],
    [bx + bw, by, -1, 1],
    [bx, by + bh, 1, -1],
    [bx + bw, by + bh, -1, -1],
  ]
  const out: DecorLine[] = []
  for (const [cx, cy, sx, sy] of defs) {
    out.push({ kind: 'line', x1: cx, y1: cy, x2: cx + sx * len, y2: cy })
    out.push({ kind: 'line', x1: cx, y1: cy, x2: cx, y2: cy + sy * len })
  }
  return out
}

export function buildSheetDecor(sheet: SheetLayout, spec: DecoratorSpec): DecorItem[] {
  const items: DecorItem[] = []

  for (const group of groupPlacements(sheet).values()) {
    const first = group[0]
    // 装饰外框：双联以单元格为界，单份以票据 fit 后矩形为界
    const bx = spec.duplex ? first.cellX : first.x
    const by = spec.duplex ? first.cellY : first.y
    const bw = spec.duplex ? first.cellWidth : first.width
    const bh = spec.duplex ? first.cellHeight : first.height

    if (spec.divider === 'dashed') {
      items.push(...dashedLine(bx, by, bx + bw, by))
      items.push(...dashedLine(bx, by + bh, bx + bw, by + bh))
      items.push(...dashedLine(bx, by, bx, by + bh))
      items.push(...dashedLine(bx + bw, by, bx + bw, by + bh))
    } else if (spec.divider === 'line') {
      items.push(...cornerMarks(bx, by, bw, bh))
    }

    if (spec.duplex) {
      items.push(...dashedLine(bx, by + bh / 2, bx + bw, by + bh / 2))
    }

    if (spec.numbering) {
      const text = String(first.seq)
      // 序号底块（白底，避免与票面线条混淆）；宽按位数粗略估算
      const blockW = 6 + text.length * 6
      items.push({
        kind: 'fill',
        x: bx + 1.5,
        y: by + 1.5,
        width: blockW,
        height: SEQ_FONT_PT + 3,
      })
      items.push({ kind: 'text', x: bx + 3, y: by + 1.5 + SEQ_FONT_PT, text })
    }
  }

  return items
}
