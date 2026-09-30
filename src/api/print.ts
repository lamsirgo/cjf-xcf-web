import request from './request'
import type { PrintLimits } from '@/lib/print/types'

/** 发票合并打印免费限量阈值 */
export const getPrintLimits = () => request.get<unknown, PrintLimits>('/print/limits')
