import request from './request'

export const getCaptcha = () => request.get<any, { captcha_id: string; image: string }>('/auth/captcha')
export const login = (data: { mobile: string; password: string }) =>
  request.post<any, { access_token: string; refresh_token: string }>('/auth/login', data)
export const register = (data: { mobile: string; password: string; captcha_id: string; captcha_code: string }) =>
  request.post<any, { access_token: string; refresh_token: string }>('/auth/register', data)
export const changePassword = (data: { old_password: string; new_password: string }) =>
  request.post('/auth/change-password', data)
export const getMe = () =>
  request.get<any, { id: number; mobile: string; nickname: string; email: string | null; quota_balance: number }>('/users/me')
export const updateMe = (data: { nickname?: string; email?: string }) => request.put('/users/me', data)
export const logout = (refreshToken: string) =>
  request.post('/auth/logout', { refresh_token: refreshToken })
