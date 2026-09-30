/**
 * 本地草稿（IndexedDB）：保存源文件与打印设置，可一键清理。
 * 票据字节仅存本地，不随任何请求上传。
 */

import type { InvoiceMeta } from '@/lib/print/types'

const DB_NAME = 'xcf_print'
const STORE = 'draft'
const KEY = 'v1'

export interface PrintDraft {
  savedAt: number
  files: File[]
  settings: unknown
  /** 识别结果（文本要素，体积小） */
  metas?: InvoiceMeta[]
  /** 已撤销重复标记的票据 pageId */
  dupIgnored?: string[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
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

export function useDraft() {
  function loadDraft(): Promise<PrintDraft | null> {
    return tx<PrintDraft | undefined>('readonly', (store) => store.get(KEY)).then(
      (v) => v ?? null,
    )
  }

  function saveDraft(
    files: File[],
    settings: unknown,
    metas?: InvoiceMeta[],
    dupIgnored?: string[],
  ): Promise<void> {
    const draft: PrintDraft = { savedAt: Date.now(), files, settings, metas, dupIgnored }
    return tx('readwrite', (store) => store.put(draft, KEY)).then(() => undefined)
  }

  function clearDraft(): Promise<void> {
    return tx('readwrite', (store) => store.delete(KEY)).then(() => undefined)
  }

  return { loadDraft, saveDraft, clearDraft }
}
