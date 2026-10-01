/**
 * 启动门禁（纯函数）。
 *
 * 依据 MD §8.1（关闭应用 = 强制失效）与 I05（版本对齐）：
 * - 每次启动都必须联网校验成功才能进入（`maxOfflineGraceMinutes` 默认 0）；
 * - 平台可下发宽限期，宽限期内允许离线使用（`offlineGraceMinutes > 0`）；
 * - 运行中的会话内断网不影响已进入的应用（刷新/重开才需要再次校验）；
 * - 客户端版本低于 `minClientVersion` 时要求先更新，避免旧客户端打到新契约。
 */

/** 应用自身版本（与平台 manifest.appVersion 对应，发版时同步） */
export const CLIENT_VERSION = '1.1.0'

export type GateReason = 'ok' | 'need-online' | 'update-required'

export interface GateInput {
  /** 本次启动的联网校验是否成功（false 含"离线"与"平台拒绝但已单独处理"两种） */
  validationOk: boolean
  /** 最近一次校验成功的时间戳（ms），null 表示从未成功过 */
  lastOkAt: number | null
  /** 当前时间（ms），显式传入便于测试 */
  now: number
  /** 平台允许的离线宽限期（分钟），0 = 必须每次启动都校验 */
  graceMinutes: number
  /** 当前客户端版本 */
  clientVersion: string
  /** 平台要求的最低客户端版本（可空） */
  minClientVersion?: string | null
}

export interface GateResult {
  reason: GateReason
  /** 是否应记录本次校验成功时间 */
  recordOk: boolean
}

/** 语义化版本比较：a>b → 1，a<b → -1，相等 → 0（非法段按 0 处理） */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      // 预发布/构建后缀不参与比较（1.0.0-beta.1 视为 1.0.0）
      .replace(/[-+].*$/, '')
      .split('.')
      .map((seg) => {
        const n = Number.parseInt(seg, 10)
        return Number.isFinite(n) ? n : 0
      })
  const av = norm(a)
  const bv = norm(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i += 1) {
    const x = av[i] ?? 0
    const y = bv[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

export function evaluateGate(input: GateInput): GateResult {
  const min = input.minClientVersion?.trim()
  if (min && compareVersions(input.clientVersion, min) < 0) {
    // 版本过低：即使能联网也必须先更新（否则可能按旧契约调用新接口）
    return { reason: 'update-required', recordOk: false }
  }
  if (input.validationOk) {
    return { reason: 'ok', recordOk: true }
  }
  const graceMs = Math.max(0, Number.isFinite(input.graceMinutes) ? input.graceMinutes : 0) * 60_000
  if (input.lastOkAt !== null && input.now - input.lastOkAt <= graceMs && graceMs > 0) {
    return { reason: 'ok', recordOk: false }
  }
  return { reason: 'need-online', recordOk: false }
}
