/** 文件集管理：导入校验、顺序增删、置顶置尾、清空。 */

import { computed, ref, type Ref } from 'vue'
import { parseFile, SUPPORTED_EXTS } from '@/lib/print/parse'
import type { PrintLimits, SourceFile, TicketPage } from '@/lib/print/types'

const MB = 1024 * 1024

export function useFileSet(limits: Ref<PrintLimits>) {
  const files = ref<SourceFile[]>([])
  const parsing = ref(false)

  const allPages = computed<TicketPage[]>(() => files.value.flatMap((f) => f.pages))
  const fileCount = computed(() => files.value.length)
  const pageCount = computed(() => allPages.value.length)
  const totalSize = computed(() => files.value.reduce((sum, f) => sum + f.size, 0))

  /** 校验并导入；任一文件不合规则整批拒绝（不产生半导入状态）。 */
  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    const lm = limits.value

    for (const f of incoming) {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase()
      if (!SUPPORTED_EXTS.includes(ext)) {
        throw new Error(`不支持的文件类型：${f.name}（仅支持 PDF / PNG / JPG）`)
      }
      if (f.size > lm.maxFileSizeMb * MB) {
        throw new Error(`单个文件不能超过 ${lm.maxFileSizeMb}MB：${f.name}`)
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
    try {
      // 顺序解析，避免大文件并发导致内存峰值过高
      for (const f of incoming) {
        const parsed = await parseFile(f)
        parsed.origFile = f
        files.value.push(parsed)
      }
    } finally {
      parsing.value = false
    }
  }

  function removeFile(id: string) {
    files.value = files.value.filter((f) => f.id !== id)
  }

  function clear() {
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
