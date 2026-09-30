<template>
  <div ref="rootEl" class="preview">
    <div class="pv-head">预览 · 共 {{ sheets.length }} 页</div>
    <div v-if="sheets.length === 0" class="pv-empty">添加票据后，在此预览排版效果</div>
    <div ref="scrollEl" class="pv-scroll">
      <div
        v-for="(sheet, i) in sheets"
        :key="i"
        class="pv-sheet"
        :class="{ active: i === currentIndex }"
        :style="{
          width: `${cssWidth}px`,
          height: `${(cssWidth * sheet.height) / sheet.width}px`,
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
import { buildSheetDecor } from '@/lib/print/decor'
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

/** 视口前后各渲染多少页，其余 canvas 回收显存 */
const RENDER_MARGIN = 2

/** pageId → 缩略图 URL */
function thumbOf(pageId: string): string | undefined {
  for (const f of props.files) {
    const hit = f.pages.find((p) => p.id === pageId)
    if (hit) return hit.thumbUrl
  }
  return undefined
}

const imageCache = new Map<string, HTMLImageElement>()
function getImage(pageId: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(pageId)
  if (cached) return Promise.resolve(cached)
  const url = thumbOf(pageId)
  if (!url) return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      imageCache.set(pageId, img)
      resolve(img)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

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

async function drawSlot(slot: Slot, gen: number) {
  const sheet = props.sheets[slot.idx]
  if (!sheet) return
  const w = cssWidth.value
  const h = (w * sheet.height) / sheet.width
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
  slot.canvas.width = Math.round(w * dpr)
  slot.canvas.height = Math.round(h * dpr)

  const ctx = slot.canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  // pt → css px
  ctx.save()
  ctx.scale(w / sheet.width, w / sheet.width)

  for (const p of sheet.placements) {
    const img = await getImage(p.pageId)
    if (gen !== generation) return // 已被新一次重绘取代
    if (img) ctx.drawImage(img, p.x, p.y, p.width, p.height)
  }

  const items = buildSheetDecor(sheet, props.decorator)
  ctx.strokeStyle = '#555555'
  ctx.fillStyle = '#222222'
  ctx.lineWidth = 0.55
  ctx.lineCap = 'round'
  ctx.font = '10px Helvetica, Arial, sans-serif'
  ctx.textBaseline = 'alphabetic'
  for (const it of items) {
    if (it.kind === 'line') {
      ctx.beginPath()
      ctx.moveTo(it.x1, it.y1)
      ctx.lineTo(it.x2, it.y2)
      ctx.stroke()
    } else if (it.kind === 'fill') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(it.x, it.y, it.width, it.height)
      ctx.fillStyle = '#222222'
    } else {
      ctx.fillText(it.text, it.x, it.y)
    }
  }
  ctx.restore()
  if (gen === generation) slot.drawn = true
}

/** 回收画布显存 */
function release(slot: Slot) {
  slot.canvas.width = 2
  slot.canvas.height = 2
  slot.drawn = false
}

/** 依据当前可见页集合，绘制窗口内、回收窗口外 */
function syncWindow() {
  const gen = generation
  if (visibleIdx.size === 0) {
    // 初始/无观测信息：只画第一屏
    visibleIdx.add(0)
  }
  let lo = Infinity
  let hi = -Infinity
  for (const i of visibleIdx) {
    lo = Math.min(lo, i)
    hi = Math.max(hi, i)
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
  const els = Array.from(root.querySelectorAll<HTMLElement>('.pv-sheet'))
  slots = els.map((el, idx) => ({
    idx,
    el,
    canvas: el.querySelector('canvas') as HTMLCanvasElement,
    drawn: false,
  }))
  visibleIdx.clear()

  io?.disconnect()
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
    { root, threshold: [0, 0.45] },
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
    cssWidth.value = Math.min(420, rootEl.value.clientWidth)
  }
}

let ro: ResizeObserver | null = null
onMounted(() => {
  measure()
  ro = new ResizeObserver(() => {
    measure()
    void rebuild()
  })
  if (rootEl.value) ro.observe(rootEl.value)
  void rebuild()
})

onBeforeUnmount(() => {
  io?.disconnect()
  ro?.disconnect()
})

watch(
  () => [props.sheets, props.decorator],
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
