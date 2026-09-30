<template>
  <div class="panel">
    <div class="p-title">版式</div>
    <van-radio-group
      :model-value="state.preset"
      direction="horizontal"
      @update:model-value="onPreset"
    >
      <van-radio name="single">单页 (1/页)</van-radio>
      <van-radio name="double">双页 (2/页)</van-radio>
      <van-radio name="quad">四页 (4/页)</van-radio>
      <van-radio name="custom">自定义</van-radio>
    </van-radio-group>

    <div v-if="state.preset === 'custom'" class="row-inline">
      <span class="r-label">行 × 列</span>
      <van-stepper v-model="state.customRows" :min="1" :max="10" integer />
      <span class="cross">×</span>
      <van-stepper v-model="state.customCols" :min="1" :max="10" integer />
    </div>

    <div class="p-title mt">纸张方向</div>
    <van-radio-group v-model="state.orientation" direction="horizontal">
      <van-radio name="portrait">竖版 A4</van-radio>
      <van-radio name="landscape">横版 A4</van-radio>
    </van-radio-group>

    <div class="row-inline mt">
      <span class="r-label">页边距</span>
      <van-stepper v-model="state.marginMm" :min="0" :max="40" integer />
      <span class="unit">mm（兼顾打印机不可打印区）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SettingsState } from '@/composables/print/usePrintSettings'

defineProps<{ state: SettingsState }>()
const emit = defineEmits<{ (e: 'select', p: SettingsState['preset']): void }>()

function onPreset(p: unknown) {
  emit('select', p as SettingsState['preset'])
}
</script>

<style scoped>
.panel {
  padding: 4px 0;
}
.p-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--van-text-color, #323233);
  margin-bottom: 10px;
}
.mt {
  margin-top: 14px;
}
.row-inline {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.r-label {
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
}
.cross {
  color: var(--van-text-color-3, #969799);
}
.unit {
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
</style>
