/**
 * 图片票据的"真实几何"解析（纯函数，零 DOM）。
 *
 * 为什么需要它：
 * - 预览缩略图来自 createImageBitmap，而导出用的是**原始文件字节**（pdf-lib embedJpg/embedPng）；
 * - createImageBitmap 默认会按 EXIF Orientation 旋转位图（`imageOrientation: 'from-image'`），
 *   而 PDF 里的 JPEG 是 DCTDecode 原始像素、**不携带/不解释 EXIF 方向**
 *   （见 pdf-lib issue #1284）；
 * - 若用位图尺寸当 widthPt/heightPt，就会出现「预览是正的、导出被旋转且被非等比拉伸」，
 *   同时某些浏览器对超大图可能做降采样，同样会让导出比例失真。
 *
 * 因此这里直接从文件字节读尺寸与 EXIF 方向：
 * - 尺寸以文件头为准（pdf-lib 编码时用的就是它），保证导出比例永远正确；
 * - EXIF 方向交给上方调用方做「画布矩阵校正」，把照片转正后再编码进 PDF，
 *   彻底消除「预览正、导出歪」的不一致（PDF 无法表达 EXIF 方向，只能烘焙像素）。
 */

export interface ImageInfo {
  width: number
  height: number
  /** EXIF Orientation（1~8）；无 EXIF 或非 JPEG 时为 null */
  exifOrientation: number | null
}

/** PNG：签名 8 字节 + IHDR 宽高（大端） */
function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24) return null
  for (let i = 0; i < sig.length; i += 1) if (bytes[i] !== sig[i]) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 8..12 长度，12..16 'IHDR'
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  if (!width || !height) return null
  return { width, height }
}

/** 在 JPEG 段中寻找 SOF0/SOF2 等帧头，读出宽高 */
function readJpegSizeAndExif(bytes: Uint8Array): {
  size: { width: number; height: number } | null
  orientation: number | null
} {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { size: null, orientation: null }
  let size: { width: number; height: number } | null = null
  let orientation: number | null = null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = bytes[i + 1]
    // 填充字节 / 无长度段
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break // 进入压缩数据
    const len = dv.getUint16(i + 2)
    if (len < 2) break
    const segStart = i + 4
    const segEnd = i + 2 + len
    if (segEnd > bytes.length) break

    // APP1：可能是 Exif
    if (marker === 0xe1 && orientation === null) {
      orientation = readExifOrientationIn(bytes, segStart, segEnd)
    }
    // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15（排除 DHT=0xc4, JPG=0xc8, DAC=0xcc）
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && size === null) {
      if (segStart + 5 <= segEnd) {
        const height = dv.getUint16(segStart + 1)
        const width = dv.getUint16(segStart + 3)
        if (width && height) size = { width, height }
      }
    }
    if (size && orientation !== null) break
    i = segEnd
  }
  return { size, orientation }
}

/** 解析 APP1 段内的 Exif TIFF 结构，读取 Orientation(0x0112) */
function readExifOrientationIn(bytes: Uint8Array, start: number, end: number): number | null {
  if (start + 6 > end) return null
  // 'Exif\0\0'
  if (
    bytes[start] !== 0x45 ||
    bytes[start + 1] !== 0x78 ||
    bytes[start + 2] !== 0x69 ||
    bytes[start + 3] !== 0x66 ||
    bytes[start + 4] !== 0x00 ||
    bytes[start + 5] !== 0x00
  ) {
    return null
  }
  const tiff = start + 6
  if (tiff + 8 > end) return null
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
  if (!little && !big) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (o: number) => dv.getUint16(o, little)
  const u32 = (o: number) => dv.getUint32(o, little)
  if (u16(tiff + 2) !== 0x002a) return null
  const ifd0 = tiff + u32(tiff + 4)
  if (ifd0 + 2 > end) return null
  const count = u16(ifd0)
  for (let k = 0; k < count; k += 1) {
    const entry = ifd0 + 2 + k * 12
    if (entry + 12 > end) return null
    if (u16(entry) === 0x0112) {
      const type = u16(entry + 2)
      if (type !== 3) return null // SHORT
      const v = u16(entry + 8)
      return v >= 1 && v <= 8 ? v : null
    }
  }
  return null
}

/**
 * 读取图片票据的真实尺寸与 EXIF 方向。
 * 解析失败时返回 null，由调用方回退到位图尺寸。
 */
export function readImageInfo(bytes: Uint8Array, ext: string): ImageInfo | null {
  if (ext === 'png') {
    const size = readPngSize(bytes)
    return size ? { ...size, exifOrientation: null } : null
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    const { size, orientation } = readJpegSizeAndExif(bytes)
    return size ? { ...size, exifOrientation: orientation } : null
  }
  return null
}

/** EXIF 中「需要旋转/镜像才能正立」的方向值 */
export function needsOrientationFix(orientation: number | null): boolean {
  return orientation !== null && orientation >= 2 && orientation <= 8
}

/** 2D 仿射矩阵（canvas setTransform 口径：x' = a·x + c·y + e, y' = b·x + d·y + f） */
export interface OrientationMatrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  outWidth: number
  outHeight: number
  mirrored: boolean
}

/**
 * EXIF Orientation(1~8) → 「画布变换 + 输出尺寸」。
 *
 * 采用画布矩阵（而非逐像素拷贝）实现：
 * - 不产生 JS 侧像素缓冲，20MP 照片也不会额外占几十 MB；
 * - 矩阵本身是纯数学，可在单测里校验「四角映射」与「是否镜像」，
 *   真实像素结果再由浏览器 e2e 验证。
 *
 * 约定：图像坐标 y 向下（canvas 口径），源图尺寸 (w,h)。
 */
export function orientationMatrix(orientation: number, w: number, h: number): OrientationMatrix {
  const W = Math.max(1, w)
  const H = Math.max(1, h)
  const id: OrientationMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, outWidth: W, outHeight: H, mirrored: false }
  switch (orientation) {
    case 2: // 水平镜像
      return { a: -1, b: 0, c: 0, d: 1, e: W, f: 0, outWidth: W, outHeight: H, mirrored: true }
    case 3: // 旋转 180°
      return { a: -1, b: 0, c: 0, d: -1, e: W, f: H, outWidth: W, outHeight: H, mirrored: false }
    case 4: // 垂直镜像
      return { a: 1, b: 0, c: 0, d: -1, e: 0, f: H, outWidth: W, outHeight: H, mirrored: true }
    case 5: // 主对角线镜像（转置）
      return { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0, outWidth: H, outHeight: W, mirrored: true }
    case 6: // 顺时针 90°
      return { a: 0, b: 1, c: -1, d: 0, e: H, f: 0, outWidth: H, outHeight: W, mirrored: false }
    case 7: // 副对角线镜像
      return { a: 0, b: -1, c: -1, d: 0, e: H, f: W, outWidth: H, outHeight: W, mirrored: true }
    case 8: // 逆时针 90°（顺时针 270°）
      return { a: 0, b: -1, c: 1, d: 0, e: 0, f: W, outWidth: H, outHeight: W, mirrored: false }
    default:
      return id
  }
}

/** 应用 EXIF 方向后的可视尺寸 */
export function orientedSize(
  orientation: number | null,
  w: number,
  h: number,
): { width: number; height: number } {
  if (!needsOrientationFix(orientation)) return { width: w, height: h }
  const m = orientationMatrix(orientation as number, w, h)
  return { width: m.outWidth, height: m.outHeight }
}
