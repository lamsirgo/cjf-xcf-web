#!/usr/bin/env node
/**
 * 构建期「扫码审计」（G05）：确认产物里没有会真正发起请求的外部域。
 *
 * 用法：node scripts/audit-external.mjs [distDir]
 *
 * 三类判定：
 * - allow：库内部字符串，不产生网络请求（XML/SVG 命名空间、警告链接、正则测试串）；
 * - warn ：zxing-wasm 内置的默认 CDN 字符串常量（运行期已被 locateFile 覆盖为同源 wasm，
 *          并且 CSP connect-src 'self' 会直接阻断），打印提醒但不失败；
 * - deny ：其它任何外部 host —— 直接失败，防止「票据不上传」被悄悄破坏。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const distDir = path.resolve(process.argv[2] ?? 'dist')

/** 不发起请求的既有字符串（库/框架内部） */
const ALLOW = new Set([
  'www.w3.org', // XML / SVG 命名空间
  'vuejs.org', // Vue 警告文档链接
  'github.com', // 依赖库注释里的仓库地址
  'example.com',
  'foo.bar',
  'localhost', // 库内正则/测试串
  'www.apache.org', // pdf.js 许可证头注释
  'www.xfa.org', // XFA 规范命名空间
  'ns.adobe.com', // XMP / XFA 命名空间
])

/** 已知且已缓解的外部字符串（仅提示） */
const WARN = new Set([
  'fastly.jsdelivr.net', // zxing-wasm 默认 locateFile，运行期被覆盖为同源 wasm
])

/**
 * 外部域检测：显式 http(s) URL，以及**协议相对 URL**（`//host/path`）。
 * 协议相对必须带定界符并要求后面跟路径/引号，否则会把压缩代码里的
 * `a//b.c` 之类误判成域名（早期版本还漏掉了 at.alicdn.com 这种写法）。
 */
const ABS_URL_RE = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,})/g
const PROTO_REL_URL_RE = /(?:["'(=\s,])\/\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,})(?=[/'")?\s,;]|$)/g
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.webmanifest', '.json'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (TEXT_EXT.has(path.extname(entry))) out.push(full)
  }
  return out
}

let denyHits = 0
let warnHits = 0
const files = walk(distDir)
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const hosts = new Map()
  const addHost = (h) => {
    const host = h.toLowerCase()
    hosts.set(host, (hosts.get(host) ?? 0) + 1)
  }
  for (const m of text.matchAll(ABS_URL_RE)) addHost(m[1])
  for (const m of text.matchAll(PROTO_REL_URL_RE)) addHost(m[1])
  for (const [host, count] of hosts) {
    const rel = path.relative(distDir, file)
    if (ALLOW.has(host)) continue
    if (WARN.has(host)) {
      warnHits += 1
      console.log(`  warn  ${rel}: ${host} ×${count}（库默认常量，运行期已覆盖；CSP connect-src 'self' 兜底）`)
      continue
    }
    denyHits += 1
    console.error(`  FAIL  ${rel}: 未白名单的外部域 ${host} ×${count}`)
  }
}

// ② 动态求值审计：CSP 未开 'unsafe-eval'，产物里不允许出现 eval / new Function
const EVAL_RE = /(^|[^.\w$])eval\s*\(|new\s+Function\s*\(/
/**
 * 已知安全片段豁免（精确字符串，非文件级白名单）。
 *
 * pdfjs 5.4.x（锁定版本，6.x 起依赖 Chrome 144+ 的 Map.getOrInsertComputed）
 * 残留两处 new Function，均不可利用：
 * 1. FeatureTest 能力探测 `new Function("")`：CSP 下直接抛错被 catch，
 *    isEvalSupported 恒为 false；
 * 2. PostScript 阴影编译器 `new Function("src",...)`：外层以
 *    isEvalSupported 为前置条件，探测失败时该分支不可达，回退 JS 解释器。
 * 用「移除已知片段后再检测」的方式放行：pdfjs 若升级引入任何新的
 * eval/new Function 用法，仍会命中并中止发布。
 */
const SAFE_EVAL_SNIPPETS = [
  'new Function("")',
  'new Function("src","srcOffset","dest","destOffset",',
]
let evalHits = 0
let exemptedHits = 0
for (const file of files) {
  if (!/\.(m?js)$/.test(file)) continue
  let text = readFileSync(file, 'utf8')
  for (const snippet of SAFE_EVAL_SNIPPETS) {
    const n = text.split(snippet).length - 1
    if (n > 0) {
      exemptedHits += n
      text = text.split(snippet).join('"__safe_eval_exempted__"')
    }
  }
  if (EVAL_RE.test(text)) {
    evalHits += 1
    console.error(`  FAIL  ${path.relative(distDir, file)}: 命中动态求值（eval / new Function）`)
  }
}
if (exemptedHits > 0) {
  console.log(`  info  pdfjs 已知安全片段豁免 ${exemptedHits} 处（FeatureTest 探测 / PS 编译器，CSP 下不可达）`)
}

console.log(
  `外部域审计：扫描 ${files.length} 个产物文件，禁止项 ${denyHits}，提醒项 ${warnHits}；动态求值命中 ${evalHits}（豁免 ${exemptedHits}）`,
)
if (denyHits > 0 || evalHits > 0) {
  console.error(
    '审计未通过：存在会外发请求的外部域或动态求值，发布中止（如确需保留，请先修改脚本白名单并说明理由）。',
  )
  process.exit(1)
}
