<template>
  <teleport to="body">
    <transition name="slide-panel">
      <div v-if="show" class="inv-side-panel">
        <div class="panel-head">
          <span class="panel-title">发票详情</span>
          <van-icon name="cross" class="panel-close" @click="close" />
        </div>

        <div v-if="loading" class="panel-loading">
          <van-loading vertical>加载中…</van-loading>
        </div>

        <div v-else-if="detail" class="panel-body">
          <div class="num-line">
            <span class="num">{{ detail.invoice_num || '（无号码）' }}</span>
            <span class="amount">¥{{ Number(detail.total_amount ?? 0).toFixed(2) }}</span>
          </div>

          <div class="kv"><span class="k">发票代码</span><span>{{ detail.invoice_code || '—' }}</span></div>
          <div class="kv"><span class="k">发票类型</span><span>{{ detail.invoice_type || '—' }}</span></div>
          <div class="kv"><span class="k">开票日期</span><span>{{ detail.invoice_date || '—' }}</span></div>
          <div class="kv"><span class="k">销售方</span><span class="v-right">{{ detail.seller_name || '—' }}</span></div>
          <div class="kv"><span class="k">销售方税号</span><span>{{ detail.seller_register_num || '—' }}</span></div>
          <div class="kv"><span class="k">购买方</span><span class="v-right">{{ detail.purchaser_name || '—' }}</span></div>
          <div class="kv"><span class="k">购买方税号</span><span>{{ detail.purchaser_register_num || '—' }}</span></div>
          <div class="kv"><span class="k">来源文件</span><span class="v-right">{{ detail.package_filename || '—' }}</span></div>

          <template v-if="detail.items?.length">
            <div class="items-title">货物明细（{{ detail.items.length }}）</div>
            <div class="item-row" v-for="(it, i) in detail.items" :key="i">
              <div class="item-name">{{ it.commodity_name || '—' }}</div>
              <div class="item-sub">
                    <span v-if="it.commodity_num">数量 {{ it.commodity_num }}</span>
                    <span v-if="it.commodity_price">单价 {{ it.commodity_price }}</span>
                    <span v-if="it.commodity_tax_rate">税率 {{ it.commodity_tax_rate }}</span>
                  </div>
              <div class="item-amt">¥{{ it.commodity_amount || '0' }}</div>
            </div>
          </template>

          <div v-if="detail.fail_reason" class="fail-line">{{ detail.fail_reason }}</div>
        </div>

        <div v-if="detail" class="panel-foot">
          <van-button size="small" type="primary" block @click="goEdit">校正 / 查看大图</van-button>
          <van-button size="small" type="danger" plain block :loading="deleting" @click="onDelete">删除</van-button>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog } from 'vant'
import { deleteInvoices, getInvoice, type InvoiceDetailData } from '@/api/invoices'

// 侧滑面板用列表接口（getInvoice）而非详情接口：detail 所需字段都包含且带 package_filename
type PanelInvoice = InvoiceDetailData & { package_filename?: string }

const props = defineProps<{ show: boolean; invoiceId: number | null }>()
const emit = defineEmits<{ 'update:show': [boolean]; deleted: [number] }>()

const router = useRouter()
const detail = ref<PanelInvoice | null>(null)
const loading = ref(false)
const deleting = ref(false)

watch(
  () => [props.show, props.invoiceId] as const,
  async ([show, id]) => {
    if (!show || !id || typeof id !== 'number') return
    loading.value = true
    detail.value = null
    try {
      // getInvoice 返回类型与 InvoiceDetailData 仅差 file_id/file_ext/has_file 等字段，面板未使用
      detail.value = (await getInvoice(id)) as unknown as PanelInvoice
    } catch {
      close()
    } finally {
      loading.value = false
    }
  },
)

function close() {
  emit('update:show', false)
}

function goEdit() {
  if (props.invoiceId) router.push(`/app/invoice/${props.invoiceId}`)
}

async function onDelete() {
  if (!props.invoiceId) return
  try {
    await showConfirmDialog({
      title: '删除发票',
      message: '确定删除这张发票吗？删除后不可恢复。',
      confirmButtonText: '删除',
      confirmButtonColor: '#ee0a24',
    })
  } catch {
    return
  }
  deleting.value = true
  try {
    await deleteInvoices([props.invoiceId])
    emit('deleted', props.invoiceId)
    close()
  } catch {
    /* 拦截器已提示 */
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.inv-side-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--van-background-2, #fff);
  border-left: 1px solid var(--van-border-color, #ebedf0);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.08);
}
.panel-head {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.panel-title { font-size: 15px; font-weight: 600; color: var(--van-text-color, #323233); }
.panel-close { font-size: 18px; color: var(--van-text-color-3, #969799); cursor: pointer; }
.panel-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
.panel-body { flex: 1; overflow-y: auto; padding: 16px; }
.num-line { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.num { font-size: 16px; font-weight: 600; color: var(--van-text-color, #323233); }
.amount { font-size: 16px; font-weight: 600; color: var(--van-danger-color); }
.kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--van-border-color, #ebedf0);
  font-size: 13px;
  color: var(--van-text-color, #323233);
}
.kv .k { flex-shrink: 0; color: var(--van-text-color-3, #969799); }
.v-right { text-align: right; word-break: break-all; }
.items-title { margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: var(--van-text-color, #323233); }
.item-row {
  padding: 8px 0;
  border-top: 1px dashed var(--van-border-color, #ebedf0);
  font-size: 13px;
}
.item-name { color: var(--van-text-color, #323233); }
.item-sub { display: flex; gap: 12px; margin-top: 2px; font-size: 12px; color: var(--van-text-color-3, #969799); }
.item-amt { margin-top: 2px; font-size: 12px; color: var(--van-text-color-2, #646566); }
.fail-line { margin-top: 12px; font-size: 12px; color: var(--van-danger-color); }
.panel-foot {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--van-border-color, #ebedf0);
}

.slide-panel-enter-active,
.slide-panel-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.slide-panel-enter-from,
.slide-panel-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
