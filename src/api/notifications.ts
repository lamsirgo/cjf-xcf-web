import request from './request'

export interface NotificationItem {
  id: number
  title: string
  content: string
  is_read: number
  created_at: string | null
}

export const listNotifications = () =>
  request.get<any, { list: NotificationItem[] }>('/notifications')

export const readAllNotifications = () => request.post('/notifications/read-all')

export const fetchNotifyTicket = () =>
  request.get<any, { ticket: string; expires_in: number }>('/notifications/ticket')
