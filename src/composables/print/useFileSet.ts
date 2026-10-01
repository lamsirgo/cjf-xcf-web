/** 文件集管理：导入校验、顺序增删、置顶置尾、清空、资源回收。 */

import { computed, ref, type Ref } from 'vue'
import { parseFile, releaseFileThumbs, SUPPORTED_EXTS } from '@/lib/print/parse'
import { FALLBACK_LIMITS, type PrintLimits, type SourceFile, type TicketPage } from '@/lib/print/types'

const MB = 1024 * 1024

export function fileExtOf(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

/** 平台阈值兜底：脏配置（0/NaN/负数）不会导致「无上限」 */
function safeLimits(lm: PrintLimits): PrintLimits {
  const pick = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
  return {
    maxFiles: pick(lm?.maxFiles, FALLBACK_LIMITS.maxFiles),
    maxFileSizeMb: pick(lm?.maxFileSizeMb, FALLBACK_LIMITS.maxFileSizeMb),
    maxTotalSizeMb: pick(lm?.maxTotalSizeMb, FALLBACK_LIMITS.maxTotalSizeMb),
    maxExportPages: pick(lm?.maxExportPages, FALLBACK_LIMITS.maxExportPages),
  }
}

export function useFileSet(limits: Ref<PrintLimits>) {
  const files = ref<SourceFile[]>([])
  const parsing = ref(false)
  const parseProgress = ref({ done: 0, total: 0 })

  const allPages = computed<TicketPage[]>(() => files.value.flatMap((f) => f.pages))
  const fileCount = computed(() => files.value.length)
  const pageCount = computed(() => allPages.value.length)
  const totalSize = computed(() => files.value.reduce((sum, f) => sum + f.size, 0))

  /**
   * 校验并导入；校验或解析任一环节失败都整批回滚（不产生半导入状态）。
   * ids 用于草稿恢复时复用原文件 id（保证 pageId 稳定、识别结果可匹配）。
   */
  async function addFiles(list: FileList | File[], ids?: string[]) {
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    const lm = safeLimits(limits.value)

    for (const f of incoming) {
      const ext = fileExtOf(f.name)
      if (!SUPPORTED_EXTS.includes(ext)) {
        throw new Error(`不支持的文件类型：${f.name}（仅支持 PDF / PNG / JPG）`)
      }
      if (f.size > lm.maxFileSizeMb * MB) {
        throw new Error(`单个文件不能超过 ${lm.maxFileSizeMb}MB：${f.name}`)
      }
      if (f.size === 0) {
        throw new Error(`文件为空：${f.name}`)
      }
    }
    if (fileCount.value + incoming.length > lm.maxFiles) {
      throw new Error(`最多导入 ${lm.maxFiles} 个文件（当前已有 ${fileCount.value} 个）`)
    }
    const incomingSize = incoming.reduce((sum, f) => sum + f.size, 0)
    if (totalSize.value + incomingSize > lm.maxTotalSizeMb * MB) {
      throw new Error(`文件总大小不能超过 ${lm.maxTotalSizeMb}MB`)
    }

    parsing.value = true
    parseProgress.value = { done: 0, total: incoming.length }
    const parsedList: SourceFile[] = []
    try {
      // 顺序解析，避免大文件并发导致内存峰值过高
      for (let i = 0; i < incoming.length; i += 1) {
        const parsed = await parseFile(incoming[i], ids?.[i])
        parsed.origFile = incoming[i]
        parsedList.push(parsed)
        parseProgress.value = { done: i + 1, total: incoming.length }
      }
      // 全部成功后才提交，保证整批原子性
      files.value = [...files.value, ...parsedList]
    } catch (err) {
      parsedList.forEach(releaseFileThumbs)
      throw err
    } finally {
      parsing.value = false
    }
  }

  function removeFile(id: string) {
    const target = files.value.find((f) => f.id === id)
    if (target) releaseFileThumbs(target)
    files.value = files.value.filter((f) => f.id !== id)
  }

  function clear() {
    files.value.forEach(releaseFileThumbs)
    files.value = []
  }

  function moveFile(id: string, to: 'front' | 'back' | 'prev' | 'next') {
    const arr = [...files.value]
    const i = arr.findIndex((f) => f.id === id)
    if (i < 0) return
    const [item] = arr.splice(i, 1)
    if (to === 'front') arr.unshift(item)
    else if (to === 'back') arr.push(item)
    else if (to === 'prev') arr.splice(Math.max(0, i - 1), 0, item)
    else arr.splice(Math.min(arr.length, i + 1), 0, item)
    files.value = arr
  }

  return {
    files,
    parsing,
    parseProgress,
    allPages,
    fileCount,
    pageCount,
    totalSize,
    addFiles,
    removeFile,
    clear,
    moveFile,
  }
}
