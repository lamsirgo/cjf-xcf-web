/**
 * 标记装饰（纯函数）。
 *
 * 输出与渲染无关的图元（线段 / 填充块 / 文本），由 canvas 预览与
 * pdf-lib 导出各自解释，保证两条路径装饰一致。虚线用原生 dash 参数表达
 * （不再展开成数百段实线，避免大文档产生十万级图元）。
 *
 * 合规（硬约束）：
 * - 序号只画在「单元格内、票面外」的空白带里；带内放不下时宁可不画，绝不覆盖票面；
 * - 分隔/裁切标记一律画在单元格边界上（票面被 numberBand 内缩，因此不进入票面）；
 * - 不提供任何像素级修改票面的能力。
 */

import {
  type DecoratorSpec,
  type Placement,
  type RGB,
  type SheetLayout,
} from './types'

export type DashSpec = [number, number]

export interface DecorLine {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  /** null = 实线 */
  dash: DashSpec | null
  color: RGB
  thickness: number
}

export interface DecorFill {
  kind: 'fill'
  x: number
  y: number
  width: number
  height: number
  color: RGB
}

export interface DecorText {
  kind: 'text'
  x: number
  y: number
  text: string
  size: number
  color: RGB
}

export type DecorItem = DecorLine | DecorFill | DecorText

const MARK_COLOR: RGB = [0.13, 0.13, 0.13]
const LINE_THICKNESS = 0.6
const CORNER_MAX_PT = 12

/** 同 sheet 内按票据页分组（duplex 一张票有两个 placement）。 */
function groupPlacements(sheet: SheetLayout): Placement[][] {
  const map = new Map<string, Placement[]>()
  for (const p of sheet.placements) {
    const list = map.get(p.pageId)
    if (list) list.push(p)
    else map.set(p.pageId, [p])
  }
  return [...map.values()]
}

/** 四角 L 形裁剪线（沿单元格边界向内）。 */
function cornerMarks(bx: number, by: number, bw: number, bh: number, color: RGB): DecorLine[] {
  const len = Math.min(CORNER_MAX_PT, bw * 0.12, bh * 0.12)
  if (!(len > 0)) return []
  const defs: Array<[number, number, number, number]> = [
    [bx, by, 1, 1],
    [bx + bw, by, -1, 1],
    [bx, by + bh, 1, -1],
    [bx + bw, by + bh, -1, -1],
  ]
  const out: DecorLine[] = []
  for (const [cx, cy, sx, sy] of defs) {
    out.push({ kind: 'line', x1: cx, y1: cy, x2: cx + sx * len, y2: cy, dash: null, color, thickness: LINE_THICKNESS })
    out.push({ kind: 'line', x1: cx, y1: cy, x2: cx, y2: cy + sy * len, dash: null, color, thickness: LINE_THICKNESS })
  }
  return out
}

/** 单元格矩形的四边（原生虚线）。 */
function borderLines(
  bx: number,
  by: number,
  bw: number,
  bh: number,
  dash: DashSpec | null,
  color: RGB,
): DecorLine[] {
  const mk = (x1: number, y1: number, x2: number, y2: number): DecorLine => ({
    kind: 'line',
    x1,
    y1,
    x2,
    y2,
    dash,
    color,
    thickness: LINE_THICKNESS,
  })
  return [
    mk(bx, by, bx + bw, by),
    mk(bx, by + bh, bx + bw, by + bh),
    mk(bx, by, bx, by + bh),
    mk(bx + bw, by, bx + bw, by + bh),
  ]
}

/**
 * 序号落点：只允许落在「票面顶边到单元格顶边」的空白带内；
 * 顶带不足则尝试左侧空白带；都不足则不画（绝不覆盖票面）。
 */
function numberingItem(
  group: Placement[],
  text: string,
  size: number,
  color: RGB,
): DecorText | null {
  const first = group[0]
  const cellX = first.cellX
  const cellY = first.cellY
  const topMost = Math.min(...group.map((p) => p.y))
  const leftMost = Math.min(...group.map((p) => p.x))
  const topStrip = topMost - cellY
  const leftStrip = leftMost - cellX

  // ① 顶带：整行文字都在票面上方
  const needTop = size * 0.95 + 1.5
  if (topStrip >= needTop) {
    return {
      kind: 'text',
      x: cellX + 3,
      y: cellY + topStrip - 2,
      text,
      size,
      color,
    }
  }

  // ② 左带：整段文字都在票面左侧
  const needLeft = text.length * size * 0.62 + 4
  if (leftStrip >= needLeft) {
    return {
      kind: 'text',
      x: cellX + 2,
      y: topMost + size,
      text,
      size,
      color,
    }
  }

  return null
}

export function buildSheetDecor(sheet: SheetLayout, spec: DecoratorSpec): DecorItem[] {
  const items: DecorItem[] = []
  const color: RGB = spec.markColor ?? MARK_COLOR
  const dashLen = Math.max(1, Number.isFinite(spec.dashLen) ? spec.dashLen : 3.2)
  const dashGap = Math.max(0.5, Number.isFinite(spec.dashGap) ? spec.dashGap : 2.6)
  const dashed: DashSpec = [dashLen, dashGap]
  const fontPt = Math.min(24, Math.max(5, Number.isFinite(spec.numberFontPt) ? spec.numberFontPt : 10))

  for (const group of groupPlacements(sheet)) {
    const first = group[0]
    // 裁切/分隔标记以**单元格**为界：票面已按序号带内缩，标记不会进入票面
    const bx = first.cellX
    const by = first.cellY
    const bw = first.cellWidth
    const bh = first.cellHeight
    if (!(bw > 0 && bh > 0)) continue

    if (spec.divider === 'dashed') {
      items.push(...borderLines(bx, by, bw, bh, dashed, color))
    } else if (spec.divider === 'line') {
      items.push(...cornerMarks(bx, by, bw, bh, color))
    }

    if (spec.duplex) {
      items.push({
        kind: 'line',
        x1: bx,
        y1: by + bh / 2,
        x2: bx + bw,
        y2: by + bh / 2,
        dash: dashed,
        color,
        thickness: LINE_THICKNESS,
      })
    }

    if (spec.numbering) {
      // 序号只落在票面外的空白带：排版按 numberBand 内缩时必然可放；
      // 脏配置/极小纸张导致带宽不足时按几何兜底，仍放不下就跳过（绝不覆盖票面）。
      const item = numberingItem(group, String(first.seq), fontPt, color)
      if (item) items.push(item)
    }
  }

  return items
}
