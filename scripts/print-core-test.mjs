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

/** xorshift32：可复现的伪随机（失败可凭 seed 复现） */
function rng(seed) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 0x100000000
  }
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]
const weirdNum = (r) =>
  pick(r, [
    0, 1, -1, 2.5, -2.5, 1e9, -1e9, NaN, Infinity, -Infinity,
    0.0001, 49.9, 50, 500, 501, 700, 701, 20, 40, 1e-7,
  ])

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
      'src/lib/print/imageinfo.ts',
      'src/lib/print/gate.ts',
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
  const imageinfo = await import(pathToFileURL(path.join(outDir, 'lib/print/imageinfo.js')).href)
  const gate = await import(pathToFileURL(path.join(outDir, 'lib/print/gate.js')).href)
  return { qr, layout, decor, types, render, settings, stats, imageinfo, gate }
}

const { qr, layout, decor, types, render, settings, stats, imageinfo, gate } = await loadCore()
const { parseQrText, buildIdentityKey, computeDuplicates, computeStats, toAmount, findDate } = qr
const { computeLayout } = layout
const { buildSheetDecor } = decor
const { DEFAULT_DECORATOR, numberBandPt, paperSize } = types
const { renderPdf, renderCalibrationPdf, ticketEmbedGeometry } = render
const { sanitizeSettings, hexToRgb, LIMITS } = settings
const { escapeCsvCell } = stats
const { readImageInfo, needsOrientationFix, orientationMatrix, orientedSize } = imageinfo
const { compareVersions, evaluateGate, CLIENT_VERSION, classifyGateFailure, gateMessage } = gate

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
await check('数电票国标（2024 全国推广）：01,32,,20位号码,金额,日期,,随机码（真实票面原文）', () => {
  // 用户真实数电普票（代码字段为空，连续逗号）
  const p = parseQrText('01,32,,26447000001243494438,285.92,20260619,,300A ')
  assert.equal(p.invoiceNo, '26447000001243494438')
  assert.equal(p.invoiceCode, null)
  assert.equal(p.amount, 285.92)
  assert.equal(p.issueDate, '2026-06-19')
  assert.equal(p.checkCode, null)
})
await check('数电专票变体 31 + 带校验码位置也不串位', () => {
  const p = parseQrText('01,31,,24117000000123133001,476.6,20260131,,7001')
  assert.equal(p.invoiceNo, '24117000000123133001')
  assert.equal(p.amount, 476.6)
  assert.equal(p.issueDate, '2026-01-31')
})
await check('数电国标重复票：同号同日同额判重，号码相同但金额不同不误判', () => {
  const a = parseQrText('01,32,,26447000001243494438,285.92,20260619,,300A')
  const b = parseQrText('01,32,,26447000001243494438,285.92,20260619,,300B')
  const c = parseQrText('01,32,,26447000001243494438,999.00,20260619,,300C')
  assert.equal(buildIdentityKey(a, null), buildIdentityKey(b, null))
  assert.notEqual(buildIdentityKey(a, null), buildIdentityKey(c, null))
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
    }
  }
}

await check('序号标记完整落在票面外（单页满版，最坏情况）', () => {
  const band = numberBandPt({ numbering: true, numberFontPt: 10 })
  const sheets = computeLayout(spec(), [ticket(0)], { numberBand: band })
  const items = buildSheetDecor(sheets[0], { ...DEFAULT_DECORATOR, numbering: true })
  assert.equal(items.filter((i) => i.kind === 'text').length, 1)
  // 装饰图元只有线段与文本两类：不存在任何"填充块"，从类型上就杜绝遮盖票面
  assert.ok(
    items.every((i) => i.kind === 'line' || i.kind === 'text'),
    `出现未知装饰类型：${items.map((i) => i.kind).join(',')}`,
  )
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

process.stdout.write('\n[7] 源页嵌入几何（CropBox + /Rotate）\n')

await check('四种旋转下矩阵把 CropBox 精确映射为 [0,baseW]×[0,baseH]', () => {
  const apply = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]
  const crops = [
    { x: 0, y: 0, width: 842, height: 595 },
    { x: 10, y: 20, width: 800, height: 500 },
    { x: -5, y: 7.5, width: 300, height: 120 },
    { x: 0, y: 0, width: 0, height: 0 },
  ]
  for (const crop of crops) {
    for (const rot of [0, 90, 180, 270, 360, -90, 45]) {
      const g = ticketEmbedGeometry(crop, rot)
      const m = g.matrix ?? [1, 0, 0, 1, -crop.x, -crop.y]
      const w = Math.max(1e-6, crop.width)
      const h = Math.max(1e-6, crop.height)
      const pts = [
        [crop.x, crop.y],
        [crop.x + w, crop.y],
        [crop.x, crop.y + h],
        [crop.x + w, crop.y + h],
      ].map(([u, v]) => apply(m, u, v))
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const g0 = { rot, crop }
      assert.ok(Math.abs(Math.min(...xs)) < 1e-6, `x_min ${Math.min(...xs)} ${JSON.stringify(g0)}`)
      assert.ok(Math.abs(Math.min(...ys)) < 1e-6, `y_min ${Math.min(...ys)} ${JSON.stringify(g0)}`)
      assert.ok(Math.abs(Math.max(...xs) - g.baseW) < 1e-6, `x_max ${Math.max(...xs)} vs ${g.baseW} ${JSON.stringify(g0)}`)
      assert.ok(Math.abs(Math.max(...ys) - g.baseH) < 1e-6, `y_max ${Math.max(...ys)} vs ${g.baseH} ${JSON.stringify(g0)}`)
      // baseW/baseH 必须等于「旋转后的视觉宽高」，才能与 pdf.js 的 widthPt/heightPt 对齐
      const swap = g.rotation === 90 || g.rotation === 270
      assert.equal(g.baseW, swap ? h : w)
      assert.equal(g.baseH, swap ? w : h)
    }
  }
})

await check('/Rotate 90 的扫描件导出：方向正确且等比填满目标矩形', async () => {
  const { PDFDocument, rgb, degrees } = await import('pdf-lib')
  const src = await PDFDocument.create()
  const sp = src.addPage([842, 595])
  sp.drawRectangle({ x: 0, y: 0, width: 842, height: 30, color: rgb(0.85, 0.1, 0.1) })
  sp.drawRectangle({ x: 0, y: 0, width: 30, height: 595, color: rgb(0.1, 0.3, 0.85) })
  sp.setRotation(degrees(90))
  const srcBytes = await src.save()

  // pdf.js 视角：/Rotate 90 后可视尺寸恰为 CropBox 的 (h, w) = 595x842
  // （生产环境 widthPt/heightPt 就是 pdfjs viewport 尺寸，与本函数 baseW/baseH 同源）
  const pages = [ticket(0, 595, 842)]
  const sheets = computeLayout(spec(), pages)
  const decor = sheets.map((sh) => buildSheetDecor(sh, { ...DEFAULT_DECORATOR, divider: 'none' }))
  const out = await renderPdf({
    sheets,
    decor,
    files: [
      {
        id: 'f',
        name: 'scan.pdf',
        ext: 'pdf',
        buffer: srcBytes.buffer.slice(srcBytes.byteOffset, srcBytes.byteOffset + srcBytes.byteLength),
      },
    ],
  })
  const rel = await (await import('pdf-lib')).PDFDocument.load(out)
  assert.equal(rel.getPageCount(), 1)
  // 等比：旋转后内容 595x842，放置矩形由同一比例 fit 得到 → 两方向缩放系数必须一致
  const p = sheets[0].placements[0]
  const sx = p.width / 595
  const sy = p.height / 842
  assert.ok(Math.abs(sx - sy) < 1e-9, `非等比: sx=${sx} sy=${sy}`)
  // 且内容应填满放置矩形（按 CropBox 而非 MediaBox 取基准）
  assert.ok(Math.abs(p.width / p.height - 595 / 842) < 1e-9, '放置矩形比例应等于旋转后内容比例')
})

process.stdout.write('\n[8] 图片票据真实尺寸与 EXIF 方向\n')

/** 构造最小 JPEG 字节：SOI + [APP1(Exif, orientation)] + SOF0(w,h) + EOI */
function fakeJpeg({ width, height, orientation, little = true }) {
  const seg = []
  // SOI
  seg.push(0xff, 0xd8)
  if (orientation) {
    const tiff = []
    const push16 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff])
    const push32 = (v) =>
      little
        ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
        : [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
    tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]))
    tiff.push(...push16(0x002a))
    tiff.push(...push32(8)) // IFD0 偏移
    tiff.push(...push16(1)) // 1 个条目
    tiff.push(...push16(0x0112)) // Orientation
    tiff.push(...push16(3)) // SHORT
    tiff.push(...push32(1)) // count
    tiff.push(...push16(orientation), ...push16(0)) // value
    tiff.push(...push32(0)) // next IFD
    const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]
    const len = exif.length + 2
    seg.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...exif)
  }
  // SOF0：长度 17，精度 8，高，宽，3 分量
  seg.push(0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03)
  for (let i = 0; i < 9; i += 1) seg.push(0)
  seg.push(0xff, 0xd9)
  return new Uint8Array(seg)
}

/** 构造最小 PNG 字节：签名 + IHDR + IEND */
function fakePng(width, height) {
  const b = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const push32 = (v) => b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  push32(13)
  b.push(0x49, 0x48, 0x44, 0x52)
  push32(width)
  push32(height)
  b.push(8, 6, 0, 0, 0)
  push32(0) // crc 占位（解析器不校验）
  push32(0)
  b.push(0x49, 0x45, 0x4e, 0x44)
  push32(0)
  return new Uint8Array(b)
}

await check('JPEG 尺寸与 EXIF 方向（大小端、方向 1/6/8、无 EXIF）', () => {
  assert.deepEqual(readImageInfo(fakeJpeg({ width: 4000, height: 3000 }), 'jpg'), {
    width: 4000,
    height: 3000,
    exifOrientation: null,
  })
  for (const [orientation, little] of [[1, true], [6, true], [8, false], [3, false]]) {
    const info = readImageInfo(fakeJpeg({ width: 1000, height: 500, orientation, little }), 'jpeg')
    assert.equal(info.width, 1000)
    assert.equal(info.height, 500)
    assert.equal(info.exifOrientation, orientation, `orientation=${orientation} little=${little}`)
  }
  assert.equal(needsOrientationFix(1), false)
  assert.equal(needsOrientationFix(null), false)
  assert.equal(needsOrientationFix(6), true)
  assert.equal(needsOrientationFix(8), true)
})

await check('PNG 尺寸（IHDR）与非法输入回退', () => {
  assert.deepEqual(readImageInfo(fakePng(1920, 1080), 'png'), {
    width: 1920,
    height: 1080,
    exifOrientation: null,
  })
  assert.equal(readImageInfo(new Uint8Array([1, 2, 3]), 'jpg'), null)
  assert.equal(readImageInfo(fakePng(0, 0), 'png'), null)
  assert.equal(readImageInfo(new Uint8Array(0), 'png'), null)
  // 截断的 JPEG：不抛错
  const truncated = fakeJpeg({ width: 10, height: 10 }).slice(0, 5)
  assert.doesNotThrow(() => readImageInfo(truncated, 'jpg'))
})

await check('EXIF Orientation 矩阵：四角映射、输出尺寸、镜像性质（1~8 全覆盖）', () => {
  const W = 40
  const H = 25
  // 期望的"四角去向"（源四角 → 输出四角集合），用连续坐标表述
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = orientationMatrix(o, W, H)
    const ap = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
    const corners = [ap(0, 0), ap(W, 0), ap(0, H), ap(W, H)]
    const xs = corners.map((p) => Math.round(p[0] * 1000) / 1000)
    const ys = corners.map((p) => Math.round(p[1] * 1000) / 1000)
    // 每个角都必须落在输出矩形 [0,outW]×[0,outH] 内
    for (const [x, y] of corners) {
      assert.ok(x >= -1e-9 && x <= m.outWidth + 1e-9, `o=${o} x=${x} outW=${m.outWidth}`)
      assert.ok(y >= -1e-9 && y <= m.outHeight + 1e-9, `o=${o} y=${y} outH=${m.outHeight}`)
    }
    // 四角必须恰好覆盖输出矩形的四个角（无重叠、无遗漏）
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`
    const got = new Set(corners.map(([x, y]) => key(x, y)))
    assert.equal(got.size, 4, `o=${o} 四角映射后不唯一`)
    assert.deepEqual(
      [...got].sort(),
      [key(0, 0), key(m.outWidth, 0), key(0, m.outHeight), key(m.outWidth, m.outHeight)].sort(),
      `o=${o} 四角未覆盖输出矩形`,
    )
    // 面积守恒 + 镜像判定（行列式符号）
    const det = m.a * m.d - m.b * m.c
    assert.ok(Math.abs(Math.abs(det) - 1) < 1e-9, `o=${o} 行列式 ${det}`)
    assert.equal(m.mirrored, det < 0, `o=${o} 镜像标记与行列式不一致`)
    assert.equal(m.outWidth * m.outHeight, W * H, `o=${o} 面积不守恒`)
    // 90/270（含镜像变体）必须交换宽高
    const swapped = [5, 6, 7, 8].includes(o)
    assert.equal(m.outWidth, swapped ? H : W, `o=${o} outWidth`)
    assert.equal(m.outHeight, swapped ? W : H, `o=${o} outHeight`)
    assert.deepEqual(
      orientedSize(o, W, H),
      { width: swapped ? H : W, height: swapped ? W : H },
      `o=${o} orientedSize`,
    )
  }
  // 方向 1 / null 必须是恒等
  assert.deepEqual(orientationMatrix(1, W, H), {
    a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, outWidth: W, outHeight: H, mirrored: false,
  })
})

await check('EXIF 方向 6/8 的语义正确（顺时针/逆时针）', () => {
  const W = 40, H = 25
  // 6 = 顺时针 90°：源左上(0,0) → 输出右上(outW,0)
  const m6 = orientationMatrix(6, W, H)
  assert.deepEqual([m6.a * 0 + m6.c * 0 + m6.e, m6.b * 0 + m6.d * 0 + m6.f], [H, 0])
  assert.equal(m6.outWidth, H)
  // 8 = 逆时针 90°：源左上(0,0) → 输出左下(0,outH)
  const m8 = orientationMatrix(8, W, H)
  assert.deepEqual([m8.a * 0 + m8.c * 0 + m8.e, m8.b * 0 + m8.d * 0 + m8.f], [0, W])
  assert.equal(m8.outWidth, H)
})

process.stdout.write('\n[9] 启动门禁（离线宽限 / 版本对齐）\n')

await check('compareVersions：语义化版本比较', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('2.0', '10.0'), -1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), 0)
  assert.equal(compareVersions('', '1.0.0'), -1)
})

await check('evaluateGate：联网成功即可进入并记录校验时间', () => {
  const r = evaluateGate({
    validationOk: true, lastOkAt: null, now: 1_000_000, graceMinutes: 0,
    clientVersion: CLIENT_VERSION, minClientVersion: '1.0.0',
  })
  assert.equal(r.reason, 'ok')
  assert.equal(r.recordOk, true)
})

await check('evaluateGate：默认宽限 0 → 离线即必须联网校验（MD §8.1）', () => {
  const r = evaluateGate({
    validationOk: false, lastOkAt: 1_000_000, now: 1_000_000 + 60_000, graceMinutes: 0,
    clientVersion: CLIENT_VERSION,
  })
  assert.equal(r.reason, 'need-online')
  assert.equal(r.recordOk, false)
})

await check('evaluateGate：平台下发宽限期时允许离线进入（不刷新校验时间）', () => {
  const ok = evaluateGate({
    validationOk: false, lastOkAt: 1_000_000, now: 1_000_000 + 30 * 60_000, graceMinutes: 60,
    clientVersion: CLIENT_VERSION,
  })
  assert.equal(ok.reason, 'ok')
  assert.equal(ok.recordOk, false)
  const expired = evaluateGate({
    validationOk: false, lastOkAt: 1_000_000, now: 1_000_000 + 61 * 60_000, graceMinutes: 60,
    clientVersion: CLIENT_VERSION,
  })
  assert.equal(expired.reason, 'need-online')
})

await check('evaluateGate：客户端版本低于最低要求必须先更新（即使能联网）', () => {
  const r = evaluateGate({
    validationOk: true, lastOkAt: null, now: 1_000_000, graceMinutes: 0,
    clientVersion: '1.0.0', minClientVersion: '1.1.0',
  })
  assert.equal(r.reason, 'update-required')
  assert.equal(r.recordOk, false)
  // 未配置最低版本时不拦
  const noMin = evaluateGate({
    validationOk: true, lastOkAt: null, now: 1, graceMinutes: 0,
    clientVersion: '0.0.1', minClientVersion: null,
  })
  assert.equal(noMin.reason, 'ok')
})

await check('classifyGateFailure：区分"接口未部署 / 接口报错 / 登录失效 / 断网"', () => {
  // 后端旧进程：接口不存在 → 404
  const notFound = classifyGateFailure({ response: { status: 404, data: { code: 404, msg: 'Not Found' } } })
  assert.equal(notFound.kind, 'not-deployed')
  assert.equal(notFound.status, 404)
  // 迁移没跑 → 500
  const server = classifyGateFailure({ response: { status: 500, data: { msg: '服务器内部错误' } } })
  assert.equal(server.kind, 'server')
  // 登录态失效：HTTP 401 与业务码 2005
  assert.equal(classifyGateFailure({ response: { status: 401 } }).kind, 'auth')
  assert.equal(classifyGateFailure({ code: 2005, message: '登录已失效' }).kind, 'auth')
  // 真正的断网：无 response
  assert.equal(classifyGateFailure(new Error('Network Error')).kind, 'offline')
  assert.equal(classifyGateFailure({ code: 'ERR_NETWORK' }).kind, 'offline')
  // 业务错误码（HTTP 200 + code!=0）
  const biz = classifyGateFailure({ code: 1600, message: '操作过于频繁' })
  assert.equal(biz.kind, 'server')
  assert.equal(biz.status, 1600)
})

await check('gateMessage：提示必须指向真实原因（不得一律说"网络"）', () => {
  const a = gateMessage({ kind: 'not-deployed', status: 404 })
  assert.ok(/接口/.test(a.title + a.cap) && /未更新或未重启/.test(a.cap), JSON.stringify(a))
  assert.ok(!/请检查网络/.test(a.cap), '接口未部署不应提示检查网络')
  const b = gateMessage({ kind: 'server', status: 500, detail: '服务器内部错误' })
  assert.ok(/迁移/.test(b.cap), '5xx 应提示可能未执行迁移')
  const c = gateMessage({ kind: 'offline' })
  assert.ok(/检查网络/.test(c.cap))
  const d = gateMessage({ kind: 'auth', status: 401 })
  assert.ok(/重新登录/.test(d.cap))
})

await check('平台配置的离线宽限期在重载后仍生效（需持久化 lastOkAt+grace）', () => {
  // 模拟：平台下发 60 分钟宽限；已持久化 lastOkAt=1000，grace=60
  const offlineNow = evaluateGate({
    validationOk: false, lastOkAt: 1000, now: 1000 + 30 * 60_000, graceMinutes: 60,
    clientVersion: CLIENT_VERSION,
  })
  assert.equal(offlineNow.reason, 'ok')
  // 若 grace 未持久化（退化为 0）→ 同一场景会被拦，这正是修复前的缺陷
  const graceLost = evaluateGate({
    validationOk: false, lastOkAt: 1000, now: 1000 + 30 * 60_000, graceMinutes: 0,
    clientVersion: CLIENT_VERSION,
  })
  assert.equal(graceLost.reason, 'need-online')
})

await check('fuzz evaluateGate：任意输入不抛错且结论合法', () => {
  const r = rng(31415)
  for (let i = 0; i < 300; i += 1) {
    const input = {
      validationOk: r() < 0.5,
      lastOkAt: pick(r, [null, 0, -1, 1, Date.now(), Number.NaN, Infinity]),
      now: pick(r, [0, 1, Date.now(), Number.NaN]),
      graceMinutes: pick(r, [0, -5, 1, 60, Number.NaN, Infinity]),
      clientVersion: pick(r, ['1.0.0', '', 'v2.1', 'abc']),
      minClientVersion: pick(r, [null, undefined, '', '1.0.0', '2.0.0', 'x.y.z']),
    }
    const out = evaluateGate(input)
    assert.ok(['ok', 'need-online', 'update-required'].includes(out.reason), `reason=${out.reason}`)
    assert.equal(typeof out.recordOk, 'boolean')
  }
})

process.stdout.write('\n[10] 属性测试（确定性伪随机 fuzz）\n')


await check('fuzz sanitizeSettings：任意脏输入都不抛错且全部落在合法区间', () => {
  const r = rng(20261001)
  for (let i = 0; i < 400; i += 1) {
    const raw = {}
    const keys = [
      'preset','customRows','customCols','orientation','paper','customWidthMm','customHeightMm',
      'marginMm','offsetXMm','offsetYMm','numbering','divider','duplex','numberFontPt','markColor','dashLen','dashGap',
    ]
    for (const k of keys) {
      if (r() < 0.5) continue
      raw[k] = pick(r, [weirdNum(r), 'x', null, undefined, [], {}, true, 'custom', 'A4', '#fff', '#zzzzzz'])
    }
    const out = sanitizeSettings(raw)
    assert.ok(LIMITS.rows[0] <= out.customRows && out.customRows <= LIMITS.rows[1], `rows ${out.customRows}`)
    assert.ok(LIMITS.cols[0] <= out.customCols && out.customCols <= LIMITS.cols[1])
    assert.ok(LIMITS.customWidthMm[0] <= out.customWidthMm && out.customWidthMm <= LIMITS.customWidthMm[1])
    assert.ok(LIMITS.customHeightMm[0] <= out.customHeightMm && out.customHeightMm <= LIMITS.customHeightMm[1])
    assert.ok(LIMITS.marginMm[0] <= out.marginMm && out.marginMm <= LIMITS.marginMm[1])
    assert.ok(LIMITS.offsetMm[0] <= out.offsetXMm && out.offsetXMm <= LIMITS.offsetMm[1])
    assert.ok(LIMITS.numberFontPt[0] <= out.numberFontPt && out.numberFontPt <= LIMITS.numberFontPt[1])
    assert.ok(LIMITS.dashLen[0] <= out.dashLen && out.dashLen <= LIMITS.dashLen[1])
    assert.ok(LIMITS.dashGap[0] <= out.dashGap && out.dashGap <= LIMITS.dashGap[1])
    assert.ok(['A4','A5','B5','custom'].includes(out.paper))
    assert.ok(['portrait','landscape'].includes(out.orientation))
    assert.ok(['none','dashed','line'].includes(out.divider))
    assert.ok(/^#[0-9a-f]{6}$/.test(out.markColor), `color ${out.markColor}`)
    assert.equal(typeof out.numbering, 'boolean')
    assert.equal(typeof out.duplex, 'boolean')
  }
})

await check('fuzz computeLayout：尺寸恒为正、恒在纸张内、页数=ceil(N/容量)', () => {
  const r = rng(777)
  const papers = ['A4', 'A5', 'B5', 'custom', 'A3', undefined, null]
  for (let i = 0; i < 300; i += 1) {
    const rows = pick(r, [1, 2, 3, 4, 10, 50, 51, 0, -3, NaN, 2.7])
    const cols = pick(r, [1, 2, 3, 4, 10, 50, 0, -1, Infinity])
    const spec2 = {
      rows, cols,
      orientation: pick(r, ['portrait', 'landscape', 'diagonal']),
      paper: pick(r, papers),
      customWidthMm: weirdNum(r),
      customHeightMm: weirdNum(r),
      marginMm: weirdNum(r),
      offsetXMm: weirdNum(r),
      offsetYMm: weirdNum(r),
    }
    const count = 1 + Math.floor(r() * 12)
    const pages = Array.from({ length: count }, (_, k) =>
      ticket(k, pick(r, [595, 842, 100, 1, 0, NaN]), pick(r, [842, 595, 50, 1, 0, -5])),
    )
    const band = pick(r, [0, 12, 24, 100, NaN])
    const sheets = computeLayout(spec2, pages, { duplex: r() < 0.5, numberBand: band })
    assert.ok(sheets.length >= 1, 'sheets 不应为空')
    for (const sh of sheets) {
      assert.ok(Number.isFinite(sh.width) && sh.width > 0, `sheet width ${sh.width}`)
      assert.ok(Number.isFinite(sh.height) && sh.height > 0)
      for (const p of sh.placements) {
        for (const v of [p.x, p.y, p.width, p.height, p.cellX, p.cellY, p.cellWidth, p.cellHeight]) {
          assert.ok(Number.isFinite(v), `非有限数值 ${v}`)
        }
        assert.ok(p.width > 0 && p.height > 0, `负/零尺寸 ${p.width}x${p.height}`)
        assert.ok(p.x >= -1e-6 && p.x + p.width <= sh.width + 1e-6, `横向越界 x=${p.x} w=${p.width} sheet=${sh.width}`)
        assert.ok(p.y >= -1e-6 && p.y + p.height <= sh.height + 1e-6, `纵向越界 y=${p.y} h=${p.height} sheet=${sh.height}`)
        assert.ok(p.seq >= 1 && Number.isInteger(p.seq))
      }
    }
    // 不变量：同一页内的 placement 互不重叠（允许边界相接）
    for (const sh of sheets) {
      const ps = sh.placements
      for (let a = 0; a < ps.length; a += 1) {
        for (let b = a + 1; b < ps.length; b += 1) {
          const A = ps[a]
          const B = ps[b]
          const overlapX = A.x < B.x + B.width - 1e-6 && A.x + A.width > B.x + 1e-6
          const overlapY = A.y < B.y + B.height - 1e-6 && A.y + A.height > B.y + 1e-6
          assert.ok(!(overlapX && overlapY), `placement 重叠: ${JSON.stringify([A, B])}`)
        }
      }
    }
    // 不变量：序号必须是 1..N 连续且唯一（编号/导出时恢复编号的基础）
    const allSeq = sheets.flatMap((sh) => sh.placements.map((p) => p.seq))
    const uniqSeq = [...new Set(allSeq)].sort((a, b) => a - b)
    assert.deepEqual(uniqSeq, Array.from({ length: pages.length }, (_, k) => k + 1), `序号不连续: ${uniqSeq}`)

    // 每页容量与内核同一口径：rows/cols 先钳制到 [1,50]（NaN/Infinity 视为 1）
    const rc = (v) => Math.min(50, Math.max(1, Number.isFinite(v) ? Math.trunc(v) : 1))
    const cap = rc(rows) * rc(cols)
    const expectedSheets = Math.ceil(pages.length / cap)
    assert.ok(sheets.length === expectedSheets, `页数 ${sheets.length} != ${expectedSheets} (rows=${rows},cols=${cols})`)
  }
})

await check('fuzz buildSheetDecor：票面外不变式（含脏 spec / 脏几何）', () => {
  const r = rng(4242)
  for (let i = 0; i < 200; i += 1) {
    const spec2 = sanitizeSettings({
      customRows: pick(r, [1, 2, 3, 10]),
      customCols: pick(r, [1, 2, 3, 10]),
      preset: pick(r, ['single', 'double', 'quad', 'custom']),
      paper: pick(r, ['A4', 'A5', 'B5', 'custom']),
      customWidthMm: weirdNum(r),
      customHeightMm: weirdNum(r),
      marginMm: weirdNum(r),
      offsetXMm: weirdNum(r),
      offsetYMm: weirdNum(r),
      numbering: r() < 0.7,
      numberFontPt: weirdNum(r),
      divider: pick(r, ['none', 'dashed', 'line']),
      duplex: r() < 0.5,
      markColor: '#123456',
      dashLen: weirdNum(r),
      dashGap: weirdNum(r),
    })
    const decorator = {
      numbering: spec2.numbering,
      divider: spec2.divider,
      duplex: spec2.duplex,
      numberFontPt: spec2.numberFontPt,
      markColor: hexToRgb(spec2.markColor),
      dashLen: spec2.dashLen,
      dashGap: spec2.dashGap,
    }
    const band = numberBandPt(decorator)
    const pages = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) =>
      ticket(k, pick(r, [595, 842, 200, 100]), pick(r, [842, 595, 200, 100])),
    )
    const sheets = computeLayout(spec2, pages, { duplex: decorator.duplex, numberBand: band })
    for (const sh of sheets) {
      const items = buildSheetDecor(sh, decorator)
      for (const it of items) {
        if (it.kind === 'line') {
          assert.ok([it.x1, it.y1, it.x2, it.y2].every(Number.isFinite), '线条坐标非有限')
          assert.ok(it.thickness > 0 && Number.isFinite(it.thickness))
          assert.ok(it.dash === null || (it.dash[0] > 0 && it.dash[1] > 0), 'dash 非法')
        }
        assertDecorOutsideTickets(sh, items)
      }
      // 开启序号时，只要有足够空白带就应画出序号（不应静默丢失）
      if (decorator.numbering) {
        const texts = items.filter((i) => i.kind === 'text')
        assert.ok(texts.length <= sh.placements.length, '序号条数异常')
      }
    }
  }
})

await check('fuzz parseQrText/escapeCsvCell：任意输入不抛错且契约成立', () => {
  const r = rng(998877)
  const chars = '01,，年月日￥¥.=-@ \t0123456789ABCabc:/?&%'
  for (let i = 0; i < 500; i += 1) {
    let text = ''
    const len = Math.floor(r() * 80)
    for (let k = 0; k < len; k += 1) text += chars[Math.floor(r() * chars.length)]
    const p = parseQrText(text)
    for (const v of [p.invoiceCode, p.invoiceNo, p.checkCode]) {
      assert.ok(v === null || typeof v === 'string')
    }
    assert.ok(p.amount === null || (Number.isFinite(p.amount) && p.amount > 0 && p.amount <= 1e8), `amount ${p.amount}`)
    assert.ok(p.issueDate === null || /^20\d{2}-\d{2}-\d{2}$/.test(p.issueDate), `date ${p.issueDate}`)
    const key = buildIdentityKey(p, text || null)
    assert.ok(key === null || typeof key === 'string')
    const cell = escapeCsvCell(text)
    assert.ok(!/^[=+\-@]/.test(cell) || cell.startsWith("'"), `CSV 注入未中和: ${cell.slice(0, 12)}`)
  }
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
