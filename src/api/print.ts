import request from './request'
import type { PrintLimits } from '@/lib/print/types'

/** 应用能力位（平台下发；未授权的能力入口隐藏，服务端另有强制校验） */
export interface PrintCapabilities {
  layout: boolean
  dedup: boolean
  stats: boolean
  duplex: boolean
  cloudBatch: boolean
}

export interface PrintManifest {
  enabled: boolean
  appVersion: string
  capabilities: PrintCapabilities
  limits: PrintLimits
  usage: { exportPages: number; events: number }
  privacy: { localOnly: boolean; cloudRetentionHours: number }
}

/** 启动必需：应用开关 + 能力位 + 免费限量阈值（票据数据不参与该请求） */
export const getPrintManifest = () =>
  request.get<unknown, PrintManifest>('/print/manifest', { _silent: true })

/** 免费限量阈值（兼容旧接口） */
export const getPrintLimits = () => request.get<unknown, PrintLimits>('/print/limits')

export interface PrintUsageEvent {
  eventType: 'local_export'
  /** 页数（一次导出的输出页数） */
  quantity: number
  /** 幂等键（8~64 字符） */
  clientEventId: string
  /** 非票面元数据（不含任何发票字段） */
  detail?: Record<string, unknown>
}

/** 用量事件上报（K01；仅计数，不含票面字段） */
export const reportPrintUsage = (event: PrintUsageEvent) =>
  request.post<unknown, { accepted: boolean; duplicated: boolean; exportPages: number }>(
    '/print/usage/events',
    event,
    { _silent: true },
  )

/** 用量查询（K03，供前端展示；计费以平台为准） */
export const getPrintUsage = () =>
  request.get<unknown, { exportPages: number; events: number }>('/print/usage', { _silent: true })
