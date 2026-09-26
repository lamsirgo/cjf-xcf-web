import request from './request'

export interface QuotaLogItem {
  id: number
  change_type: number
  change_type_text: string
  change: number
  before: number
  after: number
  ref_id: number | null
  remark: string
  created_at: string | null
}

export interface QuotaLogPage {
  list: QuotaLogItem[]
  total: number
  page: number
  page_size: number
}

export const listQuotaLogs = (params: { page: number; page_size?: number }) =>
  request.get<any, QuotaLogPage>('/users/me/quota-logs', { params })
