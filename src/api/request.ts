import axios from 'axios'
import { showToast } from 'vant'

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 静默请求：失败时不弹全局提示，由调用方自行处理 */
    _silent?: boolean
    /** 401 重放标记（内部使用） */
    _retried?: boolean
  }
}

/** 业务错误：携带平台响应信封里的 code，便于调用方按错误码分支（如 1002 应用未开通） */
export class BizError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.name = 'BizError'
    this.code = code
  }
}

const request = axios.create({ baseURL: '/api/v1', timeout: 60000 })

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let refreshing: Promise<boolean> | null = null

/** 执行一次刷新请求并写入新令牌；其他标签页已完成轮换时也视为成功。 */
async function doRefresh(rt: string): Promise<boolean> {
  const before = localStorage.getItem('access_token')
  try {
    const resp = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    })
    const body = await resp.json()
    if (body.code === 0) {
      localStorage.setItem('access_token', body.data.access_token)
      // refresh 令牌轮换：服务端每次刷新都作废旧 refresh 并下发新令牌
      if (body.data.refresh_token) {
        localStorage.setItem('refresh_token', body.data.refresh_token)
      }
      return true
    }
  } catch {
    /* ignore */
  }
  // 并发刷新中落败（服务端 jti 锁返回 2004），但别的标签页已完成轮换：
  // 本地 access_token 已更新，本次重放直接用新令牌即可，不应登出
  const now = localStorage.getItem('access_token')
  return !!before && !!now && now !== before
}

// ---- 跨标签页刷新单飞：同一浏览器只允许一个标签页调用 /auth/refresh ----
// 多标签页共享 localStorage 里的同一枚 refresh token，并发刷新会触发服务端
// 轮换竞态检测导致全设备登出。用 BroadcastChannel 选举出唯一 leader。
interface RefreshMsg {
  t: 'ping' | 'busy' | 'start' | 'done'
  id?: string
  ok?: boolean
}

let channel: BroadcastChannel | null = null
try {
  channel = 'BroadcastChannel' in window ? new BroadcastChannel('auth-refresh-v1') : null
} catch {
  channel = null
}
let activeRefreshId: string | null = null
let doneWaiters: Array<(ok: boolean) => void> = []

channel?.addEventListener('message', (ev: MessageEvent<RefreshMsg>) => {
  const m = ev.data
  if (!m?.t) return
  // 有标签页询问是否正在刷新：leader 应答 busy
  if (m.t === 'ping' && activeRefreshId) channel?.postMessage({ t: 'busy' })
  if (m.t === 'done') {
    const waiters = doneWaiters
    doneWaiters = []
    waiters.forEach((w) => w(!!m.ok))
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function waitForRefreshDone(timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    doneWaiters.push(finish)
    setTimeout(() => finish(false), timeoutMs)
  })
}

async function tryRefreshToken(): Promise<boolean> {
  const rt = localStorage.getItem('refresh_token')
  if (!rt) return false
  if (refreshing) return refreshing
  refreshing = (async () => {
    // 不支持 BroadcastChannel 的老旧 webview：退回本标签页单飞
    if (!channel) return doRefresh(rt)

    // 1) 询问是否已有标签页在刷新，等待 busy 应答
    let busy = false
    const onBusy = (ev: MessageEvent<RefreshMsg>) => {
      if (ev.data?.t === 'busy') busy = true
    }
    channel.addEventListener('message', onBusy)
    channel.postMessage({ t: 'ping' })
    await sleep(120)
    channel.removeEventListener('message', onBusy)
    if (busy) return waitForRefreshDone()

    // 2) 同时自发参与的标签页走选举：id 最小者为唯一 leader
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    activeRefreshId = id
    let demote = false
    const onStart = (ev: MessageEvent<RefreshMsg>) => {
      const m = ev.data
      if (m?.t === 'start' && typeof m.id === 'string' && m.id < id) demote = true
    }
    channel.addEventListener('message', onStart)
    channel.postMessage({ t: 'start', id })
    await sleep(120)
    channel.removeEventListener('message', onStart)
    if (demote) {
      activeRefreshId = null
      return waitForRefreshDone()
    }

    // 3) leader 执行刷新，完成后广播结果；写令牌先于广播
    let ok = false
    try {
      ok = await doRefresh(rt)
    } finally {
      activeRefreshId = null
      channel.postMessage({ t: 'done', ok })
    }
    return ok
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** 清理登录态并跳转登录页；已在登录页时返回 false（交由调用方提示错误）。 */
function forceLogout(): boolean {
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  if (window.location.pathname === '/login') return false
  showToast('登录已失效，请重新登录')
  window.location.href = '/login'
  return true
}

request.interceptors.response.use(
  (resp) => {
    // 文件下载（blob）：直接返回 Blob，业务码判断不适用
    if (resp.data instanceof Blob) return resp.data
    const { code, msg, data } = resp.data
    if (code !== 0) {
      const config = resp.config as { _silent?: boolean } | undefined
      if (!config?._silent) showToast(msg || '操作失败')
      return Promise.reject(new BizError(msg || '操作失败', Number(code)))
    }
    return data
  },
  async (error) => {
    const status = error.response?.status
    let body = error.response?.data
    // blob 请求的失败响应也是 Blob，需解出 JSON 错误体
    if (body instanceof Blob) {
      try {
        body = JSON.parse(await body.text())
      } catch {
        body = undefined
      }
    }
    const config = error.config

    if (status === 401 && config) {
      // token 过期：尝试刷新一次后重放原请求
      if (body?.code === 2005 && !config._retried) {
        config._retried = true
        if (await tryRefreshToken()) return request(config)
        if (forceLogout()) return Promise.reject(error)
      } else if (body?.code === 2004) {
        // token 缺失/无效：直接登出
        if (forceLogout()) return Promise.reject(error)
      }
    }

    // 状态码语义化后，4xx/5xx 响应体仍是平台信封 {code,msg,data}：
    // 统一包装为 BizError 再 reject，保持调用方按业务码分支的契约
    // （如打印门禁依赖 code===1002 识别"应用停用"）
    const bizCode = Number(body?.code)
    if (body && Number.isInteger(bizCode) && bizCode !== 0) {
      if (!config?._silent) showToast(body?.msg || '操作失败')
      return Promise.reject(new BizError(body?.msg || '操作失败', bizCode))
    }

    if (!config?._silent) showToast(body?.msg || error.message || '网络错误')
    return Promise.reject(error)
  },
)

export default request
