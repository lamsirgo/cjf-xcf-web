/**
 * 本地草稿：源文件字节优先存 OPFS（适合大二进制），设置/识别结果等元数据存 IndexedDB；
 * 环境不支持 OPFS 时整体回退 IndexedDB（结构化克隆 File）。
 * 票据字节仅存本地，不随任何请求上传。
 */

import type { InvoiceMeta } from '@/lib/print/types'

const DB_NAME = 'xcf_print'
const LEGACY_STORE = 'draft' // v1：整份草稿（含 File），兼作回退
const META_STORE = 'draft-meta' // v2：OPFS 元数据
const KEY = 'v1'
const OPFS_DIR = 'xcf-print-draft'

export interface PrintDraft {
  savedAt: number
  files: File[]
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
  v: 2
  savedAt: number
  settings: unknown
  files: DraftFileEntry[]
  metas?: InvoiceMeta[]
  dupIgnored?: string[]
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

const supportsOpfs =
  typeof navigator !== 'undefined' &&
  typeof navigator.storage?.getDirectory === 'function'

async function getDraftDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create: true })
}

/** TS 内置类型部分版本未声明异步迭代器，运行时支持 */
interface IterableDirHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

/** 清空草稿目录下全部条目 */
async function clearDir(dir?: FileSystemDirectoryHandle) {
  const d = (dir ?? (await getDraftDir())) as IterableDirHandle
  for await (const [name] of d.entries()) {
    await d.removeEntry(name, { recursive: true })
  }
}

async function saveOpfs(
  files: File[],
  settings: unknown,
  metas?: InvoiceMeta[],
  dupIgnored?: string[],
): Promise<void> {
  const dir = await getDraftDir()
  await clearDir(dir)

  const entries: DraftFileEntry[] = []
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i]
    const slot = String(i)
    const handle = await dir.getFileHandle(slot, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(f)
    } finally {
      await writable.close()
    }
    entries.push({
      slot,
      name: f.name,
      type: f.type,
      lastModified: f.lastModified,
      size: f.size,
    })
  }

  const meta: StoredDraftMeta = {
    v: 2,
    savedAt: Date.now(),
    settings,
    files: entries,
    metas,
    dupIgnored,
  }
  await dbTx(META_STORE, 'readwrite', (store) => store.put(meta, KEY))
}

async function loadOpfs(): Promise<PrintDraft | null> {
  const meta = await dbTx<StoredDraftMeta | undefined>(META_STORE, 'readonly', (store) =>
    store.get(KEY),
  )
  if (!meta) return null
  const dir = await getDraftDir()
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
    settings: meta.settings,
    metas: meta.metas,
    dupIgnored: meta.dupIgnored,
  }
}

/** 回退/兼容：整份草稿写入 IndexedDB */
function saveIdb(files: File[], settings: unknown, metas?: InvoiceMeta[], dupIgnored?: string[]) {
  const draft: PrintDraft = { savedAt: Date.now(), files, settings, metas, dupIgnored }
  return dbTx(LEGACY_STORE, 'readwrite', (store) => store.put(draft, KEY)).then(() => undefined)
}

export function useDraft() {
  async function loadDraft(): Promise<PrintDraft | null> {
    if (supportsOpfs) {
      try {
        const hit = await loadOpfs()
        if (hit) return hit
      } catch {
        /* 落到旧存储 */
      }
    }
    const legacy = await dbTx<PrintDraft | undefined>(LEGACY_STORE, 'readonly', (store) =>
      store.get(KEY),
    )
    return legacy ?? null
  }

  async function saveDraft(
    files: File[],
    settings: unknown,
    metas?: InvoiceMeta[],
    dupIgnored?: string[],
  ): Promise<void> {
    if (supportsOpfs) {
      try {
        await saveOpfs(files, settings, metas, dupIgnored)
        return
      } catch {
        /* OPFS 写入失败：回退 IDB */
      }
    }
    await saveIdb(files, settings, metas, dupIgnored)
  }

  async function clearDraft(): Promise<void> {
    if (supportsOpfs) {
      try {
        await clearDir()
      } catch {
        /* 目录不存在等，忽略 */
      }
    }
    await dbTx(LEGACY_STORE, 'readwrite', (store) => store.delete(KEY)).catch(() => {})
    await dbTx(META_STORE, 'readwrite', (store) => store.delete(KEY)).catch(() => undefined)
  }

  return { loadDraft, saveDraft, clearDraft }
}
