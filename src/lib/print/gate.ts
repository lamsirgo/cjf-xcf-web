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

/** 门禁校验失败的原因分类（用于给出准确提示，而不是一律说"请检查网络"） */
export type GateFailureKind =
  | 'offline' // 网络不可达/超时
  | 'not-deployed' // 平台没有该接口（404/405）→ 后端未更新或未重启
  | 'server' // 平台接口报错（5xx / 业务错误码）
  | 'auth' // 登录态或权限问题
  | 'unknown'

export interface GateFailure {
  kind: GateFailureKind
  /** HTTP 状态码或业务码（有则展示，便于运维定位） */
  status?: number
  /** 平台返回的原始信息 */
  detail?: string
}

/**
 * 把启动校验的异常翻译成可诊断的原因。
 *
 * 背景：`/print/manifest` 是新增接口，若后端仍是旧进程会返回 404；
 * 这跟"用户断网"完全不同，提示必须区分，否则运维会一直去查网络。
 */
export function classifyGateFailure(err: unknown): GateFailure {
  const e = err as {
    code?: number | string
    message?: string
    response?: { status?: number; data?: { code?: number; msg?: string } }
  }
  const detail = e?.response?.data?.msg || e?.message
  const status = e?.response?.status
  if (typeof status === 'number') {
    if (status === 404 || status === 405) return { kind: 'not-deployed', status, detail }
    if (status === 401 || status === 403) return { kind: 'auth', status, detail }
    if (status >= 500) return { kind: 'server', status, detail }
    return { kind: 'unknown', status, detail }
  }
  // 业务码（HTTP 200 + code!=0 时由 axios 拦截器转成 BizError）
  if (typeof e?.code === 'number' && e.code !== 0) {
    if (e.code === 2004 || e.code === 2005) return { kind: 'auth', status: e.code, detail }
    return { kind: 'server', status: e.code, detail }
  }
  return { kind: 'offline', detail }
}

/** 门禁页面文案：不同原因给出不同指引 */
export function gateMessage(failure: GateFailure): { title: string; cap: string } {
  switch (failure.kind) {
    case 'not-deployed':
      return {
        title: '平台接口版本过旧',
        cap: `平台接口 /api/v1/print/manifest 不存在（HTTP ${failure.status ?? 404}），通常是后端未更新或未重启。请联系平台运维升级并重启服务后重试。`,
      }
    case 'server':
      return {
        title: '平台接口异常',
        cap: `平台在校验应用状态时返回错误${failure.status ? `（${failure.status}）` : ''}${failure.detail ? `：${failure.detail}` : ''}。若刚升级过后端，请确认已执行数据库迁移（alembic upgrade head）。`,
      }
    case 'auth':
      return {
        title: '登录状态已失效',
        cap: '请重新登录后再进入本应用。',
      }
    case 'offline':
      return {
        title: '无法连接平台接口',
        cap: '为保证应用状态有效，每次启动都需要联网校验成功（平台未配置离线宽限期）。请检查网络后重试；进入应用后断网仍可继续使用。',
      }
    default:
      return {
        title: '应用校验未通过',
        cap: `启动校验失败${failure.detail ? `：${failure.detail}` : ''}，请稍后重试或联系平台运维。`,
      }
  }
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
