/**
 * 原图查看（人工校正 D07 的配套能力）。
 *
 * 缩略图只有 90px 级别，根本无法核对发票号码/金额，因此提供"按需渲染原图"：
 * - 只渲染当前这一页，按需从内存字节生成，不落盘、不发网络请求；
 * - 关闭弹窗立即 revokeObjectURL，避免 SPA 内泄漏（复用同一 URL 时先回收）；
 * - 同一页重复打开时复用缓存，避免重复渲染。
 */

import { ref } from 'vue'
import { renderTicketPage } from '@/lib/print/parse'
import type { SourceFile, TicketPage } from '@/lib/print/types'

export interface OriginalTarget {
  name: string
  pageLabel: string
  url: string
}

export function useOriginalView() {
  const visible = ref(false)
  const loading = ref(false)
  const error = ref('')
  const target = ref<OriginalTarget | null>(null)

  /** 当前 URL 与其来源，用于复用/回收 */
  let currentKey = ''
  let currentUrl = ''

  function revoke() {
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl)
      currentUrl = ''
      currentKey = ''
    }
  }

  function close() {
    visible.value = false
    target.value = null
    error.value = ''
    revoke()
  }

  /**
   * 打开某张票据的原图。
   * @param width 目标像素宽度（默认 1400，约 A4 170dpi，足以看清票面文字）
   */
  async function open(file: SourceFile, page: TicketPage, width = 1400) {
    const key = `${file.id}:${page.sourcePage}:${width}`
    visible.value = true
    error.value = ''
    if (key === currentKey && currentUrl) {
      target.value = { name: file.name, pageLabel: page.name, url: currentUrl }
      return
    }
    loading.value = true
    target.value = null
    try {
      const blob = await renderTicketPage(file, page.sourcePage, width)
      const url = URL.createObjectURL(blob)
      revoke()
      currentKey = key
      currentUrl = url
      target.value = { name: file.name, pageLabel: page.name, url }
    } catch (err) {
      error.value = `原图加载失败：${(err as Error).message || '未知错误'}`
    } finally {
      loading.value = false
    }
  }

  return { visible, loading, error, target, open, close }
}
