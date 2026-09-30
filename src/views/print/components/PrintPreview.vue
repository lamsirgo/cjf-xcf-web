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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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

/** pageId → 缩略图 URL */
const thumbMap = computed(() => {
  const m = new Map<string, string>()
  for (const f of props.files) for (const p of f.pages) m.set(p.id, p.thumbUrl)
  return m
})

const imageCache = new Map<string, HTMLImageElement>()
function getImage(pageId: string): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(pageId)
  if (cached) return Promise.resolve(cached)
  const url = thumbMap.value.get(pageId)
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

async function drawSheet(canvas: HTMLCanvasElement, sheet: SheetLayout) {
  const w = cssWidth.value
  const h = (w * sheet.height) / sheet.width
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  // pt → css px
  ctx.save()
  ctx.scale(w / sheet.width, w / sheet.width)

  for (const p of sheet.placements) {
    const img = await getImage(p.pageId)
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
}

let io: IntersectionObserver | null = null

async function redraw() {
  await nextTick()
  const root = scrollEl.value
  if (!root) return

  const sheetEls = Array.from(root.querySelectorAll<HTMLElement>('.pv-sheet'))
  await Promise.all(
    sheetEls.map((el) => {
      const canvas = el.querySelector('canvas')
      const sheet = props.sheets[sheetEls.indexOf(el)]
      return canvas && sheet ? drawSheet(canvas, sheet) : null
    }),
  )

  io?.disconnect()
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const idx = sheetEls.indexOf(entry.target as HTMLElement)
          if (idx >= 0 && idx !== currentIndex.value) {
            currentIndex.value = idx
            emit('update:current', idx)
          }
        }
      }
    },
    { root, threshold: 0.45 },
  )
  for (const el of sheetEls) io.observe(el)
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
    void redraw()
  })
  if (rootEl.value) ro.observe(rootEl.value)
  void redraw()
})

onBeforeUnmount(() => {
  io?.disconnect()
  ro?.disconnect()
})

watch(
  () => [props.sheets, props.decorator],
  () => void redraw(),
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
