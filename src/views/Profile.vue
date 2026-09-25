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
      <van-cell title="账号与安全" is-link @click="showPwd = true" />
      <van-cell title="我的导出" is-link @click="showExport = true" />
      <van-cell title="联系客服" is-link @click="showToast('客服功能即将上线')" />
      <van-cell title="关于平台" is-link @click="showAbout = true" />
    </van-cell-group>

    <div style="margin: 24px 16px">
      <van-button block round type="danger" plain @click="onLogout">退出登录</van-button>
    </div>

    <van-dialog v-model:show="showPwd" title="修改密码" show-cancel-button @confirm="onChangePwd">
      <van-field v-model="oldPwd" type="password" label="原密码" placeholder="原密码" style="margin: 12px 0" />
      <van-field v-model="newPwd" type="password" label="新密码" placeholder="至少6位" style="margin-bottom: 12px" />
    </van-dialog>

    <van-popup v-model:show="showExport" round position="bottom" style="min-height: 40vh">
      <div class="export-head">
        <span>导出记录</span>
        <van-button size="small" type="primary" @click="onExport">导出全部发票</van-button>
      </div>
      <div v-for="e in exports" :key="e.id" class="export-row">
        <span>{{ e.created_at?.slice(0, 19).replace('T', ' ') }}</span>
        <van-tag :type="e.status === 1 ? 'success' : e.status === 2 ? 'danger' : 'primary'">
          {{ ['处理中', '已完成', '失败'][e.status] }}
        </van-tag>
        <a v-if="e.status === 1" :href="e.download_url" class="dl">下载</a>
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
import { computed, inject, onActivated, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { changePassword } from '@/api/auth'
import { createExport, listExports, listInvoices } from '@/api/invoices'
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
const exports = ref<any[]>([])
const totalInvoices = ref(0)

const maskedMobile = computed(() => {
  const m = auth.user?.mobile || ''
  return m.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
})

async function onChangePwd() {
  if (newPwd.value.length < 6) {
    showToast('新密码至少6位')
    return
  }
  await changePassword({ old_password: oldPwd.value, new_password: newPwd.value })
  showToast('修改成功')
  showPwd.value = false
}

async function loadExports() {
  exports.value = (await listExports()).list
}

async function loadTotal() {
  const data = await listInvoices({ page: 1, page_size: 1 })
  totalInvoices.value = data.total
}

async function onExport() {
  await createExport()
  showToast('已创建导出任务，完成后可下载')
  loadExports()
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
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding-bottom: 72px;
  background: #f6f7f9;
}
.user-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 16px 0;
  padding: 16px;
  background: #fff;
  border-radius: 12px;
}
.avatar {
  width: 48px;
  height: 48px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #969799;
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.user-meta { display: flex; flex-direction: column; gap: 6px; }
.user-name { font-size: 16px; font-weight: 600; color: #323233; }

.stat-card {
  display: flex;
  margin: 12px 16px 0;
  background: #fff;
  border-radius: 12px;
  padding: 16px 0;
}
.stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.stat + .stat { border-left: 1px solid #f2f3f5; }
.stat-num { font-size: 20px; font-weight: 700; color: #323233; }
.stat-label { font-size: 12px; color: #969799; }

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

.export-head { display: flex; justify-content: space-between; align-items: center; padding: 16px; font-weight: 600; }
.export-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid #f0f0f0; font-size: 13px; }
.dl { margin-left: auto; color: #1989fa; }

.about { padding: 8px 16px 20px; text-align: center; color: #969799; font-size: 12px; }
.about p { margin: 4px 0; }
.about-name { font-size: 15px; font-weight: 600; color: #323233; }
</style>
