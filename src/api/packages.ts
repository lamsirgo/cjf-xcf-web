import request from './request'

export interface PackageItem {
  id: number
  filename: string
  total_files: number
  success_files: number
  failed_files: number
  done_files: number | null
  status: number
  status_text: string
  error_msg: string
  queue_pos: number | null
  progress: number
  cost_time: number
  created_at: string
}

export const uploadPackages = (files: File[]) => {
  const form = new FormData()
  files.forEach((f) => form.append('files', f))
  // 幂等 key：断网重试同一批文件时不会重复建包
  const key = crypto.randomUUID()
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

export const sseUrl = (id: number, token: string) => `/api/v1/packages/${id}/progress?token=${encodeURIComponent(token)}`
