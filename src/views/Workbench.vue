<template>
  <div class="page pc-container">
    <div class="greet-row">
      <div class="greet">
        <p class="hi">{{ greeting }}</p>
        <p class="mobile">{{ maskedMobile }}</p>
      </div>
      <div class="top-actions">
        <van-icon
          :name="dark ? 'bulb-o' : 'points'"
          class="top-icon"
          @click="toggleDark"
        />
        <van-badge :content="unreadCount || ''" :dot="unreadCount === 0 ? false : unreadCount > 99" max="99">
          <van-icon name="bell" class="top-icon" @click="router.push('/notifications')" />
        </van-badge>
      </div>
    </div>

    <div class="pc-cols">
      <!-- 常用应用（动态读取，默认选中：is_default 应用） -->
      <section class="block sec-apps">
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
            <span class="tinfo">
              <span class="tname">{{ a.name }}</span>
              <span v-if="a.description" class="tdesc">{{ a.description }}</span>
            </span>
            <span v-if="a.is_beta" class="beta-tag">内测</span>
          </div>
        </div>
      </section>

      <!-- 剩余识别额度（PC 下与问候同行，位于右上角） -->
      <section class="block sec-quota">
        <div class="quota-card" :class="{ 'is-low': lowQuota }">
          <div class="q-label">剩余识别额度</div>
          <div class="q-num">{{ auth.user?.quota_balance ?? '-' }}<span class="q-unit">次</span></div>
          <div class="q-bottom">
            <div class="q-hint">
              <van-icon name="warning-o" /> 额度不足请联系管理员
            </div>
            <div class="q-go" @click="openDefault">去识别 ›</div>
          </div>
        </div>
      </section>

      <!-- 最近任务 -->
      <section class="block sec-recent">
        <div class="sec-head">
          <span class="sec-title">最近任务</span>
          <span class="sec-link" @click="router.push('/tasks')">查看全部 ›</span>
        </div>
        <div v-if="recent.length === 0" class="empty">暂无任务，去上传一个压缩包吧</div>
        <div class="task-list">
          <div v-for="p in recent" :key="p.id" class="task-card" @click="router.push('/tasks')">
            <span class="task-ico" :class="`task-ico-${fileKind(p.filename)}`">
              <van-icon :name="fileIcon(p.filename)" />
            </span>
            <div class="task-body">
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
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { listApps, type AppItem } from '@/api/apps'
import { listNotifications } from '@/api/notifications'
import { listPackages, type PackageItem } from '@/api/packages'
import { onNotifyEvent } from '@/composables/notification-sse'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const { dark, toggleDark } = inject<{ dark: { value: boolean }; toggleDark: () => void }>('h5-dark')!

const apps = ref<AppItem[]>([])
const recent = ref<PackageItem[]>([])
const unreadCount = ref(0)

// SSE：新通知到达时即时刷新未读数（替代 30 秒轮询）
onNotifyEvent((event) => {
  if (event.type === 'notification') loadUnreadCount()
})

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

/** 最近任务文件类型（仅 PC 列表图标用） */
function fileKind(name: string): 'zip' | 'pdf' | 'img' | 'file' {
  const n = name.toLowerCase()
  if (/\.(zip|rar|7z)$/.test(n)) return 'zip'
  if (n.endsWith('.pdf')) return 'pdf'
  if (/\.(png|jpe?g)$/.test(n)) return 'img'
  return 'file'
}
function fileIcon(name: string) {
  return ({ zip: 'cluster-o', pdf: 'description', img: 'photo-o', file: 'description-o' } as const)[fileKind(name)]
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

async function loadUnreadCount() {
  try {
    const data = await listNotifications()
    unreadCount.value = data.list.filter((n) => !n.is_read).length
  } catch {
    /* 静默失败 */
  }
}

onActivated(async () => {
  await auth.fetchMe().catch(() => {})
  await loadUnreadCount()

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
  color: var(--van-gray-5);
}
.tname { font-size: 12px; color: var(--van-text-color-3, #969799); }
.tdesc { display: none; }
.tinfo { display: flex; flex-direction: column; align-items: center; gap: 2px; }
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
.tile.is-selected .tic { background: #ecf5ff; color: var(--van-primary-color); }
.tile.is-selected .tname { color: var(--van-primary-color); font-weight: 500; }

.quota-card {
  background: var(--van-background-2, #fff);
  border-radius: 12px;
  padding: 16px;
}
.q-label { font-size: 13px; color: var(--van-text-color-3, #969799); }
.q-num { margin-top: 6px; font-size: 30px; font-weight: 700; color: var(--van-text-color, #323233); line-height: 1.2; }
.q-unit { font-size: 14px; font-weight: 400; margin-left: 4px; }
/* 移动端：提示与「去识别」同一行左右分布 */
.q-bottom {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.q-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--van-text-color-3, #969799);
}
.quota-card.is-low .q-hint { color: var(--van-danger-color); }
.q-go { color: var(--van-primary-color); }

.empty {
  background: var(--van-background-2, #fff);
  border-radius: 12px;
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--van-text-color-3, #969799);
}
/* 文件类型图标仅 PC 展示，移动端保持纯文字行 */
.task-ico { display: none; }
.task-body { min-width: 0; flex: 1; }
.task-card { background: var(--van-background-2, #fff); border-radius: 12px; padding: 12px; }
.task-card + .task-card { margin-top: 8px; }
.task-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.task-name { font-size: 14px; font-weight: 600; word-break: break-all; }
.task-bar { margin-top: 8px; }
.task-sub { margin-top: 6px; font-size: 12px; color: var(--van-text-color-3, #969799); }

@media (min-width: 1024px) {
  /* PC 整体栅格（对齐参考稿）：
     第 1 行 = 问候/铃铛（左）+ 额度卡（右）
     第 2 行 = 常用应用通栏
     第 3 行 = 最近任务通栏
     .pc-cols 仅作移动端分组容器，PC 下 display:contents 让子项参与本栅格，
     DOM 顺序保持移动端不变 */
  .page {
    /* 覆盖全局 .pc-container 的 1080px 限宽，内容随主区拉伸至满宽 */
    max-width: none;
    padding: 26px 32px 40px;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    grid-template-areas:
      "greet quota"
      "apps  apps"
      "recent recent";
    column-gap: 24px;
    row-gap: 22px;
    align-items: start;
  }

  /* 顶部问候：大号问候 + 右侧操作（铃铛停在额度卡左侧） */
  .greet-row {
    grid-area: greet;
    margin: 0;
    padding: 4px 0 0;
  }
  .pc-cols { display: contents; }
  .sec-apps { grid-area: apps; margin-top: 0; min-width: 0; }
  .sec-quota { grid-area: quota; margin-top: 0; min-width: 0; }
  .sec-recent { grid-area: recent; margin-top: 0; min-width: 0; }

  .hi { font-size: 28px; font-weight: 700; }
  .mobile { font-size: 13px; margin-top: 4px; }
  .top-icon { font-size: 22px; }
  .top-actions { gap: 18px; }

  /* 区块标题：蓝色竖条 */
  .sec-head { margin-bottom: 12px; }
  .sec-title {
    position: relative;
    padding-left: 10px;
    font-size: 16px;
    font-weight: 700;
    line-height: 18px;
    color: var(--van-text-color, #323233);
  }
  .sec-title::before {
    content: '';
    position: absolute;
    left: 0;
    top: 1px;
    width: 4px;
    height: 16px;
    border-radius: 2px;
    background: var(--van-primary-color);
  }
  .sec-link { font-size: 13px; }

  /* 应用卡片：通栏固定 4 列（对齐参考稿）；
     minmax(0,…) + 卡片 min-width:0 保证 nowrap 描述收缩为省略号而非撑破栅格 */
  .app-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
  .tile {
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 92px;
    padding: 16px;
    border: 1px solid var(--van-border-color, #ebedf0);
    border-radius: 14px;
    cursor: pointer;
    transition: border-color .15s, box-shadow .15s, transform .15s;
  }
  .tile:hover {
    border-color: var(--van-primary-color);
    box-shadow: 0 6px 18px rgba(25, 137, 250, .12);
    transform: translateY(-2px);
  }
  .tic {
    flex: none;
    width: 46px;
    height: 46px;
    border-radius: 12px;
    font-size: 24px;
    background: rgba(25, 137, 250, .1);
    color: var(--van-primary-color);
  }
  .tinfo { align-items: flex-start; gap: 5px; min-width: 0; }
  .tname {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
    font-weight: 600;
    color: var(--van-text-color, #323233);
  }
  .tdesc {
    display: block;
    width: 100%;
    font-size: 12px;
    line-height: 1.4;
    color: var(--van-text-color-3, #969799);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile.is-selected { border-color: var(--van-primary-color); box-shadow: none; }
  .tile.is-selected .tic { background: var(--van-primary-color); color: #fff; }
  .tile.is-off { opacity: .55; }
  .tile.is-off:hover { border-color: var(--van-border-color, #ebedf0); box-shadow: none; transform: none; }
  .tile.is-off .tic { background: var(--van-background-3, #f2f3f5); color: var(--van-gray-5); }
  .tile.is-beta .tic { background: #fff7e6; color: #ff976a; }

  /* 额度卡（右上角）：提示与按钮分两行，按钮为右下对齐的紧凑胶囊 */
  .quota-card {
    display: flex;
    flex-direction: column;
    padding: 22px 22px 20px;
    border: 1px solid var(--van-border-color, #ebedf0);
    border-radius: 14px;
  }
  .q-label { font-size: 13px; }
  .q-num { margin-top: 10px; font-size: 40px; line-height: 1.1; color: var(--van-primary-color); }
  .q-bottom {
    margin-top: 14px;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    font-size: 12px;
  }
  .q-hint { gap: 5px; }
  .q-go {
    align-self: flex-end;
    padding: 9px 28px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    color: #fff;
    background: var(--van-primary-color);
    cursor: pointer;
    transition: opacity .15s;
  }
  .q-go:hover { opacity: .9; }

  /* 最近任务：单一卡片容器 + 分行 */
  .empty { border: 1px solid var(--van-border-color, #ebedf0); }
  .task-list {
    background: var(--van-background-2, #fff);
    border: 1px solid var(--van-border-color, #ebedf0);
    border-radius: 14px;
    overflow: hidden;
  }
  .task-card {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    border-radius: 0;
    cursor: pointer;
    transition: background .15s;
  }
  .task-card + .task-card { margin-top: 0; border-top: 1px solid var(--van-border-color, #f2f3f5); }
  .task-card:hover { background: rgba(25, 137, 250, .04); }
  .task-top .van-tag { flex: none; }
  .task-ico {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    font-size: 22px;
    background: rgba(25, 137, 250, .1);
    color: var(--van-primary-color);
  }
  .task-ico-img { background: rgba(7, 193, 96, .1); color: #07c160; }
  .task-ico-file { background: var(--van-background-3, #f2f3f5); color: var(--van-gray-5); }
  .task-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
  }
  .task-sub { font-size: 12px; }
}
</style>
