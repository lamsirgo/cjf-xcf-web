<template>
  <div class="page">
    <van-nav-bar title="发票详情" left-arrow @click-left="$router.back()" />
    <van-loading v-if="loading" class="center" />
    <template v-else-if="inv">
      <!-- 原图预览 -->
      <van-cell-group inset style="margin-top: 12px">
        <template v-if="rawUrl && isImage">
          <div class="raw-wrap" @click="previewImage">
            <img :src="rawUrl" class="raw-img" alt="发票原图" />
            <span class="raw-tip">点击放大</span>
          </div>
        </template>
        <van-cell v-else-if="inv.has_file" title="原文件" is-link @click="openRaw">
          <template #right-icon>
            <span class="raw-link">{{ inv.file_ext === 'pdf' ? '查看 PDF' : '查看原图' }}</span>
          </template>
        </van-cell>
        <van-cell v-else title="原文件" value="已过保留期被清理" />
      </van-cell-group>

      <!-- 失败分类与重试指引 -->
      <div v-if="inv.fail_type" class="fail-card">
        <div class="fail-head">
          <van-icon name="warning-o" />
          <span>{{ FAIL_TYPE_TEXT[inv.fail_type] || '解析失败' }}</span>
        </div>
        <p v-if="inv.fail_reason" class="fail-reason">{{ inv.fail_reason }}</p>
        <p class="fail-guide">{{ FAIL_GUIDE[inv.fail_type] }}</p>
        <van-button size="small" type="primary" plain block @click="router.push('/tasks')">
          前往任务页重试
        </van-button>
      </div>

      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="发票号码" :value="inv.invoice_num || '—'" />
        <van-cell title="发票代码" :value="inv.invoice_code || '—'" />
        <van-cell title="发票类型" :value="inv.invoice_type || '—'" />
        <van-cell title="开票日期" :value="fmtDateTime(inv.invoice_date)" />
        <van-cell title="价税合计" :value="`¥${Number(inv.total_amount ?? 0).toFixed(2)}`" value-class="amount" />
      </van-cell-group>
      <van-cell-group inset style="margin-top: 12px">
        <van-cell title="购买方" :label="inv.purchaser_name || '—'" />
        <van-cell title="购买方税号" :value="inv.purchaser_register_num || '—'" />
        <van-cell title="销售方" :label="inv.seller_name || '—'" />
        <van-cell title="销售方税号" :value="inv.seller_register_num || '—'" />
      </van-cell-group>
      <div class="section">货物明细</div>
      <div v-for="(item, i) in inv.items || []" :key="i" class="item-card">
        <div class="i-name">{{ item.commodity_name || '—' }}</div>
        <div class="i-grid">
          <span>规格: {{ item.commodity_type || '—' }}</span>
          <span>单位: {{ item.commodity_unit || '—' }}</span>
          <span>数量: {{ item.commodity_num || '—' }}</span>
          <span>单价: {{ item.commodity_price || '—' }}</span>
          <span>金额: {{ item.commodity_amount || '—' }}</span>
          <span>税率: {{ item.commodity_tax_rate || '—' }}</span>
        </div>
      </div>

      <div class="btn-wrap">
        <van-button type="primary" block @click="openEdit">校正字段</van-button>
        <van-button plain type="danger" block style="margin-top: 10px" @click="onDelete">删除该发票</van-button>
      </div>
    </template>
    <div v-else class="error-block">
      <p>{{ loadError || '发票不存在或已被删除' }}</p>
      <van-button size="small" type="primary" @click="$router.back()">返回</van-button>
    </div>

    <!-- 人工校正：主字段 + 货物明细整体替换 -->
    <van-popup v-model:show="showEdit" position="bottom" round class="edit-pop">
      <div class="edit-head">
        <span class="edit-title">校正发票字段</span>
        <van-button size="mini" plain type="primary" @click="addItem">+ 明细行</van-button>
      </div>
      <div class="edit-body">
        <van-cell-group inset>
          <van-field v-model="form.invoice_num" label="发票号码" placeholder="请输入" />
          <van-field v-model="form.invoice_code" label="发票代码" placeholder="请输入" />
          <van-field v-model="form.invoice_type" label="发票类型" placeholder="请输入" />
          <van-field
            v-model="form.invoice_date"
            label="开票日期"
            placeholder="YYYY-MM-DD"
            :rules="[{ pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式 YYYY-MM-DD' }]"
          />
          <van-field v-model="form.total_amount" type="number" label="价税合计" placeholder="0.00" />
          <van-field v-model="form.purchaser_name" label="购买方" placeholder="请输入" />
          <van-field v-model="form.purchaser_register_num" label="购买方税号" placeholder="请输入" />
          <van-field v-model="form.seller_name" label="销售方" placeholder="请输入" />
          <van-field v-model="form.seller_register_num" label="销售方税号" placeholder="请输入" />
        </van-cell-group>
        <div class="section">货物明细</div>
        <div v-for="(item, i) in form.items" :key="i" class="edit-item">
          <div class="edit-item-head">
            <span>明细 {{ i + 1 }}</span>
            <van-icon name="delete-o" class="del-icon" @click="form.items.splice(i, 1)" />
          </div>
          <van-cell-group inset>
            <van-field v-model="item.commodity_name" label="名称" placeholder="请输入" />
            <van-field v-model="item.commodity_type" label="规格型号" placeholder="请输入" />
            <van-field v-model="item.commodity_unit" label="单位" placeholder="请输入" />
            <van-field v-model="item.commodity_num" label="数量" placeholder="请输入" />
            <van-field v-model="item.commodity_price" label="单价" placeholder="请输入" />
            <van-field v-model="item.commodity_amount" label="金额" placeholder="请输入" />
            <van-field v-model="item.commodity_tax_rate" label="税率" placeholder="如 13%" />
          </van-cell-group>
        </div>
      </div>
      <div class="edit-foot van-safe-area-bottom">
        <van-button block @click="showEdit = false">取消</van-button>
        <van-button block type="primary" :loading="saving" @click="onSave">保存</van-button>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showImagePreview, showToast } from 'vant'
import {
  deleteInvoices,
  fetchInvoiceRaw,
  getInvoiceDetail,
  updateInvoice,
  type InvoiceDetailData,
  type InvoiceItemPayload,
} from '@/api/invoices'

const route = useRoute()
const router = useRouter()
const inv = ref<InvoiceDetailData | null>(null)
const loading = ref(true)
const loadError = ref('')

// 失败分类文案与重试指引（与后端 FailType 对应）
const FAIL_TYPE_TEXT: Record<number, string> = {
  1: '非发票文件',
  2: '图片不清晰',
  3: '文件已加密',
  4: '解析失败',
}
const FAIL_GUIDE: Record<number, string> = {
  1: '该文件未识别为有效发票，请确认内容无误后重新上传。',
  2: '图片模糊或分辨率不足，请提供更清晰的扫描件/照片后重新上传。',
  3: '文件带有密码保护，请先在 PDF 阅读器中解除密码后重新上传。',
  4: '识别服务暂时异常或文件损坏，可直接重试；多次失败请联系管理员。',
}

// ---------- 原图预览（blob + objectURL，避免 token 进 URL） ----------
const rawUrl = ref('')
const isImage = computed(() => ['jpg', 'jpeg', 'png'].includes((inv.value?.file_ext || '').toLowerCase()))

async function openRaw() {
  if (!inv.value || !inv.value.has_file) return
  if (rawUrl.value) {
    if (isImage.value) previewImage()
    else window.open(rawUrl.value, '_blank')
    return
  }
  try {
    const blob = await fetchInvoiceRaw(inv.value.id)
    rawUrl.value = URL.createObjectURL(blob)
    if (isImage.value) previewImage()
    else window.open(rawUrl.value, '_blank')
  } catch {
    /* 拦截器已提示（如已过保留期被清理） */
  }
}

function previewImage() {
  if (rawUrl.value) showImagePreview({ images: [rawUrl.value] })
}

onUnmounted(() => {
  if (rawUrl.value) URL.revokeObjectURL(rawUrl.value)
})

// ---------- 人工校正 ----------
const showEdit = ref(false)
const saving = ref(false)
const form = reactive({
  invoice_num: '',
  invoice_code: '',
  invoice_type: '',
  invoice_date: '',
  total_amount: '' as string | number,
  purchaser_name: '',
  purchaser_register_num: '',
  seller_name: '',
  seller_register_num: '',
  items: [] as InvoiceItemPayload[],
})

const emptyItem = (): InvoiceItemPayload => ({
  commodity_name: '',
  commodity_type: '',
  commodity_unit: '',
  commodity_num: '',
  commodity_price: '',
  commodity_amount: '',
  commodity_tax_rate: '',
})

function openEdit() {
  if (!inv.value) return
  form.invoice_num = inv.value.invoice_num
  form.invoice_code = inv.value.invoice_code
  form.invoice_type = inv.value.invoice_type
  form.invoice_date = (inv.value.invoice_date || '').slice(0, 10)
  form.total_amount = Number(inv.value.total_amount ?? 0).toFixed(2)
  form.purchaser_name = inv.value.purchaser_name
  form.purchaser_register_num = inv.value.purchaser_register_num
  form.seller_name = inv.value.seller_name
  form.seller_register_num = inv.value.seller_register_num
  form.items = (inv.value.items || []).map((it) => ({ ...emptyItem(), ...it }))
  showEdit.value = true
}

function addItem() {
  form.items.push(emptyItem())
}

async function onSave() {
  if (!inv.value) return
  if (form.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(form.invoice_date)) {
    showToast('开票日期格式应为 YYYY-MM-DD')
    return
  }
  saving.value = true
  try {
    await updateInvoice(inv.value.id, {
      invoice_num: form.invoice_num,
      invoice_code: form.invoice_code,
      invoice_type: form.invoice_type,
      invoice_date: form.invoice_date,
      total_amount: Number(form.total_amount) || 0,
      purchaser_name: form.purchaser_name,
      purchaser_register_num: form.purchaser_register_num,
      seller_name: form.seller_name,
      seller_register_num: form.seller_register_num,
      items: form.items,
    })
    showToast('已保存')
    showEdit.value = false
    inv.value = await getInvoiceDetail(inv.value.id)
  } catch {
    /* 拦截器已提示 */
  } finally {
    saving.value = false
  }
}

// ---------- 通用 ----------
function pad(n: number) {
  return String(n).padStart(2, '0')
}

function fmtDateTime(s: string) {
  if (!s) return '—'
  // 纯日期按本地时区解析，避免 UTC 零点在东八区显示成前一天
  const local = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return s
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return day
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function onDelete() {
  if (!inv.value) return
  try {
    await showConfirmDialog({
      title: '删除发票',
      message: '确定删除该发票吗？删除后不可恢复。',
      confirmButtonText: '删除',
      confirmButtonColor: '#ee0a24',
    })
  } catch {
    return
  }
  try {
    await deleteInvoices([inv.value.id])
    showToast('已删除')
    router.replace('/app/invoice/list')
  } catch {
    /* 拦截器已提示 */
  }
}

onMounted(async () => {
  try {
    inv.value = await getInvoiceDetail(Number(route.params.id))
    // 图片类自动加载预览；PDF 等用户点击再拉取
    if (inv.value.has_file && ['jpg', 'jpeg', 'png'].includes((inv.value.file_ext || '').toLowerCase())) {
      const blob = await fetchInvoiceRaw(inv.value.id)
      rawUrl.value = URL.createObjectURL(blob)
    }
  } catch {
    // 404/无权限/网络错误：进入明确的错误态，而不是永久转圈
    if (!inv.value) loadError.value = '发票加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.center { display: flex; justify-content: center; padding-top: 120px; }
.amount { color: #ee0a24; }
.section { margin: 16px 16px 0; font-weight: 600; }
.item-card { background: var(--van-background-2, #fff); border-radius: 8px; margin: 10px 16px; padding: 12px; }
.i-name { font-weight: 500; margin-bottom: 6px; }
.i-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; color: var(--van-text-color-2, #646566); font-size: 13px; }

.raw-wrap { position: relative; padding: 12px; }
.raw-img { width: 100%; border-radius: 6px; display: block; }
.raw-tip {
  position: absolute;
  right: 18px;
  bottom: 18px;
  font-size: 11px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  padding: 2px 8px;
  border-radius: 999px;
}
.raw-link { color: var(--van-primary-color, #1989fa); font-size: 13px; }

.fail-card {
  margin: 12px 16px 0;
  padding: 12px;
  background: var(--van-background-2, #fff);
  border: 1px solid #ffd591;
  border-radius: 8px;
}
.fail-head { display: flex; align-items: center; gap: 6px; color: #d48806; font-weight: 600; font-size: 14px; }
.fail-reason { margin: 8px 0 0; color: #ee0a24; font-size: 12px; word-break: break-all; }
.fail-guide { margin: 8px 0 10px; color: var(--van-text-color-2, #646566); font-size: 12px; line-height: 1.5; }

.btn-wrap { margin: 20px 16px; }
.error-block { display: flex; flex-direction: column; align-items: center; gap: 12px; padding-top: 120px; color: var(--van-text-color-3, #969799); }

.edit-pop { height: 88vh; display: flex; flex-direction: column; }
.edit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--van-border-color, #ebedf0);
}
.edit-title { font-weight: 600; }
.edit-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-top: 12px; }
.edit-item { margin-top: 10px; }
.edit-item-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0 24px 6px;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
}
.del-icon { color: #ee0a24; font-size: 16px; }
.edit-foot { display: flex; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--van-border-color, #ebedf0); }
</style>
