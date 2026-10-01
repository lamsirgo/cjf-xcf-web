<template>
  <div ref="rootEl" class="preview">
    <div class="pv-head">
      预览 · 共 {{ sheets.length }} 页
      <span v-if="sheets.length > 6" class="pv-tip">（仅绘制可视区域附近，滚动查看）</span>
    </div>
    <div v-if="sheets.length === 0" class="pv-empty">添加票据后，在此预览排版效果</div>
    <div ref="scrollEl" class="pv-scroll">
      <div
        v-for="(sheet, i) in sheets"
        :key="i"
        class="pv-sheet"
        :class="{ active: i === currentIndex }"
        :style="{
          width: `${cssWidth}px`,
          height: `${cssHeight(sheet)}px`,
        }"
      >
        <canvas></canvas>
        <span class="pv-tag">{{ i + 1 }}/{{ sheets.length }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { buildSheetDecor, type DecorItem } from '@/lib/print/decor'
import type { DecoratorSpec, SheetLayout, SourceFile } from '@/lib/print/types'

const props = defineProps<{
  sheets: SheetLayout[]
  files: SourceFile[]
  decorator: DecoratorSpec
}>()
const emit = defineEmits<{ (e: 'update:current', i: number): void }>()

const rootEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const currentIndex = ref(0)
const cssWidth = ref(320)

/** 视口前后各渲染多少页，其余 canvas 释放显存（虚拟化真实生效：root=视口） */
const RENDER_MARGIN = 2
/** 缩略图解码缓存上限：超出按 LRU 释放，避免删除文件后位图常驻 */
const IMAGE_CACHE_MAX = 24

interface Slot {
  idx: number
  el: HTMLElement
  canvas: HTMLCanvasElement
  drawn: boolean
}

let slots: Slot[] = []
let generation = 0
let io: IntersectionObserver | null = null
const visibleIdx = new Set<number>()

/** pageId → 缩略图 URL（一次建表，避免每帧线性扫描全部票据） */
const thumbMap = new Map<string, string>()
function rebuildThumbMap() {
  thumbMap.clear()
  for (const f of props.files) for (const p of f.pages) thumbMap.set(p.id, p.thumbUrl)
}

const imageCache = new Map<string, HTMLImageElement>()
function evictImageCache() {
  while (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    imageCache.delete(oldest)
  }
}

function getImage(pageId: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(pageId)
  if (cached) {
    // 触活
    imageCache.delete(pageId)
    imageCache.set(pageId, cached)
    return Promise.resolve(cached)
  }
  const url = thumbMap.get(pageId)
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      imageCache.set(pageId, img)
      evictImageCache()
      resolve(img)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function cssHeight(sheet: SheetLayout): number {
  return sheet.width > 0 ? (cssWidth.value * sheet.height) / sheet.width : cssWidth.value
}

async function drawSlot(slot: Slot, gen: number) {
  const sheet = props.sheets[slot.idx]
  if (!sheet) return
  const w = cssWidth.value
  if (!(sheet.width > 0) || w <= 0) return
  const h = cssHeight(sheet)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  slot.canvas.width = Math.max(1, Math.round(w * dpr))
  slot.canvas.height = Math.max(1, Math.round(h * dpr))

  const ctx = slot.canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  // pt → css px
  ctx.save()
  try {
    const scale = w / sheet.width
    ctx.scale(scale, scale)

    for (const p of sheet.placements) {
      const img = await getImage(p.pageId)
      if (gen !== generation) return // 已被新一次重绘取代
      if (img) ctx.drawImage(img, p.x, p.y, p.width, p.height)
    }

    const items = buildSheetDecor(sheet, props.decorator)
    ctx.lineCap = 'butt'
    ctx.textBaseline = 'alphabetic'
    for (const it of items) {
      drawItem(ctx, it)
    }
  } finally {
    ctx.restore()
  }
  if (gen === generation) slot.drawn = true
}

function cssColor(c: readonly [number, number, number]): string {
  const to = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  return `rgb(${to(c[0])}, ${to(c[1])}, ${to(c[2])})`
}

function drawItem(ctx: CanvasRenderingContext2D, it: DecorItem) {
  if (it.kind === 'line') {
    ctx.strokeStyle = cssColor(it.color)
    ctx.lineWidth = it.thickness
    ctx.setLineDash(it.dash ?? [])
    ctx.beginPath()
    ctx.moveTo(it.x1, it.y1)
    ctx.lineTo(it.x2, it.y2)
    ctx.stroke()
    ctx.setLineDash([])
  } else {
    ctx.fillStyle = cssColor(it.color)
    ctx.font = `${it.size}px Helvetica, Arial, sans-serif`
    ctx.fillText(it.text, it.x, it.y)
  }
}

/** 回收画布显存 */
function release(slot: Slot) {
  if (slot.canvas.width === 2 && slot.canvas.height === 2 && !slot.drawn) return
  slot.canvas.width = 2
  slot.canvas.height = 2
  slot.drawn = false
}

/** 依据当前可见页集合，绘制窗口内、回收窗口外 */
function syncWindow() {
  const gen = generation
  if (visibleIdx.size === 0 && slots.length > 0) {
    if (props.sheets.length > 0) visibleIdx.add(0)
  }
  let lo = Infinity
  let hi = -Infinity
  for (const i of visibleIdx) {
    lo = Math.min(lo, i)
    hi = Math.max(hi, i)
  }
  if (!Number.isFinite(lo)) {
    lo = 0
    hi = Math.min(props.sheets.length - 1, RENDER_MARGIN * 2)
  }
  lo = Math.max(0, lo - RENDER_MARGIN)
  hi = Math.min(props.sheets.length - 1, hi + RENDER_MARGIN)

  for (const slot of slots) {
    const inWindow = slot.idx >= lo && slot.idx <= hi
    if (inWindow && !slot.drawn) void drawSlot(slot, gen)
    else if (!inWindow && slot.drawn) release(slot)
  }
}

async function rebuild() {
  await nextTick()
  const root = scrollEl.value
  if (!root) return

  generation += 1
  rebuildThumbMap()
  // 票据减少时当前页可能越界：钳制并通知父组件
  if (currentIndex.value > props.sheets.length - 1) {
    currentIndex.value = Math.max(0, props.sheets.length - 1)
    emit('update:current', currentIndex.value)
  }
  const els = Array.from(root.querySelectorAll<HTMLElement>('.pv-sheet'))
  // 页面数量变化时释放不再使用的画布
  for (const old of slots) {
    if (old.idx >= els.length) release(old)
  }
  slots = els.map((el, idx) => ({
    idx,
    el,
    canvas: el.querySelector('canvas') as HTMLCanvasElement,
    drawn: false,
  }))
  visibleIdx.clear()

  io?.disconnect()
  // root: null = 以浏览器视口为根，随页面滚动真实生效（此前误用不可滚动容器做 root，
  // 导致所有页都被判定为可见，虚拟化失效、显存随页数线性增长）
  io = new IntersectionObserver(
    (entries) => {
      let changed = false
      for (const entry of entries) {
        const slot = slots.find((s) => s.el === entry.target)
        if (!slot) continue
        if (entry.isIntersecting) {
          if (!visibleIdx.has(slot.idx)) {
            visibleIdx.add(slot.idx)
            changed = true
          }
          if (entry.intersectionRatio >= 0.45 && slot.idx !== currentIndex.value) {
            currentIndex.value = slot.idx
            emit('update:current', slot.idx)
          }
        } else if (visibleIdx.has(slot.idx)) {
          visibleIdx.delete(slot.idx)
          changed = true
        }
      }
      if (changed) syncWindow()
    },
    { threshold: [0, 0.45] },
  )
  for (const slot of slots) io.observe(slot.el)

  // 兜底：若回调尚未触发，按几何位置初始化可见集合
  await nextTick()
  if (visibleIdx.size === 0) {
    const vh = window.innerHeight || document.documentElement.clientHeight
    for (const slot of slots) {
      const r = slot.el.getBoundingClientRect()
      if (r.bottom > 0 && r.top < vh) visibleIdx.add(slot.idx)
    }
  }
  syncWindow()
}

function measure() {
  if (rootEl.value) {
    cssWidth.value = Math.max(120, Math.min(420, rootEl.value.clientWidth))
  }
}

let ro: ResizeObserver | null = null
let measureTimer: number | undefined

onMounted(() => {
  measure()
  ro = new ResizeObserver(() => {
    window.clearTimeout(measureTimer)
    measureTimer = window.setTimeout(() => {
      measure()
      void rebuild()
    }, 120)
  })
  if (rootEl.value) ro.observe(rootEl.value)
  void rebuild()
})

onBeforeUnmount(() => {
  io?.disconnect()
  ro?.disconnect()
  window.clearTimeout(measureTimer)
  imageCache.clear()
  for (const slot of slots) release(slot)
  slots = []
})

watch(
  () => [props.sheets, props.decorator, props.files],
  () => void rebuild(),
  { deep: true },
)
</script>

<style scoped>
.preview {
  width: 100%;
}
.pv-head {
  font-size: 13px;
  font-weight: 500;
  color: var(--van-text-color, #323233);
  margin-bottom: 10px;
}
.pv-tip {
  font-size: 11px;
  font-weight: 400;
  color: var(--van-text-color-3, #969799);
}
.pv-empty {
  padding: 36px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
  border: 1px dashed var(--van-border-color, #dcdee0);
  border-radius: 10px;
  background: var(--van-background-2, #fff);
}
.pv-scroll {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.pv-sheet {
  position: relative;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
  border-radius: 2px;
  transition: box-shadow 0.2s;
}
.pv-sheet.active {
  box-shadow: 0 2px 14px rgba(25, 137, 250, 0.35);
}
.pv-sheet canvas {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 2px;
}
.pv-tag {
  position: absolute;
  bottom: -20px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--van-text-color-3, #969799);
}
</style>
