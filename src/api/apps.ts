import request from './request'

export interface AppItem {
  id: number
  code: string
  name: string
  icon: string
  path: string
  description: string
  sort: number
  is_default: number
  status: number // 0禁用 1启用 2内测中
  is_beta: boolean
  usable: boolean
}

/** 工作台金刚位：按用户可见范围过滤 */
export const listApps = () =>
  request.get<any, { list: AppItem[] }>('/apps')
