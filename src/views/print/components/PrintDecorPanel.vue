<template>
  <div class="panel">
    <div class="p-title">标记装饰</div>

    <van-cell
      title="添加序号角标"
      center
      :border="false"
      class="tight-cell"
    >
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

    <p class="notice">标记仅画在票面外围，不会修改票面内容。</p>
  </div>
</template>

<script setup lang="ts">
import type { SettingsState } from '@/composables/print/usePrintSettings'

defineProps<{ state: SettingsState }>()
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
.tight-cell :deep(.van-cell__title) {
  font-size: 14px;
}
.tight-cell :deep(.van-cell__label) {
  margin-top: 2px;
}
.notice {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
</style>
