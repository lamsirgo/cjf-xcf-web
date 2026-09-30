/**
 * 发票统计：去重结果派生、金额聚合（含去重金额）、统计复制与 CSV 导出。
 * 全部由识别结果纯函数派生，无网络请求。
 */

import { computed, type ComputedRef } from 'vue'
import {
  computeDuplicates,
  computeStats,
  type DupResult,
  type InvoiceStats,
} from '@/lib/print/qr'
import type { InvoiceMeta, RecognizeStatus, TicketPage } from '@/lib/print/types'

export interface ResolvedPage {
  page: TicketPage
  fileName: string
}

const STATUS_LABEL: Record<RecognizeStatus, string> = {
  recognized: '已识别',
  partial: '部分识别',
  unknown: '未识别',
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function csvCell(v: string | number | null): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function useInvoiceStats(
  getMetas: () => InvoiceMeta[],
  getIgnored: () => ReadonlySet<string>,
  resolvePage: (pageId: string) => ResolvedPage | null,
): {
  hasScanned: ComputedRef<boolean>
  dup: ComputedRef<DupResult>
  stats: ComputedRef<InvoiceStats>
  pendingManual: ComputedRef<{ meta: InvoiceMeta; page: TicketPage; fileName: string }[]>
  buildStatsText: () => string
  copyStats: () => Promise<void>
  exportCsv: () => void
} {
  const dup = computed(() => computeDuplicates(getMetas(), getIgnored()))
  const stats = computed(() => computeStats(getMetas(), dup.value))
  const hasScanned = computed(() => getMetas().length > 0)

  const pendingManual = computed(() =>
    getMetas()
      .filter((m) => m.status !== 'recognized')
      .map((meta) => {
        const resolved = resolvePage(meta.pageId)
        return resolved ? { meta, page: resolved.page, fileName: resolved.fileName } : null
      })
      .filter((x): x is { meta: InvoiceMeta; page: TicketPage; fileName: string } => Boolean(x)),
  )

  function buildStatsText(): string {
    const s = stats.value
    const lines = [
      `发票统计（共 ${s.total} 张）`,
      `已识别：${s.recognized} 张 · 部分识别：${s.partial} 张 · 未识别：${s.unknown} 张`,
      `已识别率：${(s.coverage * 100).toFixed(1)}%`,
      `发票金额合计：¥${fmtMoney(s.amountTotal)}（${s.amountCount} 张有金额）`,
      `去重金额：¥${fmtMoney(s.uniqueAmount)}（原 ¥${fmtMoney(s.amountTotal)}）`,
      `重复发票：${s.dupGroupCount} 组，共 ${s.dupTicketCount} 张重复副本`,
    ]
    return lines.join('\n')
  }

  async function copyStats() {
    await navigator.clipboard.writeText(buildStatsText())
  }

  function buildCsv(): string {
    const header = [
      '序号',
      '发票代码',
      '发票号码',
      '金额',
      '开票日期',
      '校验码',
      '识别状态',
      '重复标记',
      '来源文件',
    ]
    const ignored = getIgnored()
    const rows = getMetas().map((m, i) => {
      const resolved = resolvePage(m.pageId)
      let dupFlag = ''
      if (dup.value.dupPageIds.has(m.pageId)) dupFlag = '重复'
      else if (ignored.has(m.pageId)) dupFlag = '已撤销'
      return [
        i + 1,
        m.invoiceCode,
        m.invoiceNo,
        m.amount,
        m.issueDate,
        m.checkCode,
        STATUS_LABEL[m.status],
        dupFlag,
        resolved?.fileName ?? '',
      ]
    })
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  }

  function exportCsv() {
    const blob = new Blob(['﻿' + buildCsv()], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '发票统计结果.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  return {
    hasScanned,
    dup,
    stats,
    pendingManual,
    buildStatsText,
    copyStats,
    exportCsv,
  }
}
