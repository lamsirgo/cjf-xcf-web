/**
 * 浏览器端 e2e 验证（真实 Chrome / 真实 Worker / 真实 OffscreenCanvas）。
 *
 * 覆盖 Node 单测无法覆盖的部分：
 *  A. print-parse Worker：PDF 逐页拆分、缩略图 Blob、字节 transfer 回主线程
 *  B. EXIF 方向：在页面内**生成真实带 EXIF 方向的 JPEG**，验证解析后像素确实被转正
 *  C. print-render Worker：导出 PDF，并用 pdfjs 把导出结果栅格化后**按像素校验方向/等比**
 *  D. Comlink 调用与进度回调真实可用
 *
 * 结果通过 POST 回传给 scripts/e2e.mjs 的收集端点（本文件在 Vite dev 下运行）。
 */
import * as Comlink from 'comlink'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ParseWorkerApi } from '../src/workers/print-parse.worker'
import type { PrintWorkerApi } from '../src/workers/print-render.worker'
import { buildSheetDecor } from '../src/lib/print/decor'
import { computeLayout } from '../src/lib/print/layout'
import { DEFAULT_DECORATOR } from '../src/lib/print/types'
import type { SheetLayout, SourceFile, TicketPage } from '../src/lib/print/types'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string

const RESULT_ENDPOINT = 'http://127.0.0.1:4181/__result'
const checks: { name: string; ok: boolean; detail: string }[] = []
/** 诊断信息（回传后由 runner 打印，便于定位像素/方向类问题） */
const debugInfo: Record<string, unknown> = {}

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, ok: true, detail: '' })
    })
    .catch((err: unknown) => {
      checks.push({ name, ok: false, detail: String((err as Error)?.message ?? err) })
    })
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** 从 canvas 采样某点颜色（容差比较） */
function sample(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number] {
  const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
  return [d[0], d[1], d[2]]
}

function nearColor(got: [number, number, number], want: [number, number, number], tol = 60): boolean {
  return (
    Math.abs(got[0] - want[0]) <= tol &&
    Math.abs(got[1] - want[1]) <= tol &&
    Math.abs(got[2] - want[2]) <= tol
  )
}

/** 在 JPEG SOI 之后插入 EXIF APP1（Orientation 段），得到"真实带方向信息的照片" */
async function makeJpegWithExifOrientation(
  width: number,
  height: number,
  orientation: number,
  paint: (ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) => void,
): Promise<File> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d ctx')
  paint(ctx, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
  const jpeg = new Uint8Array(await blob.arrayBuffer())

  // TIFF(小端) + 单个 Orientation 条目
  const tiff = new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II*\0 + IFD0 偏移 8
    0x01, 0x00, // 条目数 1
    0x12, 0x01, // tag 0x0112 Orientation
    0x03, 0x00, // type SHORT
    0x01, 0x00, 0x00, 0x00, // count 1
    orientation, 0x00, 0x00, 0x00, // value + padding
    0x00, 0x00, 0x00, 0x00, // next IFD
  ])
  const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  const payload = new Uint8Array(exifHeader.length + tiff.length)
  payload.set(exifHeader, 0)
  payload.set(tiff, exifHeader.length)
  const segLen = payload.length + 2
  const app1 = new Uint8Array(4 + payload.length)
  app1.set([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff], 0)
  app1.set(payload, 4)

  const out = new Uint8Array(jpeg.length + app1.length)
  out.set(jpeg.subarray(0, 2), 0) // SOI
  out.set(app1, 2)
  out.set(jpeg.subarray(2), 2 + app1.length)
  return new File([out], `exif-${orientation}.jpg`, { type: 'image/jpeg' })
}

/** 用 pdfjs 把 PDF 渲染成位图，便于按像素断言 */
async function rasterizePdf(
  bytes: Uint8Array,
  pageIndex = 0,
  targetWidth = 300,
): Promise<{ ctx: OffscreenCanvasRenderingContext2D; width: number; height: number }> {
  const task = getDocument({ data: new Uint8Array(bytes) })
  const pdf = await task.promise
  try {
    const page = await pdf.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = targetWidth / base.width
    const vp = page.getViewport({ scale })
    const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('no 2d ctx for pdf raster')
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: vp,
    }).promise
    return { ctx, width: canvas.width, height: canvas.height }
  } finally {
    await task.destroy()
  }
}

const parseWorker = new Worker(new URL('../src/workers/print-parse.worker.ts', import.meta.url), {
  type: 'module',
})
const parseApi = Comlink.wrap<ParseWorkerApi>(parseWorker)
const renderWorker = new Worker(new URL('../src/workers/print-render.worker.ts', import.meta.url), {
  type: 'module',
})
const renderApi = Comlink.wrap<PrintWorkerApi>(renderWorker)

async function run(): Promise<void> {
  // ---------- A. 解析 Worker：PDF 拆分 / 缩略图 / 字节 transfer ----------
  let pdfBytes: Uint8Array | null = null
  await check('A1 解析 Worker：PDF 逐页拆分 + 缩略图 + 字节回传', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 2; i += 1) {
      const p = doc.addPage([595, 842])
      p.drawText(`page ${i + 1}`, { x: 40, y: 700, size: 24, font, color: rgb(0, 0, 0) })
    }
    pdfBytes = await doc.save()
    const file = new File([pdfBytes], 'two-pages.pdf', { type: 'application/pdf' })
    const parsed = await parseApi.parse(file)
    assert(parsed.pages.length === 2, `页数应为 2，实际 ${parsed.pages.length}`)
    assert(parsed.buffer.byteLength > 0, '字节应回传')
    assert(parsed.pages[0].thumb instanceof Blob, '缩略图应为 Blob')
    assert(parsed.pages[0].thumb.size > 0, '缩略图不应为空')
    assert(parsed.pages[0].widthPt > 500 && parsed.pages[0].heightPt > 800, 'A4 尺寸异常')
    assert(!/第1页/.test(parsed.pages[0].name) === false, '多页命名应带页码')
  })

  // ---------- B. EXIF 方向：真实 JPEG + 像素级校验 ----------
  // 角对应关系（display 角 ← 源图角）：
  //   6 = 顺时针 90°：源 TL→显示 TR，TR→BR，BR→BL，BL→TL
  //   8 = 逆时针 90°：源 TL→显示 BL，TR→TL，BR→TR，BL→BR
  //   3 = 旋转 180° ：源 TL→显示 BR，TR→BL，BR→TL，BL→TR
  for (const [orientation, expect] of [
    [6, { swap: true, corners: { tl: 'bl', tr: 'tl', bl: 'br', br: 'tr' } }],
    [8, { swap: true, corners: { tl: 'tr', tr: 'br', bl: 'tl', br: 'bl' } }],
    [3, { swap: false, corners: { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' } }],
  ] as const) {
    await check(`B${orientation} EXIF 方向 ${orientation}：像素被转正且导出字节已无方向标记`, async () => {
      // 源图四角用四种纯色（左上红、右上绿、左下蓝、右下黄）
      const file = await makeJpegWithExifOrientation(120, 60, orientation, (ctx, w, h) => {
        ctx.fillStyle = 'rgb(220,30,30)'
        ctx.fillRect(0, 0, w / 2, h / 2)
        ctx.fillStyle = 'rgb(30,200,30)'
        ctx.fillRect(w / 2, 0, w / 2, h / 2)
        ctx.fillStyle = 'rgb(30,30,220)'
        ctx.fillRect(0, h / 2, w / 2, h / 2)
        ctx.fillStyle = 'rgb(230,210,30)'
        ctx.fillRect(w / 2, h / 2, w / 2, h / 2)
      })
      // 先测「浏览器是否按 EXIF 旋转位图」：同一文件用 none / from-image 各解一次
      const rawStats: Record<string, unknown> = {}
      for (const mode of ['none', 'from-image'] as const) {
        const bmp = await createImageBitmap(file, { imageOrientation: mode })
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const cx = c.getContext('2d', { willReadFrequently: true })!
        cx.drawImage(bmp, 0, 0)
        const i = 0.18
        rawStats[mode] = {
          size: [bmp.width, bmp.height],
          tl: sample(cx, bmp.width * i, bmp.height * i),
          tr: sample(cx, bmp.width * (1 - i), bmp.height * i),
          bl: sample(cx, bmp.width * i, bmp.height * (1 - i)),
          br: sample(cx, bmp.width * (1 - i), bmp.height * (1 - i)),
        }
        bmp.close()
      }
      debugInfo[`raw${orientation}`] = rawStats

      const parsed = await parseApi.parse(file)
      const page = parsed.pages[0]

      // 尺寸：90/270 与 180 的差异
      if (expect.swap) {
        assert(page.widthPt < page.heightPt, `方向 ${orientation} 应交换宽高（竖版），实际 ${page.widthPt}x${page.heightPt}`)
      } else {
        assert(page.widthPt > page.heightPt, `方向 ${orientation} 不应交换宽高`)
      }

      // 导出字节里不应再带 EXIF 方向（说明已烘焙进像素）
      const bytes = new Uint8Array(parsed.buffer)
      const hasExif = (() => {
        for (let i = 0; i < Math.min(bytes.length - 6, 4096); i += 1) {
          if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66) return true
        }
        return false
      })()
      assert(!hasExif, '转正后的字节不应仍带 EXIF 段')

      // 像素：把转正后的字节画进 canvas，按"角→角"关系校验
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('no ctx')
      ctx.drawImage(bmp, 0, 0)
      const W = bmp.width
      const H = bmp.height
      const inset = 0.18
      const pts = {
        tl: [W * inset, H * inset],
        tr: [W * (1 - inset), H * inset],
        bl: [W * inset, H * (1 - inset)],
        br: [W * (1 - inset), H * (1 - inset)],
      } as const
      const colors: Record<string, [number, number, number]> = {
        tl: [220, 30, 30],
        tr: [30, 200, 30],
        bl: [30, 30, 220],
        br: [230, 210, 30],
      }
      const observed: Record<string, unknown> = {
        bytes: bytes.length,
        decoded: { W, H },
        page: { widthPt: page.widthPt, heightPt: page.heightPt },
        exif: page.exifOrientation,
      }
      const mismatches: string[] = []
      for (const target of ['tl', 'tr', 'bl', 'br'] as const) {
        const got = sample(ctx, pts[target][0], pts[target][1])
        const want = colors[expect.corners[target]]
        observed[target] = { got, want, fromSource: expect.corners[target] }
        if (!nearColor(got, want, 70)) {
          mismatches.push(`${target}: 期望源${expect.corners[target]}${JSON.stringify(want)} 实际${JSON.stringify(got)}`)
        }
      }
      debugInfo[`exif${orientation}`] = observed
      assert(mismatches.length === 0, `方向 ${orientation} 像素不匹配：${mismatches.join('; ')}`)
      bmp.close()
    })
  }

  // ---------- C. 渲染 Worker：导出 + pdfjs 像素校验（含 /Rotate 扫描件）----------
  await check('C1 渲染 Worker：导出 PDF、进度回调、页数与页面尺寸正确', async () => {
    assert(pdfBytes, '缺少 A 场景生成的 PDF')
    const ticket: TicketPage = {
      id: 'p0',
      fileId: 'f1',
      sourcePage: 0,
      name: 't',
      widthPt: 595,
      heightPt: 842,
      thumbUrl: '',
    }
    const sheets = computeLayout(
      { rows: 1, cols: 1, orientation: 'portrait', paper: 'A4', customWidthMm: 210, customHeightMm: 297, marginMm: 12, offsetXMm: 0, offsetYMm: 0 },
      [ticket],
    )
    const decor = sheets.map((s) => buildSheetDecor(s, { ...DEFAULT_DECORATOR, numbering: true }))
    const progress: number[] = []
    const out = await renderApi.render(
      sheets,
      decor,
      [{ id: 'f1', name: 'two-pages.pdf', ext: 'pdf', buffer: pdfBytes.buffer.slice(0) as ArrayBuffer }],
      Comlink.proxy((done: number) => progress.push(done)),
    )
    assert(out instanceof Uint8Array && out.length > 1000, '导出字节异常')
    assert(progress.length > 0, '未收到进度回调')
    const rel = await PDFDocument.load(out)
    assert(rel.getPageCount() === sheets.length, `页数应为 ${sheets.length}`)
    assert(Math.abs(rel.getPage(0).getWidth() - sheets[0].width) < 0.5, '页面宽度不符')
  })

  await check('C2 /Rotate 90 扫描件：导出后方向正确且等比填满（像素级）', async () => {
    // 源：横版页 + 四边异色 + /Rotate 90（蓝应在导出后位于"上"）
    const src = await PDFDocument.create()
    const sp = src.addPage([842, 595])
    sp.drawRectangle({ x: 0, y: 0, width: 842, height: 40, color: rgb(0.85, 0.1, 0.1) }) // 底=红→左
    sp.drawRectangle({ x: 0, y: 0, width: 40, height: 595, color: rgb(0.1, 0.35, 0.9) }) // 左=蓝→上
    sp.drawRectangle({ x: 802, y: 0, width: 40, height: 595, color: rgb(0.1, 0.6, 0.2) }) // 右=绿→下
    sp.drawRectangle({ x: 0, y: 555, width: 842, height: 40, color: rgb(0.95, 0.65, 0.05) }) // 顶=橙→右
    sp.setRotation(degrees(90))
    const srcBytes = await src.save()

    // pdfjs 视角：/Rotate 90 后可视尺寸 = (h, w) = 595 x 842
    const ticket: TicketPage = {
      id: 'r0',
      fileId: 'f2',
      sourcePage: 0,
      name: 'scan',
      widthPt: 595,
      heightPt: 842,
      thumbUrl: '',
    }
    const sheets = computeLayout(
      { rows: 1, cols: 1, orientation: 'portrait', paper: 'A4', customWidthMm: 210, customHeightMm: 297, marginMm: 12, offsetXMm: 0, offsetYMm: 0 },
      [ticket],
    )
    const decor = sheets.map((s) => buildSheetDecor(s, { ...DEFAULT_DECORATOR, divider: 'none' }))
    const out = await renderApi.render(sheets, decor, [
      { id: 'f2', name: 'scan.pdf', ext: 'pdf', buffer: srcBytes.buffer.slice(0) as ArrayBuffer },
    ])

    const { ctx, width, height } = await rasterizePdf(out, 0, 400)
    const inset = 0.06
    const top = sample(ctx, width / 2, height * inset)
    const bottom = sample(ctx, width / 2, height * (1 - inset))
    const left = sample(ctx, width * inset, height / 2)
    const right = sample(ctx, width * (1 - inset), height / 2)
    assert(nearColor(top, [26, 89, 230], 70), `上边应为源左边(蓝)，实际 ${top}`)
    assert(nearColor(left, [217, 26, 26], 70), `左边应为源底边(红)，实际 ${left}`)
    assert(nearColor(right, [242, 166, 13], 70), `右边应为源顶边(橙)，实际 ${right}`)
    assert(nearColor(bottom, [26, 153, 51], 70), `下边应为源右边(绿)，实际 ${bottom}`)
  })

  // ---------- E. 原图查看（人工校正用）----------
  await check('E1 原图按需渲染：返回可显示的高清 Blob，且不越界/不空白', async () => {
    assert(pdfBytes, '缺少 A 场景生成的 PDF')
    const blob = await parseApi.renderPage({
      buffer: pdfBytes.buffer.slice(0) as ArrayBuffer,
      ext: 'pdf',
      sourcePage: 0,
      width: 1400,
    })
    assert(blob instanceof Blob && blob.size > 3000, `原图 Blob 异常：${blob?.size}`)
    const bmp = await createImageBitmap(blob)
    try {
      const ratio = bmp.width / bmp.height
      assert(bmp.width >= 1200 && bmp.width <= 1500, `宽度应接近 1400，实际 ${bmp.width}`)
      assert(Math.abs(ratio - 595 / 842) < 0.02, `应保持 A4 比例，实际 ${ratio.toFixed(3)}`)
      // 非空白校验：抽样应出现深色像素（页面文字）
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const cx = c.getContext('2d', { willReadFrequently: true })!
      cx.drawImage(bmp, 0, 0)
      const data = cx.getImageData(0, 0, bmp.width, bmp.height).data
      let dark = 0
      for (let i = 0; i < data.length; i += 4 * 97) {
        if (data[i] < 128) dark += 1
      }
      assert(dark > 0, '原图不应是纯白（应包含票面内容）')
    } finally {
      bmp.close()
    }
  })

  await check('E2 原图查看：带 EXIF 的图片按已转正方向渲染', async () => {
    const file = await makeJpegWithExifOrientation(120, 60, 6, (ctx, w, h) => {
      ctx.fillStyle = 'rgb(220,30,30)'
      ctx.fillRect(0, 0, w / 2, h / 2)
      ctx.fillStyle = 'rgb(30,30,220)'
      ctx.fillRect(0, h / 2, w / 2, h / 2)
      ctx.fillStyle = 'rgb(255,255,255)'
      ctx.fillRect(w / 2, 0, w / 2, h)
    })
    const parsed = await parseApi.parse(file)
    const blob = await parseApi.renderPage({
      buffer: parsed.buffer,
      ext: 'jpg',
      sourcePage: 0,
      width: 300,
    })
    const bmp = await createImageBitmap(blob)
    try {
      assert(bmp.height > bmp.width, `转正后应为竖版，实际 ${bmp.width}x${bmp.height}`)
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const cx = c.getContext('2d', { willReadFrequently: true })!
      cx.drawImage(bmp, 0, 0)
      // 方向 6：源左下(蓝) → 显示左上
      const got = sample(cx, bmp.width * 0.2, bmp.height * 0.2)
      assert(nearColor(got, [30, 30, 220], 70), `左上应来自源左下(蓝)，实际 ${got}`)
    } finally {
      bmp.close()
    }
  })

  // ---------- D. 清理 ----------
  await check('D1 Worker 缓存可释放', async () => {
    await renderApi.clearFiles()
    const ids = await renderApi.cachedFileIds()
    assert(Array.isArray(ids) && ids.length === 0, `缓存应清空，实际 ${JSON.stringify(ids)}`)
    await parseApi.parse(new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' })).then(
      () => {
        throw new Error('非法扩展名不应被解析')
      },
      () => undefined,
    )
  })

  parseWorker.terminate()
  renderWorker.terminate()
}

run()
  .catch((err) => {
    checks.push({ name: 'harness', ok: false, detail: `harness 崩溃：${String(err)}` })
  })
  .finally(async () => {
    const passed = checks.filter((c) => c.ok).length
    const summary = { total: checks.length, passed, failed: checks.length - passed, checks, debug: debugInfo }
    document.getElementById('result')!.textContent = JSON.stringify(summary, null, 2)
    try {
      await fetch(RESULT_ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        // text/plain 属"简单请求"，不触发 CORS 预检
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(summary),
      })
    } catch {
      /* 收集端点不可用时，仍可从 DOM 读取结果 */
    }
  })
