/**
 * 合并导出渲染（pdf-lib，可在 Worker 内运行）。
 *
 * - PDF 票据：embedPdf 矢量嵌入（清晰、体积小）；
 * - 图片票据：embedJpg / embedPng；
 * - 装饰图元与预览共用 decor 产物（虚线用 pdf-lib 原生 dashArray）。
 * pdf-lib 坐标原点在左下角，Placement 原点在顶部，绘制前统一翻转。
 *
 * 内存：输入 buffer 由 Worker 独占（结构化克隆副本），此处不再 slice 复制；
 * 同一源文件只加载/嵌入一次（按 fileId、fileId:page 缓存）。
 */

import { PDFDocument, StandardFonts, rgb, type PDFEmbeddedPage } from 'pdf-lib'
import type { DecorItem } from './decor'
import type { SheetLayout, SourceFile } from './types'

export interface RenderInput {
  sheets: SheetLayout[]
  /** 与 sheets 一一对应的装饰图元 */
  decor: DecorItem[][]
  files: Pick<SourceFile, 'id' | 'name' | 'ext' | 'buffer'>[]
  /** 逐页进度回调（Worker 内通过 Comlink proxy 回传主线程） */
  onProgress?: (done: number, total: number) => void
}

/** 文件名 + 页码，便于把失败原因说清楚 */
function pageLabel(input: RenderInput, fileId: string, sourcePage: number): string {
  const f = input.files.find((x) => x.id === fileId)
  return `${f?.name ?? fileId} 第 ${sourcePage + 1} 页`
}

export async function renderPdf(input: RenderInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const black = rgb(0, 0, 0)

  const fileMap = new Map(input.files.map((f) => [f.id, f]))
  const srcPdfCache = new Map<string, PDFDocument>()
  const embeddedPageCache = new Map<string, PDFEmbeddedPage>()
  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument['embedJpg']>>>()
  const total = input.sheets.length
  let lastReported = -1

  const report = (done: number) => {
    if (!input.onProgress) return
    // 限制进度回调频率，避免刷爆主线程
    if (done === total || done - lastReported >= 3) {
      lastReported = done
      input.onProgress(done, total)
    }
  }

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
      const w = Math.max(1e-6, p.width)
      const h = Math.max(1e-6, p.height)

      if (f.ext === 'pdf') {
        let src = srcPdfCache.get(f.id)
        if (!src) {
          try {
            src = await PDFDocument.load(f.buffer)
          } catch (err) {
            throw new Error(
              `PDF 解析失败（${f.name}）：${(err as Error).message || '文件可能已损坏或加密'}`,
            )
          }
          srcPdfCache.set(f.id, src)
        }
        const key = `${f.id}:${p.sourcePage}`
        let embedded = embeddedPageCache.get(key)
        if (!embedded) {
          let embeddedPage: PDFEmbeddedPage | undefined
          try {
            ;[embeddedPage] = await doc.embedPdf(src, [p.sourcePage])
          } catch (err) {
            throw new Error(
              `PDF 页面嵌入失败（${pageLabel(input, f.id, p.sourcePage)}）：${(err as Error).message}`,
            )
          }
          if (!embeddedPage) {
            throw new Error(`PDF 页面不存在：${pageLabel(input, f.id, p.sourcePage)}`)
          }
          embedded = embeddedPage
          embeddedPageCache.set(key, embedded)
        }
        const ew = Math.max(1e-6, embedded.width)
        const eh = Math.max(1e-6, embedded.height)
        page.drawPage(embedded, {
          x: p.x,
          y: flipRect(p.y, h),
          xScale: w / ew,
          yScale: h / eh,
        })
      } else if (f.ext === 'jpg' || f.ext === 'jpeg' || f.ext === 'png') {
        let img = imageCache.get(f.id)
        if (!img) {
          try {
            img = f.ext === 'png' ? await doc.embedPng(f.buffer) : await doc.embedJpg(f.buffer)
          } catch (err) {
            throw new Error(
              `图片解码失败（${f.name}）：${(err as Error).message || '文件内容与扩展名不符'}`,
            )
          }
          imageCache.set(f.id, img)
        }
        page.drawImage(img, {
          x: p.x,
          y: flipRect(p.y, h),
          width: w,
          height: h,
        })
      }
    }

    // ② 装饰（只画在票面外围，见 decor.ts 的硬约束）
    for (const item of input.decor[si] ?? []) {
      if (item.kind === 'line') {
        page.drawLine({
          start: { x: item.x1, y: flipY(item.y1) },
          end: { x: item.x2, y: flipY(item.y2) },
          thickness: item.thickness,
          color: rgb(...item.color),
          ...(item.dash ? { dashArray: item.dash } : {}),
        })
      } else if (item.kind === 'fill') {
        page.drawRectangle({
          x: item.x,
          y: flipRect(item.y, item.height),
          width: item.width,
          height: item.height,
          color: rgb(...item.color),
        })
      } else {
        page.drawText(item.text, {
          x: item.x,
          y: flipY(item.y),
          size: item.size,
          font,
          color: rgb(...item.color),
        })
      }
    }

    report(si + 1)
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
  const w = Math.max(50, opts.widthPt)
  const h = Math.max(50, opts.heightPt)
  const offX = Number.isFinite(opts.offsetXPt) ? opts.offsetXPt : 0
  const offY = Number.isFinite(opts.offsetYPt) ? opts.offsetYPt : 0
  const doc = await PDFDocument.create()
  const page = doc.addPage([w, h])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const black = rgb(0, 0, 0)
  const gray = rgb(0.78, 0.78, 0.78)
  const blue = rgb(0.15, 0.38, 0.9)

  const MM = 72 / 25.4
  // 基准框内缩：纸张很小时自动缩小，避免负尺寸
  const INSET = Math.min(15 * MM, Math.min(w, h) / 2 - 1)

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
  page.drawText('Print Calibration Page', { x: INSET, y: h - Math.min(10 * MM, h / 2), size: 13, font: bold, color: black })
  page.drawText(`Offset X: ${mmText(offX)}    Offset Y: ${mmText(offY)}`, {
    x: INSET,
    y: h - Math.min(17 * MM, h / 2),
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
