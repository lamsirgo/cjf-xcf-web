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

// ---------------------------------------------------------------------------
// 分片上传（进度 + 断点续传）
// ---------------------------------------------------------------------------

export interface UploadProgressInfo {
  loaded: number
  total: number
  percent: number
}

const CHUNK_SIZE = 2 * 1024 * 1024
const RESUME_STORE_KEY = 'pkg-upload-resume-v1'

interface InitFileEntry {
  index: number
  filename: string
  uploaded: number[]
}

function loadResumeStore(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(RESUME_STORE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveResumeStore(map: Record<string, string>) {
  localStorage.setItem(RESUME_STORE_KEY, JSON.stringify(map))
}

function dropResume(hashes: string[]) {
  const map = loadResumeStore()
  let changed = false
  for (const h of hashes) {
    if (delete map[h]) changed = true
  }
  if (changed) saveResumeStore(map)
}

/** SHA-256 全量指纹；非安全上下文无 subtle 时退化为名称+大小+修改时间的弱指纹 */
async function fileHash(file: File): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const buf = await subtle.digest('SHA-256', await file.arrayBuffer())
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  const raw = `${file.name}|${file.size}|${file.lastModified}`
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return Math.abs(h).toString(16).padStart(64, '0')
}

function postChunk(
  sessionId: string,
  index: number,
  chunkIndex: number,
  blob: Blob,
  signal?: AbortSignal,
) {
  const form = new FormData()
  form.append('session_id', sessionId)
  form.append('index', String(index))
  form.append('chunk_index', String(chunkIndex))
  form.append('chunk', blob)
  return request.post('/packages/chunked/chunk', form, { signal, _silent: true } as never)
}

/**
 * 分片上传：带总进度回调，断网/中断后再次选择同一批文件自动跳过已传分片。
 * 单个分片最多自动重试 2 次；仍失败则抛出，由 UI 提示稍后续传。
 */
export async function uploadPackagesChunked(
  files: File[],
  onProgress?: (p: UploadProgressInfo) => void,
  signal?: AbortSignal,
) {
  const metas = await Promise.all(
    files.map(async (f) => ({
      filename: f.name,
      size: f.size,
      hash: await fileHash(f),
      chunk_size: CHUNK_SIZE,
    })),
  )
  const hashes = metas.map((m) => m.hash)
  const total = files.reduce((s, f) => s + f.size, 0)

  // 仅当本批所有文件指向同一个未删会话时才续传
  const store = loadResumeStore()
  const sessionIds = new Set(hashes.map((h) => store[h]).filter(Boolean))
  const resumeSession = sessionIds.size === 1 ? [...sessionIds][0] : undefined
  const idemKey = resumeSession ? undefined : uuid()

  const initData = await request.post<any, { session_id: string; files: InitFileEntry[] }>(
    '/packages/chunked/init',
    { files: metas, session_id: resumeSession, idempotency_key: idemKey },
  )
  const sessionId = initData.session_id
  const newStore = loadResumeStore()
  hashes.forEach((h) => {
    newStore[h] = sessionId
  })
  saveResumeStore(newStore)

  // 已上传字节数（续传时跳过的分片）
  let loaded = 0
  for (const entry of initData.files) {
    loaded += entry.uploaded.length * CHUNK_SIZE
    // 最后一片按实际大小修正，避免进度超过 100%
    const meta = metas.find((m) => m.filename === entry.filename)
    if (meta && entry.uploaded.includes(Math.ceil(meta.size / CHUNK_SIZE) - 1)) {
      const remainder = meta.size % CHUNK_SIZE || CHUNK_SIZE
      loaded += remainder - CHUNK_SIZE
    }
  }
  onProgress?.({ loaded, total, percent: Math.round((loaded / total) * 1000) / 10 })

  for (const entry of initData.files) {
    const file = files.find((f) => f.name === entry.filename)!
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const done = new Set(entry.uploaded)
    for (let ci = 0; ci < totalChunks; ci++) {
      if (done.has(ci)) continue
      const start = ci * CHUNK_SIZE
      const blob = file.slice(start, Math.min(start + CHUNK_SIZE, file.size))
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          await postChunk(sessionId, entry.index, ci, blob, signal)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (lastErr) throw lastErr
      loaded += blob.size
      onProgress?.({ loaded, total, percent: Math.round((loaded / total) * 1000) / 10 })
    }
  }

  const res = await request.post<any, { package_id: number; total_files: number }>(
    '/packages/chunked/complete',
    { session_id: sessionId },
  )
  dropResume(hashes)
  return res
}

export const listPackages = (page = 1) =>
  request.get<any, { list: PackageItem[]; total: number }>('/packages', { params: { page, page_size: 20 } })

export const retryPackage = (id: number) => request.post(`/packages/${id}/retry`)

export interface PackageFileItem {
  id: number
  orig_path: string
  ext: string
  size: number
  status: number
  status_text: string
  fail_reason: string
  fail_type: number
}

export const listPackageFiles = (id: number) =>
  request.get<any, { list: PackageFileItem[] }>(`/packages/${id}/files`)

export const fetchProgressTicket = (id: number) =>
  request.get<any, { ticket: string; expires_in: number }>(`/packages/${id}/progress-ticket`)

/** 先经 Authorization 头换取 15 分钟短时票据，再拼 SSE 地址，避免 JWT 出现在 URL 中 */
export const sseUrl = async (id: number) => {
  const { ticket } = await fetchProgressTicket(id)
  return `/api/v1/packages/${id}/progress?ticket=${encodeURIComponent(ticket)}`
}
