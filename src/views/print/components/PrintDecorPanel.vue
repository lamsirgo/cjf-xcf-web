<template>
  <div class="panel">
    <div class="p-title">标记装饰</div>

    <van-cell title="添加序号角标" center :border="false" class="tight-cell">
      <template #right-icon>
        <van-switch v-model="state.numbering" size="22px" />
      </template>
    </van-cell>

    <div class="sub-label">分隔标记</div>
    <van-radio-group v-model="state.divider" direction="horizontal">
      <van-radio name="dashed">虚线边框</van-radio>
      <van-radio name="line">角部裁剪线</van-radio>
      <van-radio name="none">无标记</van-radio>
    </van-radio-group>

    <van-cell
      v-if="duplexEnabled"
      title="同票双联（上下裁切）"
      label="一张纸上下各打印一份，便于中间裁开"
      center
      :border="false"
      class="tight-cell mt"
    >
      <template #right-icon>
        <van-switch v-model="state.duplex" size="22px" />
      </template>
    </van-cell>

    <!-- C06：标记参数可配置 -->
    <div class="sub-label">标记样式</div>
    <div class="row-inline">
      <span class="r-label">序号字号</span>
      <van-stepper v-model="state.numberFontPt" :min="6" :max="20" :step="1" integer />
      <span class="unit">pt</span>
    </div>
    <div class="row-inline mt6">
      <span class="r-label">标记颜色</span>
      <span
        v-for="c in MARK_COLORS"
        :key="c"
        class="swatch"
        :class="{ on: state.markColor.toLowerCase() === c }"
        :style="{ background: c }"
        @click="state.markColor = c"
      />
    </div>
    <div class="row-inline mt6">
      <span class="r-label">虚线密度</span>
      <van-stepper v-model="state.dashLen" :min="1" :max="8" :step="0.2" :decimal-length="1" />
      <span class="unit">段长</span>
      <van-stepper v-model="state.dashGap" :min="0.5" :max="8" :step="0.2" :decimal-length="1" />
      <span class="unit">间隔 pt</span>
    </div>

    <p class="notice">标记只画在票面外围的空白带内，不会修改或遮挡票面内容。</p>
  </div>
</template>

<script setup lang="ts">
import { MARK_COLORS, type SettingsState } from '@/composables/print/usePrintSettings'

defineProps<{ state: SettingsState; duplexEnabled: boolean }>()
</script>

<style scoped>
.panel {
  padding: 4px 0;
}
.p-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--van-text-color, #323233);
  margin-bottom: 6px;
}
.sub-label {
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
  margin: 12px 0 8px;
}
.mt {
  margin-top: 6px;
}
.mt6 {
  margin-top: 10px;
}
.row-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.r-label {
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
}
.unit {
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  box-shadow: 0 0 0 1px var(--van-border-color, #dcdee0);
  cursor: pointer;
}
.swatch.on {
  border-color: var(--van-primary-color);
}
.tight-cell :deep(.van-cell__title) {
  font-size: 14px;
}
.tight-cell :deep(.van-cell__label) {
  margin-top: 2px;
}
.notice {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
</style>
