<template>
  <div class="page">
    <div class="top-bar">
      <van-nav-bar title="任务" />
      <div class="app-chips">
        <span class="chip" :class="{ active: appFilter === 'all' }" @click="appFilter = 'all'">全部</span>
        <span class="chip" :class="{ active: appFilter === 'invoice' }" @click="appFilter = 'invoice'">发票识别</span>
        <span class="chip is-off">发票查验</span>
        <span class="chip is-off">报销管理</span>
      </div>
    </div>

    <van-pull-refresh v-model="refreshing" class="task-scroll" @refresh="onRefresh">
      <!-- 首次加载骨架屏 -->
      <template v-if="initialLoading">
        <div v-for="i in 3" :key="i" class="pkg-card skeleton-card">
          <van-skeleton title :row="2" animated />
        </div>
      </template>
      <!-- 空状态：首屏加载完成且无数据（van-list 的“没有更多了”此时无意义） -->
      <van-empty
        v-if="!initialLoading && finished && list.length === 0"
        description="暂无任务，去上传发票试试吧"
      />
      <van-list
        v-else
        v-model:loading="loading"
        v-model:error="loadError"
        :finished="finished"
        finished-text="没有更多了"
        error-text="加载失败，点击重试"
        @load="onLoad"
      >
        <div v-for="p in list" :key="p.id" class="pkg-card">
          <div class="pkg-head" @click="toggle(p)">
            <div class="pkg-name">
              <span class="fname">{{ p.filename }}</span>
              <van-tag :type="tagType(p.status)">{{ p.status_text }}</van-tag>
            </div>
            <div class="pkg-sub">
              {{ p.success_files }}成功 / {{ p.failed_files }}失败<template v-if="p.duplicate_files"> / {{ p.duplicate_files }}重复</template> / 共{{ p.total_files }}张
              <span v-if="p.queue_pos">· 排队第{{ p.queue_pos }}位</span>
            </div>
            <van-progress v-if="p.status === 0 || p.status === 1" :percentage="p.progress" />
            <div v-if="p.status === 1 && p.done_files !== null" class="pkg-detail">
              已解析 {{ p.done_files }} / {{ p.total_files }}
            </div>
          </div>
          <div v-if="expanded === p.id" class="pkg-files">
            <div v-for="f in files" :key="f.id" class="file-row">
              <span class="f-name">{{ f.orig_path }}</span>
              <van-tag :type="f.status_text === '成功' ? 'success' : f.status_text === '失败' ? 'danger' : 'primary'">
                {{ f.status_text }}
              </van-tag>
              <div v-if="f.fail_reason" class="f-err">{{ f.fail_reason }}</div>
            </div>
          </div>
          <div v-if="p.status === 3 || p.status === 4" class="pkg-actions">
            <van-button
              size="small"
              plain
              type="primary"
              :loading="retryingId === p.id"
              @click="onRetry(p)"
            >
              失败重试
            </van-button>
          </div>
        </div>
      </van-list>
    </van-pull-refresh>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onDeactivated, ref } from 'vue'
import { showToast } from 'vant'
import { listPackages, listPackageFiles, retryPackage, sseUrl, type PackageItem } from '@/api/packages'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const list = ref<PackageItem[]>([])
const loading = ref(false)
const loadError = ref(false)
const finished = ref(false)
const refreshing = ref(false)
const initialLoading = ref(true)
const page = ref(1)
const expanded = ref<number | null>(null)
const files = ref<{ id: number; orig_path: string; status_text: string; fail_reason: string }[]>([])
// 当前仅发票识别一个应用，全部/发票识别数据相同
const appFilter = ref<'all' | 'invoice'>('all')
const retryingId = ref<number | null>(null)

// 防止 van-list 自动加载与手动刷新/翻页并发，过期响应直接丢弃
let reqSeq = 0
async function load() {
  const seq = ++reqSeq
  const currentPage = page.value
  const data = await listPackages(currentPage)
  if (seq !== reqSeq) return
  if (currentPage === 1) list.value = data.list
  else list.value.push(...data.list)
  finished.value = list.value.length >= data.total
}

async function onLoad() {
  try {
    await load()
    page.value++
    loadError.value = false
  } catch {
    // 进入 van-list 错误态，点击“加载失败，点击重试”会重新触发 onLoad
    loadError.value = true
  } finally {
    loading.value = false
    initialLoading.value = false
    // 首屏由 van-list 自动加载（onActivated 不再手动刷新），加载完后启动 SSE 选包
    if (pageActive) startListening()
  }
}

async function onRefresh() {
  page.value = 1
  finished.value = false
  loading.value = true
  try {
    await load()
  } catch {
    showToast('刷新失败，请稍后再试')
  } finally {
    loading.value = false
    refreshing.value = false
    initialLoading.value = false
    // 刷新后可能出现新的排队包或原监听包已终态，重新选包监听
    startListening()
  }
}

const refreshingLoad = onRefresh

function tagType(status: number) {
  return { 0: 'primary', 1: 'warning', 2: 'success', 3: 'warning', 4: 'danger' }[status] as any
}

async function toggle(p: PackageItem) {
  if (expanded.value === p.id) {
    expanded.value = null
    return
  }
  expanded.value = p.id
  files.value = []
  const data = await listPackageFiles(p.id)
  // 防止快速连续展开不同包时，旧请求返回覆盖当前展开包的文件列表
  if (expanded.value !== p.id) return
  files.value = data.list
}

async function onRetry(p: PackageItem) {
  if (retryingId.value !== null) return
  retryingId.value = p.id
  try {
    await retryPackage(p.id)
    showToast('已重新排队')
    await refreshingLoad()
    startListening()
  } catch {
    /* 拦截器已提示 */
  } finally {
    retryingId.value = null
  }
}

/* ============ SSE 实时进度（短票据 + 断线重签重连） ============
 * 后端 SSE 最长 10 分钟主动断流，票据 TTL 15 分钟：
 * - 收到终态消息：主动关闭，刷新后接续监听下一个进行中包
 * - onerror（断流/票据过期/网络抖动）：关闭浏览器自带重连，重新换取票据后
 *   指数退避重连（1s→2s→4s→8s→16s→30s，最多 6 次），避免死票据无限重连
 */
let es: EventSource | null = null
let listeningPkgId: number | null = null
let pageActive = false
let reconnectAttempts = 0
let reconnectTimer: number | null = null
const MAX_RECONNECT = 6

function teardownEs() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  es?.close()
  es = null
}

function startListening() {
  if (!pageActive) return
  teardownEs()
  reconnectAttempts = 0
  const active = list.value.find((p) => p.status === 0 || p.status === 1)
  if (!active) {
    listeningPkgId = null
    return
  }
  listeningPkgId = active.id
  void connectTo(active.id)
}

async function connectTo(pkgId: number) {
  if (!pageActive || listeningPkgId !== pkgId) return
  let url: string
  try {
    url = await sseUrl(pkgId)
  } catch {
    // 取票失败（登录失效等）：拦截器已处理，退避后再试
    scheduleReconnect(pkgId)
    return
  }
  // await 期间页面可能已切走或已切换监听别的包
  if (!pageActive || listeningPkgId !== pkgId) return

  const source = new EventSource(url)
  es = source
  reconnectAttempts = 0

  source.onmessage = (ev) => {
    let obj: {
      type: string
      package_id: number
      done?: number
      total?: number
      success?: number
      failed?: number
      duplicate?: number
    }
    try {
      obj = JSON.parse(ev.data)
    } catch {
      return
    }
    const idx = list.value.findIndex((x) => x.id === obj.package_id)
    if (idx < 0) return
    if (obj.type === 'progress') {
      if (list.value[idx].status <= 1) {
        list.value[idx].progress = Math.round((obj.done! / Math.max(obj.total!, 1)) * 100)
        list.value[idx].success_files = obj.success!
        list.value[idx].failed_files = obj.failed!
        list.value[idx].duplicate_files = obj.duplicate ?? 0
      }
    } else {
      // finished：任务终态，主动关闭，刷新后监听下一个进行中包
      teardownEs()
      listeningPkgId = null
      void (async () => {
        await refreshingLoad()
        startListening()
      })()
    }
  }

  source.onerror = () => {
    // 阻止浏览器对旧 URL 的默认自动重连（票据可能已失效），统一自己重签
    teardownEs()
    if (pageActive && listeningPkgId === pkgId) scheduleReconnect(pkgId)
  }
}

function scheduleReconnect(pkgId: number) {
  reconnectAttempts += 1
  if (reconnectAttempts > MAX_RECONNECT) {
    // 放弃本轮，等下次页面激活/手动刷新再重新监听
    listeningPkgId = null
    return
  }
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30000)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    if (!pageActive || listeningPkgId !== pkgId) return
    // 重连前刷新列表：若包已终态（finished 消息丢失），自动切到下一个进行中包
    void (async () => {
      await refreshingLoad().catch(() => {})
      const stillActive = list.value.some((p) => p.id === pkgId && (p.status === 0 || p.status === 1))
      if (!pageActive) return
      if (stillActive) void connectTo(pkgId)
      else startListening()
    })()
  }, delay)
}

// 首次挂载时 van-list 已自动触发首屏加载，此处不再手动刷新，避免首屏重复请求
let firstActivate = true
onActivated(async () => {
  pageActive = true
  await auth.fetchMe().catch(() => {})
  if (firstActivate) {
    firstActivate = false
  } else {
    await refreshingLoad()
    startListening()
  }
})
onDeactivated(() => {
  pageActive = false
  listeningPkgId = null
  teardownEs()
})
</script>

<style scoped>
.page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
.top-bar {
  flex-shrink: 0;
}
.app-chips {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: var(--van-background-2, #fff);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.chip {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--van-background-3, #f2f3f5);
  color: var(--van-text-color-2, #646566);
  font-size: 12px;
}
.chip.active { background: #ecf5ff; color: #1989fa; font-weight: 500; }
.chip.is-off { opacity: .5; }
.task-scroll {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 60px;
  box-sizing: border-box;
}
.pkg-card { background: var(--van-background-2, #fff); border-radius: 8px; margin: 10px; padding: 12px; }
.pkg-name { display: flex; justify-content: space-between; align-items: center; }
.fname { font-weight: 600; word-break: break-all; }
.pkg-sub { color: var(--van-text-color-3, #969799); font-size: 12px; margin: 6px 0; }
.pkg-detail { color: #1989fa; font-size: 11px; margin-top: 2px; }
.skeleton-card { padding: 16px 12px; }
.pkg-actions { margin-top: 8px; text-align: right; }
.pkg-files { border-top: 1px dashed var(--van-border-color, #ebedf0); margin-top: 8px; padding-top: 8px; }
.file-row { font-size: 12px; padding: 4px 0; }
.f-name { margin-right: 8px; }
.f-err { color: #ee0a24; margin-top: 2px; word-break: break-all; }
</style>
