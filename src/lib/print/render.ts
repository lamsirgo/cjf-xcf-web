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
