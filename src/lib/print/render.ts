/**
 * 合并导出渲染（pdf-lib，可在 Worker 内运行）。
 *
 * - PDF 票据：embedPdf 矢量嵌入（清晰、体积小）；
 * - 图片票据：embedJpg / embedPng；
 * - 装饰图元与预览共用 decor 产物。
 * pdf-lib 坐标原点在左下角，Placement 原点在顶部，绘制前统一翻转。
 */

import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage } from 'pdf-lib'
import type { DecorItem } from './decor'
import type { SheetLayout, SourceFile } from './types'

export interface RenderInput {
  sheets: SheetLayout[]
  /** 与 sheets 一一对应的装饰图元 */
  decor: DecorItem[][]
  files: Pick<SourceFile, 'id' | 'ext' | 'buffer'>[]
}

export async function renderPdf(input: RenderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const black = rgb(0, 0, 0)
  const white = rgb(1, 1, 1)

  const fileMap = new Map(input.files.map((f) => [f.id, f]))
  const srcPdfCache = new Map<string, PDFDocument>()
  const embeddedPageCache = new Map<string, PDFEmbeddedPage>()
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument['embedJpg']>>>()

  for (let si = 0; si < input.sheets.length; si++) {
    const sheet = input.sheets[si]
    const page = doc.addPage([sheet.width, sheet.height])
    /** 顶部 y → pdf 底部 y（点坐标） */
    const flipY = (topY: number) => sheet.height - topY
    /** 矩形顶部 y + 高 → pdf 底部 y */
    const flipRect = (topY: number, h: number) => sheet.height - topY - h

    // ① 票据内容
    for (const p of sheet.placements) {
      const f = fileMap.get(p.fileId)
      if (!f) continue

      if (f.ext === 'pdf') {
        let src = srcPdfCache.get(f.id)
        if (!src) {
          src = await PDFDocument.load(f.buffer.slice(0), { ignoreEncryption: true })
          srcPdfCache.set(f.id, src)
        }
        const key = `${f.id}:${p.sourcePage}`
        let embedded = embeddedPageCache.get(key)
        if (!embedded) {
          const [embeddedPage] = await doc.embedPdf(src, [p.sourcePage])
          if (!embeddedPage) throw new Error('PDF 页面嵌入失败')
          embedded = embeddedPage
          embeddedPageCache.set(key, embedded)
        }
        page.drawPage(embedded, {
          x: p.x,
          y: flipRect(p.y, p.height),
          xScale: p.width / embedded.width,
          yScale: p.height / embedded.height,
        })
      } else if (f.ext === 'jpg' || f.ext === 'jpeg' || f.ext === 'png') {
        let img = imageCache.get(f.id)
        if (!img) {
          img =
            f.ext === 'png'
              ? await doc.embedPng(f.buffer.slice(0))
              : await doc.embedJpg(f.buffer.slice(0))
          imageCache.set(f.id, img)
        }
        page.drawImage(img, {
          x: p.x,
          y: flipRect(p.y, p.height),
          width: p.width,
          height: p.height,
        })
      }
    }

    // ② 装饰
    for (const item of input.decor[si] ?? []) {
      if (item.kind === 'line') {
        page.drawLine({
          start: { x: item.x1, y: flipY(item.y1) },
          end: { x: item.x2, y: flipY(item.y2) },
          thickness: 0.6,
          color: black,
        })
      } else if (item.kind === 'fill') {
        page.drawRectangle({
          x: item.x,
          y: flipRect(item.y, item.height),
          width: item.width,
          height: item.height,
          color: white,
        })
      } else {
        page.drawText(item.text, {
          x: item.x,
          y: flipY(item.y),
          size: 10,
          font,
          color: black,
        })
      }
    }
  }

  return doc.save()
}

/**
 * 打印校准测试页：10mm 网格 + 15mm 基准框 + 当前偏移下的蓝色实际内容框。
 * 打印时必须选「实际大小/100%」，测量黑框四边边距后调整偏移，直到四边相等。
 * （标准字体不含中文，说明文字用英文。）
 */
export async function renderCalibrationPdf(opts: {
  widthPt: number
  heightPt: number
  offsetXPt: number
  offsetYPt: number
}): Promise<Uint8Array> {
  const { widthPt: w, heightPt: h, offsetXPt: offX, offsetYPt: offY } = opts
  const doc = await PDFDocument.create()
  const page = doc.addPage([w, h])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const black = rgb(0, 0, 0)
  const gray = rgb(0.78, 0.78, 0.78)
  const blue = rgb(0.15, 0.38, 0.9)

  const MM = 72 / 25.4
  const INSET = 15 * MM

  // ① 10mm 网格
  for (let x = MM; x < w; x += MM) {
    const at10 = Math.round(x / MM) % 10 === 0
    page.drawLine({
      start: { x, y: 0 },
      end: { x, y: h },
      thickness: at10 ? 0.4 : 0.2,
      color: at10 ? rgb(0.68, 0.68, 0.68) : gray,
    })
  }
  for (let y = MM; y < h; y += MM) {
    const at10 = Math.round(y / MM) % 10 === 0
    page.drawLine({
      start: { x: 0, y },
      end: { x: w, y },
      thickness: at10 ? 0.4 : 0.2,
      color: at10 ? rgb(0.68, 0.68, 0.68) : gray,
    })
  }

  // ② 15mm 基准框（黑）
  page.drawRectangle({
    x: INSET,
    y: INSET,
    width: w - INSET * 2,
    height: h - INSET * 2,
    borderColor: black,
    borderWidth: 1.2,
  })

  // ③ 当前偏移下的实际内容框（蓝）。顶部坐标 +Y 向下 → pdf 底部坐标 -Y
  page.drawRectangle({
    x: INSET + offX,
    y: INSET - offY,
    width: w - INSET * 2,
    height: h - INSET * 2,
    borderColor: blue,
    borderWidth: 1.2,
  })
  // 连接两框左上角，直观显示偏移量
  page.drawLine({
    start: { x: INSET, y: h - INSET },
    end: { x: INSET + offX, y: h - INSET - offY },
    thickness: 0.8,
    color: blue,
  })

  // ④ 中心十字
  page.drawLine({ start: { x: w / 2 - 6 * MM, y: h / 2 }, end: { x: w / 2 + 6 * MM, y: h / 2 }, thickness: 0.8, color: black })
  page.drawLine({ start: { x: w / 2, y: h / 2 - 6 * MM }, end: { x: w / 2, y: h / 2 + 6 * MM }, thickness: 0.8, color: black })

  // ⑤ 说明
  const mmText = (v: number) => `${v >= 0 ? '+' : ''}${(v / MM).toFixed(1)} mm`
  page.drawText('Print Calibration Page', { x: INSET, y: h - 10 * MM, size: 13, font: bold, color: black })
  page.drawText(`Offset X: ${mmText(offX)}    Offset Y: ${mmText(offY)}`, {
    x: INSET,
    y: h - 17 * MM,
    size: 10,
    font,
    color: black,
  })
  const lines = [
    '1. Print this page at 100% scale (Actual size, do NOT fit to page).',
    '2. Measure the four margins of the BLACK frame with a ruler.',
    '3. Adjust X/Y offsets in settings until all four margins are equal.',
    '4. The BLUE frame shows where content lands with the current offsets.',
  ]
  lines.forEach((line, i) => {
    page.drawText(line, { x: INSET, y: 10 * MM + (lines.length - 1 - i) * 5 * MM, size: 9.5, font, color: black })
  })

  return doc.save()
}
