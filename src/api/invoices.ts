import request from './request'

export interface InvoiceRow {
  id: number
  package_id: number
  package_filename: string
  invoice_code: string
  invoice_num: string
  invoice_type: string
  invoice_date: string
  purchaser_name: string
  purchaser_register_num: string
  seller_name: string
  seller_register_num: string
  total_amount: number
  result: string
  fail_reason: string
  fail_type: number
  duplicate: string
  dup_count: number
}

export const listInvoices = (params: {
  page?: number
  page_size?: number
  keywords?: string
  date_start?: string
  date_end?: string
  result?: string
}) => request.get<any, { list: InvoiceRow[]; total: number }>('/invoices', { params })

export const getInvoice = (id: number) =>
  request.get<any, { id: number; items: Record<string, string>[] } & InvoiceRow>(`/invoices/${id}`)

export interface InvoiceDetailData {
  id: number
  package_id: number
  file_id: number
  file_ext: string
  has_file: boolean
  fail_reason: string
  fail_type: number
  invoice_code: string
  invoice_num: string
  invoice_type: string
  invoice_date: string
  purchaser_name: string
  purchaser_register_num: string
  seller_name: string
  seller_register_num: string
  total_amount: number
  items: Record<string, string>[]
}

export const getInvoiceDetail = (id: number) => request.get<any, InvoiceDetailData>(`/invoices/${id}`)

/** 鉴权获取发票原图/原文件（Blob），前端转 objectURL 预览，避免 token 进 URL */
export const fetchInvoiceRaw = (id: number) =>
  request.get<any, Blob>(`/invoices/${id}/raw`, { responseType: 'blob' })

export interface InvoiceItemPayload {
  commodity_name: string
  commodity_type: string
  commodity_unit: string
  commodity_num: string
  commodity_price: string
  commodity_amount: string
  commodity_tax_rate: string
}

export interface UpdateInvoicePayload {
  invoice_code?: string
  invoice_num?: string
  invoice_type?: string
  invoice_date?: string
  purchaser_name?: string
  purchaser_register_num?: string
  seller_name?: string
  seller_register_num?: string
  total_amount?: number
  items?: InvoiceItemPayload[]
}

export const updateInvoice = (id: number, payload: UpdateInvoicePayload) =>
  request.patch<any, void>(`/invoices/${id}`, payload)

export const deleteInvoices = (ids: number[]) =>
  // FastAPI list[int] 接收重复键 ids=1&ids=2；axios v1 默认会序列化成 ids[]，必须显式指定
  request.delete<any, { deleted: number }>('/invoices', {
    params: { ids },
    paramsSerializer: { indexes: null },
  })

export interface CreateExportParams {
  package_id?: number
  keywords?: string
  date_start?: string
  date_end?: string
  result?: string
  fields?: string[]
}

export const createExport = (params: CreateExportParams = {}) =>
  request.post<any, { export_id: number }>('/exports', params)

export interface ExportRow {
  id: number
  package_id: number | null
  status: number
  download_url: string
  error_msg: string
  filters: Record<string, string> | null
  fields: string[] | null
  created_at: string
}

export const listExports = () => request.get<any, { list: ExportRow[] }>('/exports')

/** 链接过期/失效时一键重签：文件仍在保留期内则返回新签名 URL */
export const resignExport = (id: number) =>
  request.post<any, { download_url: string }>(`/exports/${id}/resign`)
