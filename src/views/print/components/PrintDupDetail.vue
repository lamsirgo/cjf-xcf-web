<template>
  <div class="dup-detail">
    <div class="dd-head">
      重复发票详情 · 共 {{ groups.length }} 组
    </div>
    <div class="dd-tip">仅做标记不删除文件；撤销误判后统计自动更新。</div>

    <div v-for="(g, gi) in groups" :key="g.key" class="dd-group">
      <div class="dd-group-title">
        第 {{ gi + 1 }} 组 · {{ g.pageIds.length }} 张
      </div>

      <div v-for="pid in g.pageIds" :key="pid" class="dd-item">
        <img :src="thumbOf(pid)" class="dd-thumb" alt="" />
        <div class="dd-meta">
          <div class="dd-no">
            {{ props.metaOf(pid)?.invoiceNo || '无号码' }}
          </div>
          <div class="dd-sub">
            <template v-if="props.metaOf(pid)?.amount !== null">
              ¥{{ fmt(props.metaOf(pid)?.amount ?? 0) }}
            </template>
            <template v-else>金额未知</template>
            · {{ props.metaOf(pid)?.issueDate || '日期未知' }}
          </div>
          <div class="dd-ops">
            <van-tag plain :type="roleType(pid, g)">{{ roleLabel(pid, g) }}</van-tag>
            <van-button size="mini" plain @click="emit('edit', pid)">补录</van-button>
            <van-button
              size="mini"
              plain
              :type="ignored.has(pid) ? 'primary' : 'warning'"
              @click="emit('toggleIgnore', pid)"
            >{{ ignored.has(pid) ? '恢复标记' : '撤销误判' }}</van-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { fmtMoney, type ResolvedPage } from '@/composables/print/useInvoiceStats'
import type { DuplicateGroup } from '@/lib/print/qr'
import type { InvoiceMeta } from '@/lib/print/types'

const props = defineProps<{
  groups: DuplicateGroup[]
  metaOf: (pageId: string) => InvoiceMeta | undefined
  resolvePage: (pageId: string) => ResolvedPage | null
  ignored: ReadonlySet<string>
}>()

const emit = defineEmits<{
  (e: 'toggleIgnore', pageId: string): void
  (e: 'edit', pageId: string): void
}>()

function thumbOf(pid: string) {
  return props.resolvePage(pid)?.page.thumbUrl || ''
}

function roleLabel(pid: string, g: DuplicateGroup): string {
  if (props.ignored.has(pid)) return '已撤销'
  return pid === g.representativeId ? '原始票' : '重复副本'
}

function roleType(pid: string, g: DuplicateGroup): 'success' | 'danger' | 'default' {
  if (props.ignored.has(pid)) return 'default'
  return pid === g.representativeId ? 'success' : 'danger'
}

function fmt(n: number) {
  return fmtMoney(n)
}
</script>

<style scoped>
.dup-detail {
  padding: 14px;
}
.dd-head {
  font-size: 15px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
}
.dd-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.dd-group {
  margin-top: 14px;
}
.dd-group-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--van-text-color-2, #646566);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.dd-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.dd-thumb {
  width: 54px;
  height: 72px;
  object-fit: contain;
  border: 1px solid var(--van-border-color, #ebedf0);
  border-radius: 4px;
  background: #fff;
  flex-shrink: 0;
}
.dd-meta {
  flex: 1;
  min-width: 0;
}
.dd-no {
  font-size: 13px;
  color: var(--van-text-color, #323233);
  word-break: break-all;
}
.dd-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.dd-ops {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
