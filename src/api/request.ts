import axios from 'axios'
import { showToast } from 'vant'

const request = axios.create({ baseURL: '/api/v1', timeout: 60000 })

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let refreshing: Promise<boolean> | null = null

async function tryRefreshToken(): Promise<boolean> {
  const rt = localStorage.getItem('refresh_token')
  if (!rt) return false
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const resp = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        })
        const body = await resp.json()
        if (body.code === 0) {
          localStorage.setItem('access_token', body.data.access_token)
          return true
        }
      } catch {
        /* ignore */
      }
      return false
    })().finally(() => {
      refreshing = null
    })
  }
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
      showToast(msg || '操作失败')
      return Promise.reject(new Error(msg))
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
    const config = error.config as (typeof error.config & { _retried?: boolean }) | undefined

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

    showToast(body?.msg || error.message || '网络错误')
    return Promise.reject(error)
  },
)

export default request
