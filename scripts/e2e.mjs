#!/usr/bin/env node
/**
 * 浏览器 e2e 运行器（真实 Chrome，无需 Playwright）。
 *
 * 两趟验证：
 *  1) dev（Vite）加载 e2e/harness.html：真实 Worker / OffscreenCanvas / Comlink，
 *     覆盖「PDF 拆分、EXIF 转正像素、导出与 /Rotate 方向」；结果由页面 POST 回收集端点。
 *  2) prod（dist + 生产 CSP 头）：确认应用在**真实 CSP** 下能正常启动渲染，
 *     并检查 Chrome 是否报告 CSP 违规。
 *
 * 用法：cd web && npm run test:e2e
 */
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..')
const distDir = path.join(webRoot, 'dist')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEV_PORT = 5199
const PROD_PORT = 4181

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch {
      /* not ready */
    }
    if (Date.now() > deadline) throw new Error(`${label} 启动超时：${url}`)
    await wait(250)
  }
}

/** 静态服务 dist，并带上生产 CSP 头 + e2e 结果收集端点 */
function startProdServer() {
  let resolveResult = null
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve
  })
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }
    if (req.method === 'POST' && req.url === '/__result') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' })
        res.end('ok')
        resolveResult(JSON.parse(body))
      })
      return
    }
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath)
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html') // SPA 回退
    }
    const ext = path.extname(filePath)
    // ?nocsp=1：故意不发 CSP 响应头，用于验证 index.html 内 meta CSP 同样生效
    const omitHeader = (req.url ?? '').includes('nocsp=1')
    const headers = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      ...(omitHeader ? {} : { 'Content-Security-Policy': CSP }),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    }
    res.writeHead(200, headers)
    createReadStream(filePath).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(PROD_PORT, '127.0.0.1', () => resolve({ server, resultPromise }))
  })
}

function chromeArgs(userDataDir, extra = []) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--mute-audio',
    `--user-data-dir=${userDataDir}`,
    ...extra,
  ]
}

function runChrome(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function main() {
  const failures = []
  if (!existsSync(CHROME)) {
    log(`!! 未找到 Chrome（${CHROME}），跳过 e2e`)
    process.exit(0)
  }
  if (!existsSync(path.join(distDir, 'index.html'))) {
    log('!! dist 不存在，请先 pnpm build')
    process.exit(1)
  }

  // ---------- 1) dev harness ----------
  log('== 启动 Vite dev（e2e harness）==')
  const vite = spawn(
    path.join(webRoot, 'node_modules/.bin/vite'),
    ['--port', String(DEV_PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let viteOut = ''
  vite.stdout.on('data', (d) => (viteOut += d))
  vite.stderr.on('data', (d) => (viteOut += d))

  const { server: prodServer, resultPromise } = await startProdServer()
  const profileDev = mkdtempSync(path.join(tmpdir(), 'print-e2e-dev-'))
  const profileProd = mkdtempSync(path.join(tmpdir(), 'print-e2e-prod-'))

  try {
    await waitForHttp(`http://127.0.0.1:${DEV_PORT}/e2e/harness.html`, 60_000, 'Vite dev')

    log('== 运行 harness（真实 Worker/EXIF/导出）==')
    const chromeDev = runChrome(
      chromeArgs(profileDev, [
        '--enable-logging=stderr',
        `http://127.0.0.1:${DEV_PORT}/e2e/harness.html`,
      ]),
      180_000,
    )

    const result = await Promise.race([
      resultPromise,
      wait(170_000).then(() => null),
    ])
    ;(await chromeDev).code // 等 Chrome 退出/被杀

    if (!result) {
      failures.push('harness 未在 170s 内回传结果（可能 Worker/EXIF 路径异常）')
      log(`!! harness 超时；Vite 输出尾部：\n${viteOut.slice(-800)}`)
    } else {
      log(`== harness：${result.passed}/${result.total} 通过 ==`)
      if (result.debug && Object.keys(result.debug).length > 0) {
        log(`  · 诊断：${JSON.stringify(result.debug)}`)
      }
      for (const c of result.checks) {
        log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `\n      ${c.detail}`}`)
        if (!c.ok) failures.push(`[harness] ${c.name}: ${c.detail}`)
      }
    }

    // ---------- 2) prod + CSP ----------
    log('== 生产 CSP 冒烟（dist + 生产安全头）==')
    const prod = await runChrome(
      chromeArgs(profileProd, [
        '--enable-logging=stderr',
        '--virtual-time-budget=15000',
        '--dump-dom',
        `http://127.0.0.1:${PROD_PORT}/`,
      ]),
      90_000,
    )
    const dom = prod.stdout
    const rendered = /id="app"[\s\S]{0,4000}<(div|section|main)/.test(dom) || /van-|登录|手机号/.test(dom)
    if (!rendered) {
      failures.push('生产包在 CSP 下未渲染出应用壳（可能是 CSP 阻断脚本）')
      log(`!! DOM 片段：\n${dom.slice(0, 600)}`)
    } else {
      log('  ✓ 应用在真实 CSP 下正常渲染')
    }
    const violations = prod.stderr
      .split('\n')
      .filter((l) => /Content Security Policy|Refused to (load|execute|connect)/i.test(l))
    if (violations.length > 0) {
      failures.push(`CSP 违规 ${violations.length} 条`)
      log(`  ✗ CSP 违规：\n${violations.slice(0, 5).map((l) => `      ${l}`).join('\n')}`)
    } else {
      log('  ✓ 无 CSP 违规日志')
    }

    // 仅靠 index.html 内 meta CSP（无响应头）时也必须可用
    const metaTag = dom.includes('http-equiv="Content-Security-Policy"')
    if (!metaTag) failures.push('index.html 缺少 meta CSP（构建期注入失效）')
    const metaRun = await runChrome(
      chromeArgs(profileProd, [
        '--enable-logging=stderr',
        '--virtual-time-budget=15000',
        '--dump-dom',
        `http://127.0.0.1:${PROD_PORT}/?nocsp=1`,
      ]),
      90_000,
    )
    const metaRendered = /van-|登录|手机号/.test(metaRun.stdout)
    if (!metaRendered) failures.push('仅靠 meta CSP 时应用未能渲染')
    const metaViolations = metaRun.stderr
      .split('\n')
      .filter((l) => /Refused to (load|execute|connect)/i.test(l))
    if (metaViolations.length > 0) {
      failures.push(`meta CSP 下出现违规 ${metaViolations.length} 条`)
    }
    log(
      `  ${metaTag && metaRendered && metaViolations.length === 0 ? '✓' : '✗'} meta CSP 生效（无响应头也能正常运行，违规 ${metaViolations.length} 条）`,
    )
  } finally {
    vite.kill('SIGKILL')
    prodServer.close()
  }

  log('')
  if (failures.length > 0) {
    log(`e2e 失败 ${failures.length} 项：`)
    for (const f of failures) log(`  - ${f}`)
    process.exit(1)
  }
  log('e2e 全部通过。')
}

main().catch((err) => {
  log(`e2e 运行器异常：${err?.stack ?? err}`)
  process.exit(1)
})
