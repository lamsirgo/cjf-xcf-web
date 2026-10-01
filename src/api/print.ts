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
  /** 平台要求的最低客户端版本（低于则必须先更新） */
  minClientVersion?: string | null
  /** 离线宽限期（分钟）：0 = 每次启动都要联网校验（MD §8.1） */
  offlineGraceMinutes?: number
  capabilities: PrintCapabilities
  limits: PrintLimits
  usage: {
    exportPages: number
    events: number
    /** 平台每日导出页数上限与当日已用（K02） */
    dailyCap?: number
    usedToday?: number
    remainingToday?: number
  }
  privacy: { localOnly: boolean; cloudRetentionHours: number }
}

/** 导出前的配额许可（平台签发的一次性令牌） */
export interface QuotaGrant {
  token: string | null
  pages: number
  expiresIn: number
  dailyCap: number
  usedToday: number
  remainingToday: number
  /** false 表示平台侧配额存储降级（未拦截、未计量） */
  enforced: boolean
}

/** 启动必需：应用开关 + 能力位 + 免费限量阈值（票据数据不参与该请求） */
export const getPrintManifest = () =>
  request.get<unknown, PrintManifest>('/print/manifest', { _silent: true })

/** 免费限量阈值（兼容旧接口） */
export const getPrintLimits = () => request.get<unknown, PrintLimits>('/print/limits')

/** 申请一次性导出许可（K02）；超额时平台返回 RATE_LIMITED 业务码 */
export const consumePrintQuota = (pages: number, clientRequestId: string) =>
  request.post<unknown, QuotaGrant>('/print/quota/consume', { pages, clientRequestId })

export interface PrintUsageEvent {
  eventType: 'local_export'
  /** 页数（一次导出的输出页数） */
  quantity: number
  /** 幂等键（8~64 字符） */
  clientEventId: string
  /** 非票面元数据（不含任何发票字段） */
  detail?: Record<string, unknown>
  /** 导出前申请到的一次性许可（平台侧核销；降级时可为空） */
  quotaToken?: string | null
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
