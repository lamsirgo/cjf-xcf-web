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

export const deleteInvoices = (ids: number[]) => request.delete<any, { deleted: number }>('/invoices', { params: { ids } })

export const createExport = (package_id?: number) => request.post<any, { export_id: number }>('/exports', { package_id })
export const listExports = () =>
  request.get<any, { list: { id: number; status: number; download_url: string; error_msg: string; created_at: string }[] }>(
    '/exports',
  )
