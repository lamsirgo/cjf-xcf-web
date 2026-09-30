<template>
  <div class="file-list">
    <div class="fl-head">
      <span>共 {{ files.length }} 个文件 / {{ pageTotal }} 张票据</span>
      <van-button size="mini" plain type="danger" @click="emit('clear')">清空文件</van-button>
    </div>

    <div v-if="files.length === 0" class="fl-empty">暂无文件</div>

    <div v-for="(f, i) in files" :key="f.id" class="fl-item">
      <img :src="f.pages[0]?.thumbUrl" class="fl-thumb" alt="" />
      <div class="fl-meta">
        <div class="fl-name">{{ f.name }}</div>
        <div class="fl-sub">
          {{ f.pages.length }} 页 · {{ humanSize(f.size) }}
        </div>
        <div class="fl-ops">
          <van-button size="mini" plain :disabled="i === 0" @click="emit('move', f.id, 'front')">置顶</van-button>
          <van-button size="mini" plain :disabled="i === 0" @click="emit('move', f.id, 'prev')">上移</van-button>
          <van-button
            size="mini"
            plain
            :disabled="i === files.length - 1"
            @click="emit('move', f.id, 'next')"
          >下移</van-button>
          <van-button
            size="mini"
            plain
            :disabled="i === files.length - 1"
            @click="emit('move', f.id, 'back')"
          >置尾</van-button>
          <van-button size="mini" plain type="danger" @click="emit('remove', f.id)">删除</van-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SourceFile } from '@/lib/print/types'

const props = defineProps<{ files: SourceFile[] }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'remove', id: string): void
  (e: 'move', id: string, to: 'front' | 'back' | 'prev' | 'next'): void
  (e: 'clear'): void
}>()

const pageTotal = computed(() => props.files.reduce((sum, f) => sum + f.pages.length, 0))

function humanSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.round(n / 1024)}KB`
}
</script>

<style scoped>
.file-list {
  padding: 12px;
}
.fl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
  margin-bottom: 10px;
}
.fl-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
}
.fl-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.fl-thumb {
  width: 56px;
  height: 74px;
  object-fit: contain;
  border: 1px solid var(--van-border-color, #ebedf0);
  border-radius: 4px;
  background: #fff;
  flex-shrink: 0;
}
.fl-meta {
  flex: 1;
  min-width: 0;
}
.fl-name {
  font-size: 13px;
  color: var(--van-text-color, #323233);
  word-break: break-all;
}
.fl-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.fl-ops {
  margin-top: 8px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
