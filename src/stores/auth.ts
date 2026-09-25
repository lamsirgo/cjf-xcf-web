import { defineStore } from 'pinia'
import { getMe, logout as logoutApi } from '@/api/auth'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    accessToken: localStorage.getItem('access_token') || '',
    refreshToken: localStorage.getItem('refresh_token') || '',
    user: null as { id: number; mobile: string; nickname: string; email: string | null; quota_balance: number } | null,
  }),
  getters: {
    isLoggedIn: (s) => !!s.accessToken,
  },
  actions: {
    setTokens(access: string, refresh: string) {
      this.accessToken = access
      this.refreshToken = refresh
      localStorage.setItem('access_token', access)
      localStorage.setItem('refresh_token', refresh)
    },
    async fetchMe() {
      this.user = await getMe()
    },
    async refreshAccess(): Promise<boolean> {
      try {
        const resp = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        })
        const body = await resp.json()
        if (body.code === 0) {
          this.setTokens(body.data.access_token, this.refreshToken)
          return true
        }
      } catch { /* ignore */ }
      return false
    },
    logout() {
      // 通知服务端加入黑名单（静默失败不影响本地清除）
      if (this.refreshToken) {
        logoutApi(this.refreshToken).catch(() => {})
      }
      this.accessToken = ''
      this.refreshToken = ''
      this.user = null
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
    },
  },
})
