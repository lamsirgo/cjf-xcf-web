import request from './request'

export interface PackageItem {
  id: number
  filename: string
  total_files: number
  success_files: number
  failed_files: number
  duplicate_files?: number
  done_files: number | null
  status: number
  status_text: string
  error_msg: string
  queue_pos: number | null
  progress: number
  cost_time: number
  created_at: string
}

/** 幂等 key 生成：crypto.randomUUID 在非安全上下文（http 内网 IP）下可能不存在，做兜底 */
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export const uploadPackages = (files: File[]) => {
  const form = new FormData()
  files.forEach((f) => form.append('files', f))
  // 幂等 key：断网重试同一批文件时不会重复建包
  const key = uuid()
  return request.post<any, { package_id: number; total_files: number }>('/packages/upload', form, {
    timeout: 300000,
    headers: { 'Idempotency-Key': key },
  })
}

export const listPackages = (page = 1) =>
  request.get<any, { list: PackageItem[]; total: number }>('/packages', { params: { page, page_size: 20 } })

export const retryPackage = (id: number) => request.post(`/packages/${id}/retry`)

export const listPackageFiles = (id: number) =>
  request.get<any, { list: { id: number; orig_path: string; status_text: string; fail_reason: string }[] }>(
    `/packages/${id}/files`,
  )

export const fetchProgressTicket = (id: number) =>
  request.get<any, { ticket: string; expires_in: number }>(`/packages/${id}/progress-ticket`)

/** 先经 Authorization 头换取 15 分钟短时票据，再拼 SSE 地址，避免 JWT 出现在 URL 中 */
export const sseUrl = async (id: number) => {
  const { ticket } = await fetchProgressTicket(id)
  return `/api/v1/packages/${id}/progress?ticket=${encodeURIComponent(ticket)}`
}
