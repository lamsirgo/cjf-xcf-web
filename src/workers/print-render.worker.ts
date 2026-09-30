/**
 * 合并 PDF 渲染 Worker：导出不阻塞主线程。
 * 输入文件字节经结构化克隆传入，主线程文件集不受影响。
 */

import * as Comlink from 'comlink'
import type { DecorItem } from '@/lib/print/decor'
import { renderCalibrationPdf, renderPdf } from '@/lib/print/render'
import type { SheetLayout } from '@/lib/print/types'

const api = {
  async render(
    sheets: SheetLayout[],
    decor: DecorItem[][],
    files: Parameters<typeof renderPdf>[0]['files'],
  ): Promise<Uint8Array> {
    return renderPdf({ sheets, decor, files })
  },

  async renderCalibration(
    widthPt: number,
    heightPt: number,
    offsetXPt: number,
    offsetYPt: number,
  ): Promise<Uint8Array> {
    return renderCalibrationPdf({ widthPt, heightPt, offsetXPt, offsetYPt })
  },
}

Comlink.expose(api)

export type PrintWorkerApi = typeof api
