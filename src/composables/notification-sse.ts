/**
 * 全局通知 SSE 管理器（单例，跨页面保持一条连接）。
 * 后端 /notifications/stream 转发用户频道全部事件，业务按 type 区分：
 *   notification  新站内通知
 *   finished      任务终态
 *   requeued      任务重投
 *   progress      任务解析进度（Tasks 页面另用任务级 SSE）
 */

import { ref } from 'vue'
import { fetchNotifyTicket, type NotificationItem } from '@/api/notifications'

export interface NotifyEvent {
  type: string
  notification?: NotificationItem
  [key: string]: unknown
}

export const sseConnected = ref(false)

type Handler = (event: NotifyEvent) => void
const handlers = new Set<Handler>()

let es: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 2000
let running = false

/** 订阅全部事件，返回取消订阅函数。 */
export function onNotifyEvent(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

function dispatch(raw: string) {
  try {
    const event = JSON.parse(raw) as NotifyEvent
    handlers.forEach((h) => h(event))
  } catch {
    /* 忽略无法解析的帧 */
  }
}

async function connect() {
  if (!running || es) return
  let ticket = ''
  try {
    ticket = (await fetchNotifyTicket()).ticket
  } catch {
    scheduleRetry()
    return
  }
  if (!running) return
  es = new EventSource(`/api/v1/notifications/stream?ticket=${encodeURIComponent(ticket)}`)
  es.onopen = () => {
    sseConnected.value = true
    retryDelay = 2000
  }
  es.onmessage = (e) => dispatch(e.data)
  es.onerror = () => {
    closeSource()
    sseConnected.value = false
    scheduleRetry()
  }
}

function closeSource() {
  if (es) {
    es.onopen = null
    es.onmessage = null
    es.onerror = null
    es.close()
    es = null
  }
}

function scheduleRetry() {
  if (!running) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, retryDelay)
  // 指数退避，上限 30 秒
  retryDelay = Math.min(retryDelay * 2, 30000)
}

export function startNotificationSse() {
  if (running) return
  running = true
  connect()
}

export function stopNotificationSse() {
  running = false
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  closeSource()
  sseConnected.value = false
}
