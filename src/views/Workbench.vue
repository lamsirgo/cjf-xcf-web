<template>
  <div class="page">
    <div class="greet-row">
      <div class="greet">
        <p class="hi">{{ greeting }}</p>
        <p class="mobile">{{ maskedMobile }}</p>
      </div>
      <div class="top-actions">
        <van-icon
          :name="dark ? 'moon-o' : 'sun-o'"
          class="top-icon"
          @click="toggleDark"
        />
        <van-icon name="bell" class="top-icon" @click="showToast('暂无新消息')" />
      </div>
    </div>

    <!-- 常用应用（动态读取，默认选中：is_default 应用） -->
    <section class="block">
      <div class="sec-head">
        <span class="sec-title">常用应用</span>
      </div>
      <div v-if="apps.length === 0" class="empty">应用加载中…</div>
      <div class="app-grid">
        <div
          v-for="a in apps"
          :key="a.id"
          class="tile"
          :class="{ 'is-selected': a.is_default === 1, 'is-off': !a.usable, 'is-beta': a.is_beta }"
          @click="openApp(a)"
        >
          <span class="tic"><van-icon :name="a.icon || 'apps-o'" /></span>
          <span class="tname">{{ a.name }}</span>
          <span v-if="a.is_beta" class="beta-tag">内测</span>
        </div>
      </div>
    </section>

    <!-- 剩余识别额度 -->
    <section class="block">
      <div class="quota-card">
        <div class="q-label">剩余识别额度</div>
        <div class="q-num">{{ auth.user?.quota_balance ?? '-' }}<span class="q-unit">次</span></div>
        <div v-if="lowQuota" class="q-warn">
          <van-icon name="warning-o" /> 额度不足，请及时联系管理员
        </div>
        <div v-else class="q-foot">
          <span>额度不足请联系管理员</span>
          <span class="q-go" @click="openDefault">去识别 ›</span>
        </div>
      </div>
    </section>

    <!-- 最近任务 -->
    <section class="block">
      <div class="sec-head">
        <span class="sec-title">最近任务</span>
        <span class="sec-link" @click="router.push('/tasks')">查看全部 ›</span>
      </div>
      <div v-if="recent.length === 0" class="empty">暂无任务，去上传一个压缩包吧</div>
      <div v-for="p in recent" :key="p.id" class="task-card" @click="router.push('/tasks')">
        <div class="task-top">
          <span class="task-name">{{ p.filename }}</span>
          <van-tag :type="tagType(p.status)">{{ p.status_text }}</van-tag>
        </div>
        <van-progress v-if="p.status === 0 || p.status === 1" :percentage="p.progress" class="task-bar" />
        <div class="task-sub">
          {{ p.success_files }}成功 / {{ p.failed_files }}失败 / 共{{ p.total_files }}张
          <span v-if="p.queue_pos">· 排队第{{ p.queue_pos }}位</span>
          · {{ fmtTime(p.created_at) }}
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { listApps, type AppItem } from '@/api/apps'
import { listPackages, type PackageItem } from '@/api/packages'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const { dark, toggleDark } = inject<{ dark: { value: boolean }; toggleDark: () => void }>('h5-dark')!

const apps = ref<AppItem[]>([])
const recent = ref<PackageItem[]>([])

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '上午好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

const maskedMobile = computed(() => {
  const m = auth.user?.mobile || ''
  return m.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
})

const lowQuota = computed(() => {
  const q = auth.user?.quota_balance
  return q !== undefined && q !== null && q < 10
})

function openApp(a: AppItem) {
  if (!a.usable) {
    showToast(a.is_beta ? '内测中，敬请期待' : '即将上线，敬请期待')
    return
  }
  if (a.path) router.push(a.path)
}

function openDefault() {
  const a = apps.value.find((x) => x.is_default === 1 && x.usable)
  if (a) openApp(a)
}

function tagType(status: number) {
  return ({ 0: 'primary', 1: 'warning', 2: 'success', 3: 'warning', 4: 'danger' } as const)[status] ?? 'primary'
}

function fmtTime(s: string) {
  return s?.slice(0, 16).replace('T', ' ')
}

/** 金刚位缓存（localStorage，30 秒 TTL） */
const CACHE_KEY = 'h5_apps_cache'
const CACHE_TTL = 30_000
function loadCachedApps(): AppItem[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    if (Date.now() - ts < CACHE_TTL) return data
    localStorage.removeItem(CACHE_KEY)
    return null
  } catch {
    return null
  }
}
function saveCachedApps(data: AppItem[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() }))
  } catch { /* storage full */ }
}

onActivated(async () => {
  await auth.fetchMe().catch(() => {})

  const cached = loadCachedApps()
  if (cached) apps.value = cached

  const [appData, pkgData] = await Promise.all([
    listApps().catch(() => null),
    listPackages(1).catch(() => null),
  ])

  if (appData?.list) {
    apps.value = appData.list
    saveCachedApps(appData.list)
  }
  recent.value = pkgData?.list.slice(0, 2) ?? []
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 0 12px 72px;
  background: var(--van-background, #f6f7f9);
}
.greet-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 4px 4px;
}
.hi { margin: 0; font-size: 20px; font-weight: 600; color: var(--van-text-color, #323233); }
.mobile { margin: 4px 0 0; font-size: 13px; color: var(--van-text-color-3, #969799); }
.top-actions { display: flex; align-items: center; gap: 14px; }
.top-icon { font-size: 22px; color: var(--van-text-color, #323233); }

.block { margin-top: 16px; }
.sec-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.sec-title { font-size: 15px; font-weight: 600; color: var(--van-text-color, #323233); }
.sec-link { font-size: 12px; color: var(--van-text-color-3, #969799); }

.app-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.tile {
  position: relative;
  background: var(--van-background-2, #fff);
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 12px 4px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.tic {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  background: var(--van-background-3, #f2f3f5);
  color: #c8c9cc;
}
.tname { font-size: 12px; color: var(--van-text-color-3, #969799); }
.tile.is-off { opacity: .6; }
.tile.is-beta .tic { background: #fff7e6; color: #ff976a; }
.beta-tag {
  position: absolute;
  top: 2px;
  right: 2px;
  font-size: 9px;
  color: #fff;
  background: #ff976a;
  padding: 0 4px;
  border-radius: 4px;
  line-height: 14px;
}
.tile.is-selected { border-color: rgba(25, 137, 250, .5); }
.tile.is-selected .tic { background: #ecf5ff; color: #1989fa; }
.tile.is-selected .tname { color: #1989fa; font-weight: 500; }

.quota-card {
  background: var(--van-background-2, #fff);
  border-radius: 12px;
  padding: 16px;
}
.q-label { font-size: 13px; color: var(--van-text-color-3, #969799); }
.q-num { margin-top: 6px; font-size: 30px; font-weight: 700; color: var(--van-text-color, #323233); line-height: 1.2; }
.q-unit { font-size: 14px; font-weight: 400; margin-left: 4px; }
.q-warn {
  margin-top: 10px;
  font-size: 12px;
  color: #ee0a24;
  display: flex;
  align-items: center;
  gap: 4px;
}
.q-foot { margin-top: 10px; display: flex; justify-content: space-between; font-size: 12px; color: var(--van-text-color-3, #969799); }
.q-go { color: #1989fa; }

.empty {
  background: var(--van-background-2, #fff);
  border-radius: 12px;
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
}
.task-card { background: var(--van-background-2, #fff); border-radius: 12px; padding: 12px; }
.task-card + .task-card { margin-top: 8px; }
.task-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.task-name { font-size: 14px; font-weight: 600; word-break: break-all; }
.task-bar { margin-top: 8px; }
.task-sub { margin-top: 6px; font-size: 12px; color: var(--van-text-color-3, #969799); }
</style>
