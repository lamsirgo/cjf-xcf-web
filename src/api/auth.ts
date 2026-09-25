import request from './request'

export const getCaptcha = () => request.get<any, { captcha_id: string; image: string }>('/auth/captcha')
export const login = (data: { mobile: string; password: string }) =>
  request.post<any, { access_token: string; refresh_token: string }>('/auth/login', data)
export const register = (data: { mobile: string; password: string; captcha_id: string; captcha_code: string }) =>
  request.post<any, { access_token: string; refresh_token: string }>('/auth/register', data)
export const changePassword = (data: { old_password: string; new_password: string }) =>
  request.post('/auth/change-password', data)
export const getMe = () =>
  request.get<
    any,
    {
      id: number
      mobile: string
      nickname: string
      email: string | null
      quota_balance: number
      quota_frozen: number
    }
  >('/users/me')
/** 仅昵称可直接改；邮箱换绑必须走验证码接口 */
export const updateMe = (data: { nickname?: string }) => request.put('/users/me', data)
export const sendBindEmailCode = (email: string) => request.post('/users/me/email/code', { email })
export const bindEmail = (data: { email: string; email_code: string }) => request.put('/users/me/email', data)
export const sendResetCode = (mobile: string) =>
  request.post('/auth/forgot-password/send-code', { mobile })
export const resetPassword = (data: { mobile: string; email_code: string; new_password: string }) =>
  request.post('/auth/forgot-password/reset', data)
export const logout = (refreshToken: string) =>
  request.post('/auth/logout', { refresh_token: refreshToken })
