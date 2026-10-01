import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

/**
 * 把第三方字体 URL 换成本地文件（此处是 Vant 图标字体的 at.alicdn.com 兜底源）。
 * 目的：
 * - 页面加载零第三方请求（G05「票据与运行环境不出本地」的工程化约束）；
 * - 严格 CSP（font-src 'self'）下不再出现被拦截的外部字体请求。
 * 若构建时仍发现外部字体 URL，直接让构建失败，避免回归。
 */
function localizeRemoteFonts(): Plugin {
  const REMOTE_FONT = /url\(\s*(['"]?)(?:https?:)?\/\/[^)'"]+\1\s*\)/g
  return {
    name: 'xcf-localize-remote-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.(css|scss|sass|less|styl|vue)(\?|$)/.test(id)) return null
      if (!REMOTE_FONT.test(code)) return null
      REMOTE_FONT.lastIndex = 0
      const next = code.replace(REMOTE_FONT, 'url(/fonts/vant-icon.woff)')
      if (/(?:https?:)?\/\/[^)"'\s]+\.(?:woff2?|ttf|otf|eot)/i.test(next)) {
        throw new Error(`[localizeRemoteFonts] 仍存在外部字体 URL：${id}`)
      }
      return { code: next, map: null }
    },
  }
}

/**
 * 构建期把 CSP 写进 index.html（生产环境另有 Caddy 响应头，二者保持一致）。
 * 目的：即使部署在剥离响应头的代理/静态托管后面，「票据不出本地」的 connect-src
 * 约束仍然生效。meta 形式无法表达 frame-ancestors，故此处省略该项。
 */
function injectCspMeta(): Plugin {
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
  ].join('; ')
  const TAG = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
  return {
    name: 'xcf-inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      if (html.includes('http-equiv="Content-Security-Policy"')) return html
      return html.replace('</head>', `    ${TAG}\n  </head>`)
    },
  }
}

export default defineConfig({
  plugins: [localizeRemoteFonts(), injectCspMeta(), vue()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/files': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
