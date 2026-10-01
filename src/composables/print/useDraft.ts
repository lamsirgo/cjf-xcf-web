/**
 * 本地草稿：源文件字节优先存 OPFS（适合大二进制），设置/识别结果等元数据存 IndexedDB；
 * 环境不支持 OPFS 时整体回退 IndexedDB（结构化克隆 File）。
 * 票据字节仅存本地，不随任何请求上传。
 *
 * 隐私（M6）：
 * - 草稿按**登录用户**分区（IndexedDB key 与 OPFS 子目录都带用户前缀），
 *   同一浏览器换人登录不会看到上一位用户的票据；
 * - 旧版本的无归属草稿（key `v1`）在首次加载时直接清除，不做迁移（避免把 A 的票据给 B）；
 * - 草稿有保留期（默认 7 天），超期自动清理。
 *
 * 写入策略（L6/L7）：
 * - saveDraftFiles 只在文件集变化时调用（写入大二进制）；
 * - saveDraftMeta 只更新设置/识别结果（小记录），拖动边距滑杆不再重写全部票据字节；
 * - 所有写入串行化（内部队列），不会出现 clearDir 与写入交错的竞态。
 */

import type { InvoiceMeta } from '@/lib/print/types'

const DB_NAME = 'xcf_print'
const LEGACY_STORE = 'draft' // v1：整份草稿（含 File），兼作回退
const META_STORE = 'draft-meta' // v2+：OPFS 元数据
const LEGACY_KEY = 'v1'
const OPFS_ROOT = 'xcf-print-draft'
/** 草稿保留期：超过即视为过期（隐私最小化） */
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface PrintDraft {
  savedAt: number
  files: File[]
  /** 与 files 一一对应的文件 id：恢复时复用，保证 pageId 稳定 */
  fileIds?: string[]
  settings: unknown
  /** 识别结果（文本要素，体积小） */
  metas?: InvoiceMeta[]
  /** 已撤销重复标记的票据 pageId */
  dupIgnored?: string[]
}

interface DraftFileEntry {
  slot: string
  name: string
  type: string
  lastModified: number
  size: number
}

/** OPFS 路径存储的元数据（不含文件字节） */
interface StoredDraftMeta {
  v: 3
  savedAt: number
  settings: unknown
  files: DraftFileEntry[]
  fileIds?: string[]
  metas?: InvoiceMeta[]
  dupIgnored?: string[]
  /**
   * 文件字节是否已全部落盘。
   * 写入顺序：先写清单(ready=false) → 写字节 → 置 ready=true。
   * 中途被杀进程只会得到 ready=false，加载时视为无草稿，
   * 而不是"用新字节配上旧清单/旧识别结果"。
   */
  filesReady?: boolean
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LEGACY_STORE)) req.result.createObjectStore(LEGACY_STORE)
      if (!req.result.objectStoreNames.contains(META_STORE)) req.result.createObjectStore(META_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 单请求事务（get / put / delete） */
function dbTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode)
        const request = run(transaction.objectStore(storeName))
        request.onsuccess = () => {
          transaction.oncomplete = () => {
            db.close()
            resolve(request.result)
          }
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
      }),
  )
}

/** 读-改-写事务（用于只更新元数据，避免覆盖文件清单） */
function dbPatch<T>(
  storeName: string,
  key: string,
  patch: (prev: T | undefined) => T | undefined,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        const request = store.get(key)
        request.onsuccess = () => {
          const next = patch(request.result as T | undefined)
          if (next !== undefined) store.put(next, key)
        }
        request.onerror = () => {
          db.close()
          reject(request.error)
        }
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
        transaction.onerror = () => {
          db.close()
          reject(transaction.error)
        }
      }),
  )
}

const supportsOpfs =
  typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'

async function getRootDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_ROOT, { create: true })
}

async function getDraftDir(scope: string): Promise<FileSystemDirectoryHandle> {
  const root = await getRootDir()
  return root.getDirectoryHandle(scope, { create: true })
}

/** TS 内置类型部分版本未声明异步迭代器，运行时支持 */
interface IterableDirHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

/** 清空指定目录下全部条目 */
async function clearDir(dir?: FileSystemDirectoryHandle) {
  const d = (dir ?? (await getRootDir())) as IterableDirHandle
  for await (const [name] of d.entries()) {
    await d.removeEntry(name, { recursive: true })
  }
}

/** 清除旧版本无归属草稿（避免跨用户读到上一位用户的票据） */
async function purgeLegacy(): Promise<void> {
  await dbTx(LEGACY_STORE, 'readwrite', (store) => store.delete(LEGACY_KEY)).catch(() => undefined)
  await dbTx(META_STORE, 'readwrite', (store) => store.delete(LEGACY_KEY)).catch(() => undefined)
  if (!supportsOpfs) return
  try {
    const root = await getRootDir()
    await (root as IterableDirHandle).removeEntry(LEGACY_KEY, { recursive: true })
  } catch {
    /* 旧目录不存在：忽略 */
  }
}

/** 写入文件字节（仅文件集变化时调用） */
async function saveOpfsFiles(scope: string, files: File[], fileIds?: string[]): Promise<void> {
  const dir = await getDraftDir(scope)
  const prev = await dbTx<StoredDraftMeta | undefined>(META_STORE, 'readonly', (s) => s.get(scope))

  const entries: DraftFileEntry[] = files.map((f, i) => ({
    slot: String(i),
    name: f.name,
    type: f.type,
    lastModified: f.lastModified,
    size: f.size,
  }))

  // ① 先写清单并标记未就绪（此时旧字节仍在，若此刻崩溃 → 加载视为无草稿）
  await dbPatch<StoredDraftMeta>(META_STORE, scope, (old) => ({
    v: 3,
    savedAt: Date.now(),
    settings: old?.settings ?? {},
    metas: old?.metas,
    dupIgnored: old?.dupIgnored,
    files: entries,
    fileIds,
    filesReady: false,
  }))

  // ② 写字节
  for (let i = 0; i < files.length; i += 1) {
    const handle = await dir.getFileHandle(String(i), { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(files[i])
    } finally {
      await writable.close()
    }
  }
  // ③ 文件数变少时清掉多余槽位
  const stale = Math.max(0, (prev?.files?.length ?? 0) - files.length)
  for (let i = 0; i < stale; i += 1) {
    try {
      await (dir as IterableDirHandle).removeEntry(String(files.length + i))
    } catch {
      /* 槽位不存在：忽略 */
    }
  }

  // ④ 全部落盘后才标记就绪
  await dbPatch<StoredDraftMeta>(META_STORE, scope, (old) =>
    old ? { ...old, v: 3, filesReady: true, savedAt: Date.now() } : undefined,
  )
}

/** 只更新元数据（设置/识别结果），不碰文件字节 */
async function saveOpfsMeta(
  scope: string,
  settings: unknown,
  metas?: InvoiceMeta[],
  dupIgnored?: string[],
): Promise<void> {
  await dbPatch<StoredDraftMeta>(META_STORE, scope, (old) => {
    // 没有文件草稿、或上一次写字节尚未完成时不单独保存设置（设置在 localStorage 里）
    if (!old || old.filesReady !== true) return undefined
    return { ...old, v: 3, savedAt: Date.now(), settings, metas, dupIgnored }
  })
}

async function loadOpfs(scope: string): Promise<PrintDraft | null> {
  const meta = await dbTx<StoredDraftMeta | undefined>(META_STORE, 'readonly', (store) =>
    store.get(scope),
  )
  if (!meta || meta.filesReady !== true) return null
  const dir = await getDraftDir(scope)
  const files = await Promise.all(
    meta.files.map(async (entry) => {
      const handle = await dir.getFileHandle(entry.slot)
      const blob = await handle.getFile()
      return new File([blob], entry.name, {
        type: entry.type,
        lastModified: entry.lastModified,
      })
    }),
  )
  return {
    savedAt: meta.savedAt,
    files,
    fileIds: meta.fileIds,
    settings: meta.settings,
    metas: meta.metas,
    dupIgnored: meta.dupIgnored,
  }
}

/** 回退/兼容：整份草稿写入 IndexedDB（同样按用户分区） */
function saveIdbFiles(scope: string, files: File[], fileIds?: string[]): Promise<void> {
  return dbPatch<PrintDraft & { filesReady?: boolean }>(LEGACY_STORE, scope, (old) => ({
    savedAt: Date.now(),
    files,
    fileIds,
    settings: old?.settings ?? {},
    metas: old?.metas,
    dupIgnored: old?.dupIgnored,
    filesReady: true,
  }))
}

function saveIdbMeta(
  scope: string,
  settings: unknown,
  metas?: InvoiceMeta[],
  dupIgnored?: string[],
): Promise<void> {
  return dbPatch<PrintDraft>(LEGACY_STORE, scope, (old) =>
    old ? { ...old, savedAt: Date.now(), settings, metas, dupIgnored } : undefined,
  )
}

/**
 * @param getScope 草稿归属（登录用户标识）；不同用户互不可见
 */
export function useDraft(getScope: () => string) {
  let legacyPurged = false
  /** 写入串行队列：避免 clearDir / 写入交错造成草稿目录缺文件 */
  let chain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function scope(): string {
    const s = (getScope() || '').trim()
    return s ? `u_${s}` : 'anon'
  }

  async function ensureLegacyPurged() {
    if (legacyPurged) return
    legacyPurged = true
    await purgeLegacy()
  }

  function clearDraft(): Promise<void> {
    return enqueue(async () => {
      const key = scope()
      if (supportsOpfs) {
        try {
          await clearDir(await getDraftDir(key))
        } catch {
          /* 目录不存在等，忽略 */
        }
      }
      await dbTx(LEGACY_STORE, 'readwrite', (store) => store.delete(key)).catch(() => undefined)
      await dbTx(META_STORE, 'readwrite', (store) => store.delete(key)).catch(() => undefined)
      await purgeLegacy()
    })
  }

  async function loadDraft(): Promise<PrintDraft | null> {
    await chain.catch(() => undefined) // 等未完成的写入落盘，避免读到中间态
    await ensureLegacyPurged()
    const key = scope()
    let hit: PrintDraft | null = null
    if (supportsOpfs) {
      try {
        hit = await loadOpfs(key)
      } catch {
        hit = null
      }
    }
    if (!hit) {
      hit =
        (await dbTx<PrintDraft | undefined>(LEGACY_STORE, 'readonly', (store) => store.get(key))) ??
        null
    }
    if (!hit) return null
    // 超期草稿：直接清理，不提示恢复
    if (!hit.savedAt || Date.now() - hit.savedAt > DRAFT_TTL_MS) {
      await clearDraft()
      return null
    }
    return hit
  }

  /** 文件集变化时调用（写大二进制） */
  function saveDraftFiles(files: File[], fileIds?: string[]): Promise<void> {
    return enqueue(async () => {
      const key = scope()
      if (supportsOpfs) {
        try {
          await saveOpfsFiles(key, files, fileIds)
          return
        } catch {
          /* OPFS 写入失败：回退 IDB */
        }
      }
      await saveIdbFiles(key, files, fileIds)
    })
  }

  /** 设置/识别结果变化时调用（小记录，不重写票据字节） */
  function saveDraftMeta(
    settings: unknown,
    metas?: InvoiceMeta[],
    dupIgnored?: string[],
  ): Promise<void> {
    return enqueue(async () => {
      const key = scope()
      if (supportsOpfs) {
        try {
          await saveOpfsMeta(key, settings, metas, dupIgnored)
          return
        } catch {
          /* 回退 IDB */
        }
      }
      await saveIdbMeta(key, settings, metas, dupIgnored)
    })
  }

  return { loadDraft, saveDraftFiles, saveDraftMeta, clearDraft }
}
