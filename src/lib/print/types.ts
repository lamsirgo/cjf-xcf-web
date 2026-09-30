/**
 * 发票合并打印内核 · 唯一数据契约。
 *
 * 约束：
 * - 内核只做纯计算，零 DOM、零 fetch；IO 由调用方（composables / worker）注入；
 * - 坐标一律以 PDF 用户空间 pt（1/72 英寸）为单位，Placement.y 从页面顶部起算；
 * - 装饰只允许画在票面之外（序号、分隔/裁切标记），绝不修改票面内容。
 */

/** 毫米 → pt（PDF 用户空间 72dpi） */
export const MM_TO_PT = 72 / 25.4

/** A4 纸张逻辑尺寸（pt） */
export const A4_WIDTH_PT = 210 * MM_TO_PT // 595.28
export const A4_HEIGHT_PT = 297 * MM_TO_PT // 841.89

export type Orientation = 'portrait' | 'landscape'
export type DividerStyle = 'none' | 'dashed' | 'line'

/** 纸张规格 */
export type PaperKind = 'A4' | 'A5' | 'B5' | 'custom'

export interface PaperSize {
  widthMm: number
  heightMm: number
}

/** 预置纸张（竖版物理尺寸） */
export const PAPER_SIZES: Record<Exclude<PaperKind, 'custom'>, PaperSize> = {
  A4: { widthMm: 210, heightMm: 297 },
  A5: { widthMm: 148, heightMm: 210 },
  B5: { widthMm: 176, heightMm: 250 },
}

/** 版式预设（1/2/4 张一页 + 自定义） */
export type LayoutPreset = 'single' | 'double' | 'quad' | 'custom'

/** 版式规格：排版引擎输入 */
export interface LayoutSpec {
  rows: number
  cols: number
  orientation: Orientation
  paper: PaperKind
  /** paper='custom' 时的竖版尺寸（mm） */
  customWidthMm: number
  customHeightMm: number
  marginMm: number
  /** 打印校准：整体内容偏移（mm，可为负，补偿打印机走纸偏差） */
  offsetXMm: number
  offsetYMm: number
}

/** 装饰规格 */
export interface DecoratorSpec {
  /** 是否添加序号角标 */
  numbering: boolean
  /** 分隔标记：无 / 虚线边框 / 角部裁剪线 */
  divider: DividerStyle
  /** 同票双联：一张纸上下各打印一份，便于中间裁开 */
  duplex: boolean
}

/**
 * 排版结果：一张票据副本在输出页上的目标矩形。
 * duplex 时同一张票产生两个 Placement（上下各一份）。
 */
export interface Placement {
  /** 票据页 id（SourceFile.pages[].id） */
  pageId: string
  fileId: string
  sourcePage: number
  /** 票据序号（duplex 的两份共享同一序号） */
  seq: number
  x: number
  y: number
  width: number
  height: number
  /** 所属单元格矩形（装饰边框/双联裁切线以此为准） */
  cellX: number
  cellY: number
  cellWidth: number
  cellHeight: number
}

/** 一个输出页的排版结果 */
export interface SheetLayout {
  width: number
  height: number
  placements: Placement[]
}

/** 规范化后的单张票据页 */
export interface TicketPage {
  /** `${fileId}:${sourcePage}` */
  id: string
  fileId: string
  /** 源文件内页码，从 0 开始 */
  sourcePage: number
  name: string
  /** 原始页面尺寸（pt） */
  widthPt: number
  heightPt: number
  /** 预览缩略图（dataURL，可直接 GC，无需 revoke） */
  thumbUrl: string
}

/** 导入的源文件：PDF 或图片 */
export interface SourceFile {
  id: string
  name: string
  /** 小写扩展名，不含点：pdf/png/jpg/jpeg */
  ext: string
  size: number
  /** 原始字节（矢量嵌入 / 图片嵌入用） */
  buffer: ArrayBuffer
  pages: TicketPage[]
  /** 运行时字段：原始 File（IndexedDB 草稿保存用，内核计算不读取） */
  origFile?: File
}

/** 票据识别状态：已识别（解析出发票号码）/ 部分识别（有二维码但要素不全）/ 未识别 */
export type RecognizeStatus = 'recognized' | 'partial' | 'unknown'

/**
 * 单张票据的二维码识别 / 人工补录结果，按 TicketPage.id 关联。
 * 仅保存文本要素，不保存扫描位图。
 */
export interface InvoiceMeta {
  pageId: string
  /** 二维码原文（未扫到为 null） */
  qrText: string | null
  /** 发票代码（老版增值税发票，10/12 位） */
  invoiceCode: string | null
  /** 发票号码（8 位老号码或 20 位数电票号码） */
  invoiceNo: string | null
  /** 票面金额（元） */
  amount: number | null
  /** 开票日期 YYYY-MM-DD */
  issueDate: string | null
  /** 校验码（取末 6 位） */
  checkCode: string | null
  status: RecognizeStatus
  /** 命中的识别引擎（人工补录为 null） */
  engine: 'jsqr' | 'zxing' | null
  /** 是否人工补录 / 覆盖 */
  manual: boolean
}

/** 免费限量阈值（平台 sys_configs 下发；获取失败时用前端内置默认值） */
export interface PrintLimits {
  maxFiles: number
  maxFileSizeMb: number
  maxTotalSizeMb: number
  maxExportPages: number
}

export const FALLBACK_LIMITS: PrintLimits = {
  maxFiles: 50,
  maxFileSizeMb: 20,
  maxTotalSizeMb: 200,
  maxExportPages: 300,
}
