<template>
  <div class="page">
    <van-nav-bar title="我的" />

    <div class="user-card">
      <span class="avatar"><van-icon name="user-o" /></span>
      <div class="user-meta">
        <span class="user-name">{{ maskedMobile }}</span>
        <van-tag plain type="primary">普通用户</van-tag>
      </div>
    </div>

    <div class="stat-card">
      <div class="stat">
        <span class="stat-num">{{ auth.user?.quota_balance ?? '-' }}</span>
        <span class="stat-label">剩余额度(次)</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ totalInvoices }}</span>
        <span class="stat-label">累计识别(张)</span>
      </div>
    </div>

    <div v-if="lowQuota" class="quota-alert">
      <van-icon name="warning-o" /> 额度不足 {{ auth.user?.quota_balance }} 次，请联系管理员充值
    </div>

    <van-cell-group inset style="margin-top: 12px">
      <van-cell title="深色模式">
        <template #right-icon>
          <van-switch :model-value="dark" size="20px" @update:model-value="toggleDark()" />
        </template>
      </van-cell>
      <van-cell title="账号与安全" is-link @click="openSecurity" />
      <van-cell title="我的导出" is-link @click="showExport = true" />
      <van-cell title="联系客服" is-link @click="showToast('客服功能即将上线')" />
      <van-cell title="关于平台" is-link @click="showAbout = true" />
    </van-cell-group>

    <div style="margin: 24px 16px">
      <van-button block round type="danger" plain @click="onLogout">退出登录</van-button>
    </div>

    <van-popup v-model:show="showSecurity" round position="bottom">
      <div class="pop-head">账号与安全</div>
      <van-cell-group :border="false">
        <van-cell title="昵称" :value="auth.user?.nickname || '未设置'" is-link @click="openNick" />
        <van-cell title="邮箱" :value="emailDisplay" is-link @click="openBindEmail" />
        <van-cell title="修改密码" is-link @click="showPwd = true" />
      </van-cell-group>
      <div style="height: 24px" />
    </van-popup>

    <van-dialog v-model:show="showNick" title="修改昵称" show-cancel-button :before-close="onSaveNick">
      <van-field v-model="nickVal" label="昵称" placeholder="1-50 个字符" maxlength="50" style="margin: 12px 0" />
    </van-dialog>

    <van-dialog v-model:show="showEmail" title="绑定 / 更换邮箱" show-cancel-button :before-close="onBindEmailClose">
      <div class="email-tip">邮箱用于找回密码，需通过验证码确认归属</div>
      <van-field v-model="emailVal" label="邮箱" placeholder="请输入邮箱地址" style="margin: 8px 0" />
      <van-field v-model="emailCode" label="验证码" placeholder="6 位验证码" maxlength="6" style="margin-bottom: 12px">
        <template #button>
          <van-button size="small" type="primary" plain :disabled="codeCountdown > 0 || codeSending" @click="onSendBindCode">
            {{ codeCountdown > 0 ? `${codeCountdown}s` : '发送验证码' }}
          </van-button>
        </template>
      </van-field>
    </van-dialog>

    <van-dialog v-model:show="showPwd" title="修改密码" show-cancel-button @confirm="onChangePwd">
      <van-field v-model="oldPwd" type="password" label="原密码" placeholder="原密码" style="margin: 12px 0" />
      <van-field v-model="newPwd" type="password" label="新密码" placeholder="8-32位，含字母和数字" style="margin-bottom: 12px" />
    </van-dialog>

    <van-popup v-model:show="showExport" round position="bottom" style="min-height: 40vh">
      <div class="export-head">
        <span>导出记录</span>
        <van-button size="small" type="primary" @click="goFilteredExport">导出发票</van-button>
      </div>
      <van-empty v-if="!exports.length" description="暂无导出记录" />
      <div v-for="e in exports" :key="e.id" class="export-row">
        <div class="export-info">
          <span>{{ e.created_at?.slice(0, 19).replace('T', ' ') }}</span>
          <span v-if="exportScope(e)" class="export-scope">{{ exportScope(e) }}</span>
          <span v-if="e.status === 2 && e.error_msg" class="export-err">{{ e.error_msg }}</span>
        </div>
        <van-tag :type="e.status === 1 ? 'success' : e.status === 2 ? 'danger' : 'primary'">
          {{ ['处理中', '已完成', '失败'][e.status] }}
        </van-tag>
        <!-- 下载统一走重签拿新链接：签名 24h 过期，避免旧链接 403 -->
        <a v-if="e.status === 1" class="dl" @click="onDownload(e)">下载</a>
      </div>
    </van-popup>

    <van-dialog v-model:show="showAbout" title="关于平台" confirm-button-text="知道了">
      <div class="about">
        <p class="about-name">智能服务平台</p>
        <p>v1.0.0</p>
        <p>发票识别 · 数据导出 · 更多能力持续上线</p>
      </div>
    </van-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showSuccessToast, showToast } from 'vant'
import { bindEmail, changePassword, sendBindEmailCode, updateMe } from '@/api/auth'
import { listExports, listInvoices, resignExport, type ExportRow } from '@/api/invoices'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const { dark, toggleDark } = inject<{ dark: { value: boolean }; toggleDark: () => void }>('h5-dark')!

const lowQuota = computed(() => {
  const q = auth.user?.quota_balance
  return q !== undefined && q !== null && q < 10
})
const showPwd = ref(false)
const oldPwd = ref('')
const newPwd = ref('')
const showExport = ref(false)
const showAbout = ref(false)
const exports = ref<ExportRow[]>([])
const totalInvoices = ref(0)

// 账号与安全：昵称、邮箱
const showSecurity = ref(false)
const showNick = ref(false)
const nickVal = ref('')
const showEmail = ref(false)
const emailVal = ref('')
const emailCode = ref('')
const codeCountdown = ref(0)
const codeSending = ref(false)
let codeTimer: number | null = null

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

const maskedMobile = computed(() => {
  const m = auth.user?.mobile || ''
  return m.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
})

const emailDisplay = computed(() => {
  const e = auth.user?.email
  if (!e) return '未绑定'
  const [name, domain] = e.split('@')
  return name.length <= 2 ? `${name[0] || ''}***@${domain}` : `${name.slice(0, 2)}***@${domain}`
})

function openSecurity() {
  showSecurity.value = true
}

function openNick() {
  nickVal.value = auth.user?.nickname || ''
  showNick.value = true
}

async function onSaveNick(action: string) {
  if (action !== 'confirm') return true
  const v = nickVal.value.trim()
  if (!v) {
    showToast('昵称不能为空')
    return false
  }
  try {
    await updateMe({ nickname: v })
    await auth.fetchMe()
    showSuccessToast('昵称已更新')
    return true
  } catch {
    return false
  }
}

function openBindEmail() {
  emailVal.value = auth.user?.email || ''
  emailCode.value = ''
  codeCountdown.value = 0
  showEmail.value = true
}

function startCodeCountdown() {
  codeCountdown.value = 60
  codeTimer = window.setInterval(() => {
    codeCountdown.value -= 1
    if (codeCountdown.value <= 0 && codeTimer) {
      window.clearInterval(codeTimer)
      codeTimer = null
    }
  }, 1000)
}

async function onSendBindCode() {
  if (!EMAIL_RE.test(emailVal.value.trim())) {
    showToast('请输入正确的邮箱地址')
    return
  }
  codeSending.value = true
  try {
    await sendBindEmailCode(emailVal.value.trim())
    showSuccessToast('验证码已发送至邮箱')
    startCodeCountdown()
  } catch {
    /* 拦截器已提示 */
  } finally {
    codeSending.value = false
  }
}

async function onBindEmailClose(action: string) {
  if (action !== 'confirm') return true
  if (!EMAIL_RE.test(emailVal.value.trim())) {
    showToast('请输入正确的邮箱地址')
    return false
  }
  if (emailCode.value.trim().length !== 6) {
    showToast('请输入 6 位验证码')
    return false
  }
  try {
    await bindEmail({ email: emailVal.value.trim(), email_code: emailCode.value.trim() })
    await auth.fetchMe()
    showSuccessToast('邮箱绑定成功')
    return true
  } catch {
    return false
  }
}

async function onChangePwd() {
  if (!/^(?=.*[A-Za-z])(?=.*\d)\S{8,32}$/.test(newPwd.value)) {
    showToast('新密码需8-32位，且同时含字母和数字')
    return
  }
  try {
    await changePassword({ old_password: oldPwd.value, new_password: newPwd.value })
  } catch {
    /* 拦截器已提示，停留在弹窗 */
    return
  }
  // 后端改密即 token_version+1，所有设备令牌立即失效，必须回登录页用新密码登录
  oldPwd.value = ''
  newPwd.value = ''
  auth.logout()
  router.replace('/login')
}

async function loadExports() {
  exports.value = (await listExports()).list
}

// 导出记录的范围摘要（关键词/日期/结果筛选）
const RESULT_TEXT: Record<string, string> = { success: '仅成功', failed: '仅失败', duplicate: '仅重复' }
function exportScope(e: ExportRow): string {
  const f = e.filters
  if (!f) return ''
  const parts: string[] = []
  if (f.keywords) parts.push(`关键词“${f.keywords}”`)
  if (f.result) parts.push(RESULT_TEXT[f.result] || '')
  if (f.date_start || f.date_end) parts.push(`${f.date_start || '…'}~${f.date_end || '…'}`)
  return parts.join('，')
}

// 跳转发票库（导出按钮在那里，可按当前筛选+字段选择创建）
function goFilteredExport() {
  showExport.value = false
  router.push('/app/invoice/list')
}

// 下载统一调重签接口拿新签名链接（旧链接 24h 过期）；文件已被清理时后端明确提示重新导出
async function onDownload(e: ExportRow) {
  try {
    const { download_url } = await resignExport(e.id)
    window.open(download_url, '_blank')
  } catch {
    /* 拦截器已提示 */
  }
}

async function loadTotal() {
  const data = await listInvoices({ page: 1, page_size: 1 })
  totalInvoices.value = data.total
}

function onLogout() {
  auth.logout()
  router.replace('/login')
}

onActivated(async () => {
  auth.fetchMe().catch(() => {})
  loadExports()
  loadTotal()
  if (route.query.open === 'export') {
    showExport.value = true
    router.replace({ query: {} })
  }
})

onUnmounted(() => {
  if (codeTimer) window.clearInterval(codeTimer)
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: 72px;
  background: var(--van-background, #f6f7f9);
}
.user-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 16px 0;
  padding: 16px;
  background: var(--van-background-2, #fff);
  border-radius: 12px;
}
.avatar {
  width: 48px;
  height: 48px;
  border-radius: 999px;
  background: var(--van-background-3, #f2f3f5);
  color: var(--van-text-color-3, #969799);
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.user-meta { display: flex; flex-direction: column; gap: 6px; }
.user-name { font-size: 16px; font-weight: 600; color: var(--van-text-color, #323233); }

.stat-card {
  display: flex;
  margin: 12px 16px 0;
  background: var(--van-background-2, #fff);
  border-radius: 12px;
  padding: 16px 0;
}
.stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.stat + .stat { border-left: 1px solid var(--van-border-color, #f2f3f5); }
.stat-num { font-size: 20px; font-weight: 700; color: var(--van-text-color, #323233); }
.stat-label { font-size: 12px; color: var(--van-text-color-3, #969799); }

.quota-alert {
  margin: 8px 16px 0;
  padding: 8px 12px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 8px;
  font-size: 12px;
  color: #d48806;
  display: flex;
  align-items: center;
  gap: 4px;
}
html.van-theme-dark .quota-alert {
  background: #2a2a2a;
  border-color: #5c4a1a;
  color: #e6a23c;
}

.pop-head { padding: 16px; font-weight: 600; text-align: center; }
.email-tip { padding: 0 16px; font-size: 12px; color: var(--van-text-color-2, #969799); line-height: 1.5; }

.export-head { display: flex; justify-content: space-between; align-items: center; padding: 16px; font-weight: 600; }
.export-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--van-border-color, #f0f0f0); font-size: 13px; }
.export-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.export-scope { font-size: 12px; color: var(--van-text-color-3, #969799); }
.export-err { font-size: 12px; color: #ee0a24; word-break: break-all; }
.dl { margin-left: auto; color: #1989fa; }

.about { padding: 8px 16px 20px; text-align: center; color: var(--van-text-color-3, #969799); font-size: 12px; }
.about p { margin: 4px 0; }
.about-name { font-size: 15px; font-weight: 600; color: var(--van-text-color, #323233); }
</style>
