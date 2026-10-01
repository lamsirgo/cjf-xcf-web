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

    <div class="p-title mt">纸张</div>
    <van-radio-group v-model="state.paper" direction="horizontal">
      <van-radio name="A4">A4</van-radio>
      <van-radio name="A5">A5</van-radio>
      <van-radio name="B5">B5</van-radio>
      <van-radio name="custom">自定义</van-radio>
    </van-radio-group>
    <div v-if="state.paper === 'custom'" class="row-inline">
      <span class="r-label">宽 × 高</span>
      <van-stepper v-model="state.customWidthMm" :min="50" :max="500" integer />
      <span class="cross">×</span>
      <van-stepper v-model="state.customHeightMm" :min="50" :max="700" integer />
      <span class="unit">mm</span>
    </div>

    <div class="p-title mt">纸张方向</div>
    <van-radio-group v-model="state.orientation" direction="horizontal">
      <van-radio name="portrait">竖版</van-radio>
      <van-radio name="landscape">横版</van-radio>
    </van-radio-group>

    <div class="row-inline mt">
      <span class="r-label">页边距</span>
      <van-stepper v-model="state.marginMm" :min="0" :max="40" integer />
      <span class="unit">mm（兼顾打印机不可打印区）</span>
    </div>

    <div class="p-title mt">打印校准</div>
    <div class="row-inline">
      <span class="r-label">水平偏移</span>
      <van-stepper v-model="state.offsetXMm" :min="-20" :max="20" :step="1" />
      <span class="r-label ml">垂直偏移</span>
      <van-stepper v-model="state.offsetYMm" :min="-20" :max="20" :step="1" />
      <span class="unit">mm</span>
    </div>
    <van-button
      class="test-btn"
      size="small"
      plain
      type="primary"
      @click="emit('test')"
    >打印校准测试页</van-button>
    <div class="cal-tip">先打印测试页（打印对话框选「实际大小」），测量黑框四边边距，调整偏移直到四边相等。</div>

    <div class="p-title mt">我的预设</div>
    <div v-if="presets.length === 0" class="cal-tip">把当前版式/边距存为预设，下次一键套用。</div>
    <div v-for="p in presets" :key="p.id" class="preset-row">
      <span class="preset-name" @click="emit('applyPreset', p.id)">{{ p.name }}</span>
      <van-button size="mini" plain type="primary" @click="emit('applyPreset', p.id)">套用</van-button>
      <van-button size="mini" plain type="danger" @click="emit('deletePreset', p.id)">删除</van-button>
    </div>
    <div class="row-inline mt">
      <van-field
        v-model="presetName"
        class="preset-input"
        placeholder="预设名称（如：4 张横版报销）"
        maxlength="20"
        clearable
      />
      <van-button size="small" plain type="primary" @click="onSave">保存为预设</van-button>
    </div>

    <div v-if="usagePages > 0" class="usage-tip">本账号累计导出 {{ usagePages }} 页（平台记录，仅计数不含票面）</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PrintNamedPreset, SettingsState } from '@/composables/print/usePrintSettings'

const props = defineProps<{
  state: SettingsState
  presets: PrintNamedPreset[]
  usagePages: number
}>()
const emit = defineEmits<{
  (e: 'select', p: SettingsState['preset']): void
  (e: 'test'): void
  (e: 'savePreset', name: string): void
  (e: 'applyPreset', id: string): void
  (e: 'deletePreset', id: string): void
}>()

const presetName = ref('')

function onPreset(p: unknown) {
  emit('select', p as SettingsState['preset'])
}

function onSave() {
  const name = presetName.value.trim()
  if (!name) {
    // 名字为空时默认用版式名，避免用户白填
    presetName.value = ''
    emit('savePreset', `${props.state.preset}-${new Date().toLocaleDateString('zh-CN')}`)
    return
  }
  emit('savePreset', name)
  presetName.value = ''
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
.ml {
  margin-left: 8px;
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
.test-btn {
  margin-top: 10px;
}
.cal-tip {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--van-text-color-3, #969799);
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.preset-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--van-text-color, #323233);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preset-input {
  flex: 1;
  min-width: 160px;
  padding: 4px 8px;
  background: var(--van-background, #f7f8fa);
  border-radius: 6px;
}
.usage-tip {
  margin-top: 12px;
  font-size: 11px;
  color: var(--van-text-color-3, #969799);
}
</style>
