<template>
  <div class="stats-card">
    <div class="sc-title">发票去重与统计</div>

    <!-- 未扫描 -->
    <template v-if="!hasScanned && !scanning">
      <div class="sc-cap">逐页扫描发票二维码，自动识别号码与金额，标记重复发票。全程本地识别，票据不上传。</div>
      <van-button
        type="primary"
        block
        round
        :disabled="!hasFiles"
        @click="emit('scan')"
      >{{ hasFiles ? '一键去重 / 开始统计' : '请先添加票据文件' }}</van-button>
    </template>

    <!-- 扫描中 -->
    <template v-else-if="scanning">
      <div class="sc-scan-label">
        <template v-if="phase === 'engine'">正在准备识别引擎（首次加载约需数秒）…</template>
        <template v-else>正在扫描二维码 {{ progress.done }} / {{ progress.total }}</template>
      </div>
      <van-progress
        :percentage="phase === 'engine' ? 0 : percentage"
        stroke-width="6"
        :show-pivot="false"
      />
    </template>

    <!-- 结果 -->
    <template v-else>
      <div class="sc-nums">
        <div class="num">
          <b class="c-recognized">{{ stats.recognized }}</b>
          <span>已识别</span>
        </div>
        <div class="num">
          <b class="c-partial">{{ stats.partial }}</b>
          <span>部分识别</span>
        </div>
        <div class="num">
          <b class="c-unknown">{{ stats.unknown }}</b>
          <span>未识别</span>
        </div>
      </div>

      <div class="sc-amount">
        <div class="amt-row">
          <span>金额合计</span>
          <b>¥{{ fmt(stats.amountTotal) }}</b>
        </div>
        <div class="amt-row">
          <span>去重金额</span>
          <b class="amt-unique">
            ¥{{ fmt(stats.uniqueAmount) }}
            <em>（原 ¥{{ fmt(stats.amountTotal) }}）</em>
          </b>
        </div>
      </div>

      <div v-if="stats.dupGroupCount > 0" class="sc-dup-tip" @click="emit('dup')">
        <van-icon name="warning-o" />
        <span>发现 {{ stats.dupGroupCount }} 组重复发票，{{ stats.dupTicketCount }} 张重复副本，点击查看</span>
        <van-icon name="arrow" />
      </div>

      <!-- 失败原因显式呈现（不静默失败） -->
      <div v-if="failures.length > 0" class="sc-fail-tip">
        <van-icon name="warning-o" />
        <div class="sft-body">
          <div>{{ failures.length }} 张票据识别失败（已保留其它结果，可重试或人工补录）</div>
          <div v-for="f in failurePreview" :key="f.pageId" class="sft-item">
            · {{ f.name }}：{{ f.reason }}
          </div>
          <div v-if="failures.length > failurePreview.length" class="sft-item">
            · 另有 {{ failures.length - failurePreview.length }} 张…
          </div>
        </div>
      </div>

      <div class="sc-ops">
        <span @click="emit('copy')"><van-icon name="orders-o" />复制结果</span>
        <span @click="emit('csv')"><van-icon name="down" />导出 CSV</span>
        <span v-if="dedupEnabled" @click="emit('dup')"><van-icon name="eye-o" />重复详情</span>
        <span @click="emit('manual')">
          <van-icon name="edit" />人工补录<em v-if="stats.partial + stats.unknown > 0">({{ stats.partial + stats.unknown }})</em>
        </span>
        <span @click="emit('rescan')"><van-icon name="replay" />重新扫描</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { InvoiceStats } from '@/lib/print/qr'
import type { ScanFailure, ScanPhase } from '@/composables/print/useQrScan'
import { fmtMoney } from '@/composables/print/useInvoiceStats'

const props = defineProps<{
  scanning: boolean
  phase: ScanPhase
  progress: { done: number; total: number }
  hasScanned: boolean
  stats: InvoiceStats
  failures: ScanFailure[]
  dedupEnabled: boolean
  hasFiles: boolean
}>()

const emit = defineEmits<{
  (e: 'scan'): void
  (e: 'rescan'): void
  (e: 'copy'): void
  (e: 'csv'): void
  (e: 'dup'): void
  (e: 'manual'): void
}>()

const percentage = computed(() =>
  props.progress.total > 0
    ? Math.round((props.progress.done / props.progress.total) * 100)
    : 0,
)

/** 失败详情最多展示 3 条，其余折叠为计数 */
const failurePreview = computed(() => props.failures.slice(0, 3))

function fmt(n: number) {
  return fmtMoney(n)
}
</script>

<style scoped>
.stats-card {
  margin-top: 12px;
  padding: 14px;
  background: var(--van-background-2, #fff);
  border-radius: 12px;
}
.sc-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.sc-cap {
  margin: 10px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--van-text-color-3, #969799);
}
.sc-scan-label {
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
}

.sc-nums {
  display: flex;
  margin-top: 12px;
}
.sc-nums .num {
  flex: 1;
  text-align: center;
}
.sc-nums .num b {
  display: block;
  font-size: 22px;
  line-height: 1.2;
}
.sc-nums .num span {
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.c-recognized {
  color: var(--van-success-color, #07c160);
}
.c-partial {
  color: var(--van-warning-color, #ff976a);
}
.c-unknown {
  color: var(--van-text-color-3, #969799);
}

.sc-amount {
  margin-top: 14px;
  padding: 10px 12px;
  background: var(--van-background, #f7f8fa);
  border-radius: 8px;
}
.amt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
  padding: 3px 0;
}
.amt-row b {
  color: var(--van-text-color, #323233);
}
.amt-unique {
  color: var(--van-primary-color);
}
.amt-unique em {
  font-size: 11px;
  font-style: normal;
  color: var(--van-text-color-3, #969799);
}

.sc-dup-tip {
  margin-top: 12px;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--van-danger-color, #ee0a24);
  background: var(--van-danger-background, #fde8ea);
  border-radius: 8px;
}
.sc-dup-tip span {
  flex: 1;
}

.sc-fail-tip {
  margin-top: 12px;
  padding: 9px 12px;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--van-warning-color, #ff976a);
  background: var(--van-warning-background, #fff7e8);
  border-radius: 8px;
}
.sft-body {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.sft-item {
  color: var(--van-text-color-2, #646566);
}

.sc-ops {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  font-size: 13px;
  color: var(--van-primary-color);
}
.sc-ops span {
  display: flex;
  align-items: center;
  gap: 3px;
}
.sc-ops em {
  font-style: normal;
}
</style>
