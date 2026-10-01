/**
 * 打印内核回归测试（纯 Node，无测试框架）。
 *
 * 运行：cd web && npm run test:core
 *
 * 做法：用 esbuild 把 src/lib/print 下的纯内核（零 DOM/IO）打包到临时目录，
 * 再用 node:assert 断言关键行为，避免引入额外的测试依赖。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const outDir = mkdtempSync(path.join(tmpdir(), 'print-core-'))

let passed = 0
const failures = []

async function check(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') await r
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } catch (err) {
    failures.push({ name, err })
    process.stdout.write(`  ✗ ${name}\n      ${err.message.split('\n')[0]}\n`)
  }
}

async function loadCore() {
  await build({
    absWorkingDir: webRoot,
    entryPoints: [
      'src/lib/print/qr.ts',
      'src/lib/print/layout.ts',
      'src/lib/print/decor.ts',
      'src/lib/print/types.ts',
      'src/lib/print/render.ts',
      'src/composables/print/usePrintSettings.ts',
      'src/composables/print/useInvoiceStats.ts',
    ],
    outdir: outDir,
    outbase: path.resolve(webRoot, 'src'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    logLevel: 'error',
    alias: { '@': path.resolve(webRoot, 'src') },
  })
  const qr = await import(pathToFileURL(path.join(outDir, 'lib/print/qr.js')).href)
  const layout = await import(pathToFileURL(path.join(outDir, 'lib/print/layout.js')).href)
  const decor = await import(pathToFileURL(path.join(outDir, 'lib/print/decor.js')).href)
  const types = await import(pathToFileURL(path.join(outDir, 'lib/print/types.js')).href)
  const render = await import(pathToFileURL(path.join(outDir, 'lib/print/render.js')).href)
  const settings = await import(pathToFileURL(path.join(outDir, 'composables/print/usePrintSettings.js')).href)
  const stats = await import(pathToFileURL(path.join(outDir, 'composables/print/useInvoiceStats.js')).href)
  return { qr, layout, decor, types, render, settings, stats }
}

const { qr, layout, decor, types, render, settings, stats } = await loadCore()
const { parseQrText, buildIdentityKey, computeDuplicates, computeStats, toAmount, findDate } = qr
const { computeLayout } = layout
const { buildSheetDecor } = decor
const { DEFAULT_DECORATOR, numberBandPt, paperSize } = types
const { renderPdf, renderCalibrationPdf } = render
const { sanitizeSettings, hexToRgb, LIMITS } = settings
const { escapeCsvCell } = stats

const ticket = (i, w = 595, h = 842) => ({
  id: `p${i}`,
  fileId: 'f',
  sourcePage: i,
  name: `t${i}`,
  widthPt: w,
  heightPt: h,
  thumbUrl: '',
})
const spec = (over = {}) => ({
  rows: 1,
  cols: 1,
  orientation: 'portrait',
  paper: 'A4',
  customWidthMm: 210,
  customHeightMm: 297,
  marginMm: 12,
  offsetXMm: 0,
  offsetYMm: 0,
  ...over,
})

process.stdout.write('\n[1] 二维码要素解析（S1）\n')

// 实测真实票面二维码：01,票种,代码,号码,金额,日期,校验码,随机码
const GB_ELECTRONIC =
  '01,10,011001600111,14219190,199.00,20161124,38082233145134495761,7B18,'
await check('国标带票种码：代码/号码/金额/日期/校验码全部正确', () => {
  const p = parseQrText(GB_ELECTRONIC)
  assert.equal(p.invoiceCode, '011001600111')
  assert.equal(p.invoiceNo, '14219190')
  assert.equal(p.amount, 199)
  assert.equal(p.issueDate, '2016-11-24')
  assert.equal(p.checkCode, '495761')
})
await check('国标带票种码：不再把发票号码当金额、不再把校验码当号码', () => {
  const p = parseQrText(GB_ELECTRONIC)
  assert.notEqual(p.amount, 14219190)
  assert.notEqual(p.invoiceNo, '38082233145134495761')
})
await check('增值税普通发票样本（含千分位金额与 DBFE 随机码）', () => {
  const p = parseQrText('01,04,4200161350,00015045,165106.00,20160501,48114255542168294433,DBFE,')
  assert.equal(p.invoiceCode, '4200161350')
  assert.equal(p.invoiceNo, '00015045')
  assert.equal(p.amount, 165106)
  assert.equal(p.issueDate, '2016-05-01')
})
await check('专票样本：校验码为空时不误吞随机码', () => {
  const p = parseQrText('01,01,1200154130,03630024,94339.62,20160621,,9335,')
  assert.equal(p.invoiceCode, '1200154130')
  assert.equal(p.invoiceNo, '03630024')
  assert.equal(p.amount, 94339.62)
  assert.equal(p.issueDate, '2016-06-21')
  assert.equal(p.checkCode, null)
})
await check('国标无票种码变体仍可解析', () => {
  const p = parseQrText('01,011001600111,14219190,199.00,20161124,38082233145134495761')
  assert.equal(p.invoiceCode, '011001600111')
  assert.equal(p.invoiceNo, '14219190')
  assert.equal(p.amount, 199)
})
await check('数电票 URL（fphm/je/kprq）', () => {
  const p = parseQrText(
    'https://inv-veri.chinatax.gov.cn/?fphm=24312000000012345678&kprq=2024-03-12&je=1234.56',
  )
  assert.equal(p.invoiceNo, '24312000000012345678')
  assert.equal(p.amount, 1234.56)
  assert.equal(p.issueDate, '2024-03-12')
})
await check('数电票位序：01,20位号码,金额,日期', () => {
  const p = parseQrText('01,24312000000012345678,1234.56,20240312')
  assert.equal(p.invoiceNo, '24312000000012345678')
  assert.equal(p.amount, 1234.56)
  assert.equal(p.issueDate, '2024-03-12')
})
await check('字段化文本：价税合计带千分位不再只取整数首位', () => {
  const p = parseQrText('发票号码:24312000000012345678 价税合计（小写）￥1,234.56 开票日期：2024年03月12日')
  assert.equal(p.invoiceNo, '24312000000012345678')
  assert.equal(p.amount, 1234.56)
  assert.equal(p.issueDate, '2024-03-12')
})
await check('票号内嵌数字串不会被误当开票日期', () => {
  const p = parseQrText('fphm=24312000000012345678')
  assert.equal(p.issueDate, null)
})
await check('火车票等无法解析要素 → 仅指纹参与去重（同文同键、异文异键）', () => {
  const url = 'https://example.com/train/12306?ticket=ABC123'
  const other = 'https://example.com/train/12306?ticket=XYZ999'
  const p = parseQrText(url)
  assert.equal(p.invoiceNo, null)
  const k = buildIdentityKey(p, url)
  assert.ok(k && k.startsWith('qr:'))
  assert.equal(buildIdentityKey(p, url), k)
  assert.notEqual(buildIdentityKey(parseQrText(other), other), k)
})

process.stdout.write('\n[2] 金额与日期稳健性（S1）\n')
await check('toAmount：千分位、货币符号、上限、非法值', () => {
  assert.equal(toAmount('￥1,234.56'), 1234.56)
  assert.equal(toAmount('1,234'), 1234)
  assert.equal(toAmount('0'), null)
  assert.equal(toAmount('100000001'), null)
  assert.equal(toAmount('12.345'), null)
  assert.equal(toAmount(''), null)
  assert.equal(toAmount(null), null)
})
await check('findDate：非法候选继续向后扫描', () => {
  assert.equal(findDate('20200000 有效日期 2024-03-12'), '2024-03-12')
  assert.equal(findDate('24312000000012345678'), null)
  assert.equal(findDate('2024年2月9日'), '2024-02-09')
  assert.equal(findDate('2023-02-29'), null)
})

process.stdout.write('\n[3] 去重身份键与统计（M1）\n')
await check('代码+号码相同 → 同键（重复打印可识别）', () => {
  const a = parseQrText(GB_ELECTRONIC)
  const b = parseQrText(GB_ELECTRONIC)
  assert.equal(buildIdentityKey(a, GB_ELECTRONIC), buildIdentityKey(b, GB_ELECTRONIC))
})
await check('同号码但日期/金额不同 → 不同键（不再误判重复、不再错扣金额）', () => {
  const meta = (pageId, no, date, amount) => ({
    pageId,
    qrText: `x-${pageId}`,
    invoiceCode: null,
    invoiceNo: no,
    amount,
    issueDate: date,
    checkCode: null,
    status: 'recognized',
    engine: 'jsqr',
    manual: false,
  })
  const metas = [
    meta('a', '14219190', '2016-11-24', 199),
    meta('b', '14219190', '2021-01-05', 3500),
  ]
  const dup = computeDuplicates(metas, new Set())
  assert.equal(dup.groups.length, 0)
  const stats = computeStats(metas, dup)
  assert.equal(stats.amountTotal, 3699)
  assert.equal(stats.uniqueAmount, 3699)
})
await check('真重复：去重金额扣减副本金额，且只标记不删除', () => {
  const meta = (pageId) => ({
    pageId,
    qrText: `y-${pageId}`,
    invoiceCode: '011001600111',
    invoiceNo: '14219190',
    amount: 199,
    issueDate: '2016-11-24',
    checkCode: '495761',
    status: 'recognized',
    engine: 'jsqr',
    manual: false,
  })
  const metas = [meta('a'), meta('b')]
  const dup = computeDuplicates(metas, new Set())
  assert.equal(dup.groups.length, 1)
  assert.deepEqual([...dup.dupPageIds], ['b'])
  const stats = computeStats(metas, dup)
  assert.equal(stats.amountTotal, 398)
  assert.equal(stats.uniqueAmount, 199)
  assert.equal(stats.dupTicketCount, 1)
})
await check('撤销误判后不再参与分组', () => {
  const meta = (pageId) => ({
    pageId,
    qrText: `z-${pageId}`,
    invoiceCode: '011001600111',
    invoiceNo: '14219190',
    amount: 199,
    issueDate: '2016-11-24',
    checkCode: null,
    status: 'recognized',
    engine: 'jsqr',
    manual: false,
  })
  const dup = computeDuplicates([meta('a'), meta('b')], new Set(['b']))
  assert.equal(dup.groups.length, 0)
})

process.stdout.write('\n[4] 版式几何与边界（H1）\n')
await check('A4 竖版尺寸与横版旋转', () => {
  const portrait = computeLayout(spec(), [ticket(0)])
  assert.ok(Math.abs(portrait[0].width - 595.28) < 0.5)
  assert.ok(Math.abs(portrait[0].height - 841.89) < 0.5)
  const landscape = computeLayout(spec({ orientation: 'landscape' }), [ticket(0)])
  assert.ok(Math.abs(landscape[0].width - 841.89) < 0.5)
  assert.ok(Math.abs(landscape[0].height - 595.28) < 0.5)
})
await check('等比缩放不拉伸（宽高比保持）', () => {
  const sheets = computeLayout(spec({ rows: 2, cols: 2 }), [ticket(0, 595, 842)])
  const p = sheets[0].placements[0]
  assert.ok(Math.abs(p.width / p.height - 595 / 842) < 1e-6)
})
await check('1/2/4 张一页容量与自动续页', () => {
  const pages = Array.from({ length: 5 }, (_, i) => ticket(i))
  assert.equal(computeLayout(spec({ rows: 1, cols: 1 }), pages).length, 5)
  assert.equal(computeLayout(spec({ rows: 1, cols: 2 }), pages).length, 3)
  assert.equal(computeLayout(spec({ rows: 2, cols: 2 }), pages).length, 2)
})
await check('双联：同一票据上下各一份、共享序号', () => {
  const sheets = computeLayout(spec(), [ticket(0)], { duplex: true })
  assert.equal(sheets[0].placements.length, 2)
  const [top, bottom] = sheets[0].placements
  assert.equal(top.seq, bottom.seq)
  assert.ok(bottom.y > top.y)
  assert.equal(top.pageId, bottom.pageId)
})
await check('超大页边距不再产生负尺寸（自定义 50mm + 40mm 边界）', () => {
  const sheets = computeLayout(
    spec({ paper: 'custom', customWidthMm: 50, customHeightMm: 50, marginMm: 40 }),
    [ticket(0)],
  )
  for (const p of sheets[0].placements) {
    assert.ok(p.width > 0, `width=${p.width}`)
    assert.ok(p.height > 0, `height=${p.height}`)
    assert.ok(p.cellWidth > 0 && p.cellHeight > 0)
  }
})
await check('未知纸张规格/非法数值回退而不抛错', () => {
  const sheets = computeLayout(spec({ paper: 'A3' }), [ticket(0)])
  assert.ok(sheets[0].width > 0)
  assert.ok(paperSize({ paper: 'A3' }).widthMm === 210)
  assert.ok(paperSize({ paper: 'custom', customWidthMm: NaN, customHeightMm: -5 }).widthMm >= 50)
  assert.equal(computeLayout(spec({ rows: 0, cols: -3 }), [ticket(0)])[0].placements.length, 1)
})
await check('序号带：开了序号后票面被内缩到单元格内侧', () => {
  const band = numberBandPt({ numbering: true, numberFontPt: 10 })
  assert.ok(band >= 12)
  const sheets = computeLayout(spec({ rows: 2, cols: 2 }), [ticket(0)], { numberBand: band })
  const p = sheets[0].placements[0]
  assert.ok(p.x >= p.cellX + band - 1e-6, `x=${p.x} cellX=${p.cellX}`)
  assert.ok(p.y >= p.cellY + band - 1e-6)
  assert.ok(p.x + p.width <= p.cellX + p.cellWidth - band + 1e-6)
  assert.ok(p.y + p.height <= p.cellY + p.cellHeight - band + 1e-6)
})

process.stdout.write('\n[5] 装饰：绝不覆盖票面（S2）+ 原生虚线（L1）\n')

const insideRect = (x, y, r, eps = 0.05) =>
  x > r.x + eps && x < r.x + r.width - eps && y > r.y + eps && y < r.y + r.height - eps

function assertDecorOutsideTickets(sheet, items) {
  for (const it of items) {
    if (it.kind === 'line') {
      // 端点与中点都不得落在票面矩形内部
      const pts = [
        [it.x1, it.y1],
        [it.x2, it.y2],
        [(it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2],
      ]
      for (const p of sheet.placements) {
        for (const [x, y] of pts) {
          assert.ok(!insideRect(x, y, p), `线条点 (${x},${y}) 落在票面内`)
        }
      }
    } else if (it.kind === 'text') {
      const w = it.text.length * (it.size ?? 10) * 0.62 + 2
      const box = {
        x: it.x,
        y: it.y - (it.size ?? 10),
        width: w,
        height: (it.size ?? 10) + 1,
      }
      for (const p of sheet.placements) {
        const overlap =
          box.x < p.x + p.width &&
          box.x + box.width > p.x &&
          box.y < p.y + p.height &&
          box.y + box.height > p.y
        assert.ok(!overlap, `序号文本 ${JSON.stringify(it)} 与票面重叠`)
      }
    } else if (it.kind === 'fill') {
      for (const p of sheet.placements) {
        const overlap =
          it.x < p.x + p.width &&
          it.x + it.width > p.x &&
          it.y < p.y + p.height &&
          it.y + it.height > p.y
        assert.ok(!overlap, '填充块与票面重叠')
      }
    }
  }
}

await check('序号标记完整落在票面外（单页满版，最坏情况）', () => {
  const band = numberBandPt({ numbering: true, numberFontPt: 10 })
  const sheets = computeLayout(spec(), [ticket(0)], { numberBand: band })
  const items = buildSheetDecor(sheets[0], { ...DEFAULT_DECORATOR, numbering: true })
  assert.equal(items.filter((i) => i.kind === 'text').length, 1)
  assert.equal(items.filter((i) => i.kind === 'fill').length, 0, '不允许再用白底块遮盖票面')
  assertDecorOutsideTickets(sheets[0], items)
})
await check('大字号序号仍在票面外', () => {
  const band = numberBandPt({ numbering: true, numberFontPt: 20 })
  const sheets = computeLayout(spec({ rows: 2, cols: 2 }), [ticket(0)], { numberBand: band })
  const items = buildSheetDecor(sheets[0], { ...DEFAULT_DECORATOR, numbering: true, numberFontPt: 20 })
  assertDecorOutsideTickets(sheets[0], items)
})
await check('虚线边框为 4 条原生虚线（不再展开成数百段实线）', () => {
  const sheets = computeLayout(spec({ rows: 2, cols: 2 }), [ticket(0)])
  const items = buildSheetDecor(sheets[0], { ...DEFAULT_DECORATOR, divider: 'dashed' })
  assert.equal(items.length, 4)
  for (const it of items) {
    assert.equal(it.kind, 'line')
    assert.ok(Array.isArray(it.dash) && it.dash.length === 2)
  }
  assertDecorOutsideTickets(sheets[0], items)
})
await check('角部裁剪线为 8 条且不进入票面', () => {
  const sheets = computeLayout(spec({ rows: 2, cols: 2 }), [ticket(0)])
  const items = buildSheetDecor(sheets[0], { ...DEFAULT_DECORATOR, divider: 'line' })
  assert.equal(items.length, 8)
  assertDecorOutsideTickets(sheets[0], items)
})
await check('双联中线 + 颜色/字号可配置', () => {
  const band = numberBandPt({ numbering: true, numberFontPt: 12 })
  const sheets = computeLayout(spec(), [ticket(0)], { duplex: true, numberBand: band })
  const items = buildSheetDecor(sheets[0], {
    ...DEFAULT_DECORATOR,
    duplex: true,
    numbering: true,
    numberFontPt: 12,
    divider: 'none',
    markColor: [0.8, 0.1, 0.1],
  })
  const lines = items.filter((i) => i.kind === 'line')
  assert.equal(lines.length, 1, '双联应只有一条中线')
  assert.ok(Array.isArray(lines[0].dash))
  const text = items.find((i) => i.kind === 'text')
  assert.equal(text.size, 12)
  assert.deepEqual([...text.color], [0.8, 0.1, 0.1])
  assertDecorOutsideTickets(sheets[0], items)
})

process.stdout.write('\n[6] 设置收敛 / 导出渲染 / CSV 转义\n')

await check('sanitizeSettings：脏 localStorage 全部收敛到合法区间', () => {
  const s = sanitizeSettings({
    preset: 'hack',
    customRows: 1e9,
    customCols: -5,
    orientation: 'diagonal',
    paper: 'A3',
    customWidthMm: -100,
    customHeightMm: 99999,
    marginMm: 999,
    offsetXMm: NaN,
    offsetYMm: 'x',
    numbering: 'yes',
    divider: 'weird',
    duplex: 1,
    numberFontPt: 999,
    markColor: 'red',
    dashLen: -3,
    dashGap: 100,
  })
  assert.equal(s.preset, 'double')
  assert.equal(s.customRows, LIMITS.rows[1])
  assert.equal(s.customCols, LIMITS.cols[0])
  assert.equal(s.orientation, 'portrait')
  assert.equal(s.paper, 'A4')
  assert.equal(s.customWidthMm, LIMITS.customWidthMm[0])
  assert.equal(s.customHeightMm, LIMITS.customHeightMm[1])
  assert.equal(s.marginMm, LIMITS.marginMm[1])
  assert.equal(s.offsetXMm, 0)
  assert.equal(s.offsetYMm, 0)
  assert.equal(s.numbering, false)
  assert.equal(s.divider, 'dashed')
  assert.equal(s.duplex, false)
  assert.equal(s.numberFontPt, LIMITS.numberFontPt[1])
  assert.equal(s.markColor, '#1f1f1f')
  assert.equal(s.dashLen, LIMITS.dashLen[0])
  assert.equal(s.dashGap, LIMITS.dashGap[1])
})
await check('hexToRgb：合法/非法颜色', () => {
  assert.deepEqual([...hexToRgb('#ffffff')], [1, 1, 1])
  assert.deepEqual([...hexToRgb('#000000')], [0, 0, 0])
  assert.deepEqual([...hexToRgb('oops')], [0.13, 0.13, 0.13])
})
await check('escapeCsvCell：中和公式注入并转义逗号引号', () => {
  assert.equal(escapeCsvCell('=cmd|calc'), "'=cmd|calc")
  assert.equal(escapeCsvCell('+1'), "'+1")
  assert.equal(escapeCsvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(escapeCsvCell('a,b'), '"a,b"')
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""')
  assert.equal(escapeCsvCell(199.5), '199.5')
  assert.equal(escapeCsvCell(null), '')
})

await check('renderPdf：矢量嵌入 + 装饰 + 进度回调，输出可再次解析', async () => {
  const { PDFDocument, rgb } = await import('pdf-lib')
  // 构造一张"票据"PDF：左上角画黑块（用于人工核对序号不再遮盖票面左上角）
  const src = await PDFDocument.create()
  for (let i = 0; i < 2; i += 1) {
    const sp = src.addPage([420, 297])
    // 左上角黑块：人工核对序号不再遮盖票面左上角
    sp.drawRectangle({ x: 10, y: 297 - 40, width: 60, height: 30, color: rgb(0, 0, 0) })
    sp.drawText(`ticket ${i + 1}`, { x: 20, y: 40, size: 12 })
  }
  const srcBytes = await src.save()

  const pages = [ticket(0, 420, 297), ticket(1, 420, 297)]
  const band = numberBandPt({ numbering: true, numberFontPt: 10 })
  const sheets = computeLayout(spec({ orientation: 'landscape', rows: 1, cols: 2 }), pages, {
    numberBand: band,
  })
  const decor = sheets.map((sh) =>
    buildSheetDecor(sh, { ...DEFAULT_DECORATOR, numbering: true, numberBand: band }),
  )
  const progress = []
  const out = await renderPdf({
    sheets,
    decor,
    files: [
      {
        id: 'f',
        name: 't.pdf',
        ext: 'pdf',
        buffer: srcBytes.buffer.slice(srcBytes.byteOffset, srcBytes.byteOffset + srcBytes.byteLength),
      },
    ],
    onProgress: (done, total) => progress.push([done, total]),
  })
  assert.ok(out instanceof Uint8Array && out.length > 1000)
  const rel = await PDFDocument.load(out)
  assert.equal(rel.getPageCount(), sheets.length)
  const p0 = rel.getPage(0)
  assert.ok(Math.abs(p0.getWidth() - sheets[0].width) < 0.5)
  assert.ok(progress.length > 0)
  assert.equal(progress[progress.length - 1][1], sheets.length)
})

await check('renderCalibrationPdf：极小纸张不抛错且尺寸合法', async () => {
  const bytes = await renderCalibrationPdf({ widthPt: 60, heightPt: 60, offsetXPt: 2, offsetYPt: -3 })
  assert.ok(bytes instanceof Uint8Array && bytes.length > 500)
})

rmSync(outDir, { recursive: true, force: true })

process.stdout.write(`\n通过 ${passed} 项`)
if (failures.length) {
  process.stdout.write(`，失败 ${failures.length} 项：\n`)
  for (const f of failures) {
    process.stdout.write(`\n--- ${f.name} ---\n${f.err.stack || f.err.message}\n`)
  }
  process.exit(1)
}
process.stdout.write('，全部通过。\n')
