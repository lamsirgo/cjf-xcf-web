/**
 * pdfjs 在 Worker 内运行时的字体/画布能力适配。
 *
 * 我们把 pdf.mjs 完整跑在 Worker 里（解析 + OffscreenCanvas 渲染），
 * Worker 全局没有 document。pdfjs 渲染过程中除了主画布（render() 参数
 * 自带）还会通过 CanvasFactory 创建一批「辅助画布」：图片遮罩、透明
 * 分组合成、字形亚像素 AA 探测等；真实电票含二维码/印章图片，必然用到。
 * 默认的 DOMCanvasFactory 会调用 document.createElement('canvas')，
 * 在 Worker 内崩溃，因此这里提供一个产出 OffscreenCanvas 的工厂。
 *
 * 字体方面，遇到带嵌入字体的真实电票时会走字体绑定：
 * 1. 新内核：DedicatedWorker 有 self.fonts（FontFaceSet），注册的
 *    FontFace 可直接被同 Worker 的 OffscreenCanvas 2D 使用。
 *    把 ownerDocument 伪装成「只有 fonts 的 document」即可。
 * 2. 旧内核：Worker 内没有 FontFaceSet（部分旧版 WebView / iOS）。
 *    此时 pdfjs 会退到插入 <style> 的 DOM 路径，Worker 内必然崩溃。
 *    解决办法是让 pdfjs 自己走 disableFontFace 模式：核心把嵌入字体
 *    的字形轮廓编译成 Path2D 绘图指令（纯解释执行，不依赖字体注册、
 *    DOM 或 new Function），显示效果与嵌入字形一致；仅标准 14 字体
 *    退化为 canvas 同名兜底字族（无嵌入字体的 PDF 才会走到）。
 *
 * 不直接给 Worker 全局赋 document：避免 pdfjs 其它 DOM 探测分支被误激活。
 */

type MaybeFontsWorker = typeof globalThis & { fonts?: FontFaceSet }

/** 当前 Worker 是否具备原生字体加载能力（FontFace 构造器 + FontFaceSet）。 */
export const workerFontFaceSupported: boolean =
  typeof FontFace !== 'undefined' &&
  typeof (globalThis as MaybeFontsWorker).fonts?.add === 'function'

interface CanvasAndContext {
  canvas: OffscreenCanvas | null
  context: OffscreenCanvasRenderingContext2D | null
}

/**
 * pdfjs CanvasFactory 的 Worker 版：接口对齐
 * DOMCanvasFactory（create/reset/destroy），但产物是 OffscreenCanvas。
 * pdfjs 用 getDocument({ CanvasFactory }) 接收构造器，内部以
 * `new CanvasFactory({ ownerDocument, enableHWA })` 实例化。
 */
export class WorkerCanvasFactory {
  constructor({ enableHWA = false }: { ownerDocument?: unknown; enableHWA?: boolean } = {}) {
    this.enableHWA = enableHWA
  }

  private enableHWA: boolean

  _createCanvas(width: number, height: number): OffscreenCanvas {
    const canvas = new OffscreenCanvas(width, height)
    canvas.width = width
    canvas.height = height
    return canvas
  }

  create(width: number, height: number): CanvasAndContext {
    const canvas = this._createCanvas(width, height)
    const context = canvas.getContext('2d', {
      willReadFrequently: !this.enableHWA,
    })
    return { canvas, context }
  }

  reset(canvasAndContext: CanvasAndContext, width: number, height: number): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    canvasAndContext.canvas.width = width
    canvasAndContext.canvas.height = height
  }

  destroy(canvasAndContext: CanvasAndContext): void {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified')
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

/**
 * 交给 pdfjs 的「精简 document」。
 * 有字体能力时只暴露 fonts；createElement 在正常路径不可达
 * （辅助画布由 WorkerCanvasFactory 产出，字体绑定要么走 FontFace
 * 要么被 disableFontFace 短路），保留它是为了 pdfjs 意外触碰
 * 其它 DOM（如 SVG 滤镜工厂）时给出可读错误。
 */
export const pdfjsWorkerDocument: { fonts?: FontFaceSet; createElement(tag: string): never } = {
  fonts: workerFontFaceSupported ? (globalThis as MaybeFontsWorker).fonts : undefined,
  createElement(tag: string): never {
    throw new Error(`pdfjs 在 Worker 内需要 DOM（${tag}），当前运行环境不受支持`)
  },
}

export interface PdfjsWorkerLoadParams {
  data: Uint8Array
  ownerDocument: Document
  CanvasFactory: typeof WorkerCanvasFactory
  disableFontFace: boolean
}

/** 按当前 Worker 的字体能力生成 getDocument() 参数。 */
export function createPdfjsWorkerLoadParams(data: Uint8Array): PdfjsWorkerLoadParams {
  return {
    data,
    ownerDocument: pdfjsWorkerDocument as unknown as Document,
    CanvasFactory: WorkerCanvasFactory,
    disableFontFace: !workerFontFaceSupported,
  }
}
