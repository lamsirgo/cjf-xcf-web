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
      <van-list v-model:loading="loading" :finished="finished" finished-text="没有更多了" @load="onLoad">
        <div v-for="p in list" :key="p.id" class="pkg-card">
          <div class="pkg-head" @click="toggle(p)">
            <div class="pkg-name">
              <span class="fname">{{ p.filename }}</span>
              <van-tag :type="tagType(p.status)">{{ p.status_text }}</van-tag>
            </div>
            <div class="pkg-sub">
              {{ p.success_files }}成功 / {{ p.failed_files }}失败 / 共{{ p.total_files }}张
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
            <van-button size="small" plain type="primary" @click="onRetry(p)">失败重试</van-button>
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
const finished = ref(false)
const refreshing = ref(false)
const initialLoading = ref(true)
const page = ref(1)
const expanded = ref<number | null>(null)
const files = ref<{ id: number; orig_path: string; status_text: string; fail_reason: string }[]>([])
// 当前仅发票识别一个应用，全部/发票识别数据相同
const appFilter = ref<'all' | 'invoice'>('all')
let es: EventSource | null = null

async function load() {
  const currentPage = page.value
  const data = await listPackages(currentPage)
  if (currentPage === 1) list.value = data.list
  else list.value.push(...data.list)
  finished.value = list.value.length >= data.total
}

async function onLoad() {
  await load()
  page.value++
  loading.value = false
  initialLoading.value = false
  if (finished.value) return
}

async function onRefresh() {
  page.value = 1
  finished.value = false
  loading.value = true
  await load()
  loading.value = false
  refreshing.value = false
  initialLoading.value = false
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
  const data = await listPackageFiles(p.id)
  files.value = data.list
  expanded.value = p.id
}

async function onRetry(p: PackageItem) {
  await retryPackage(p.id)
  showToast('已重新排队')
  refreshingLoad()
}

function listen(packages: PackageItem[]) {
  es?.close()
  const active = packages.find((p) => p.status === 0 || p.status === 1)
  if (!active) return
  es = new EventSource(sseUrl(active.id, auth.accessToken))
  es.onmessage = (ev) => {
    const obj = JSON.parse(ev.data)
    const idx = list.value.findIndex((x) => x.id === obj.package_id)
    if (idx >= 0 && list.value[idx].status <= 1) {
      if (obj.type === 'progress') {
        list.value[idx].progress = Math.round((obj.done / Math.max(obj.total, 1)) * 100)
        list.value[idx].success_files = obj.success
        list.value[idx].failed_files = obj.failed
      } else {
        refreshingLoad()
      }
    }
  }
}

onActivated(async () => {
  await auth.fetchMe().catch(() => {})
  await refreshingLoad()
  listen(list.value)
})
onDeactivated(() => es?.close())
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
  background: #fff;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.chip {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 999px;
  background: #f2f3f5;
  color: #646566;
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
.pkg-card { background: #fff; border-radius: 8px; margin: 10px; padding: 12px; }
.pkg-name { display: flex; justify-content: space-between; align-items: center; }
.fname { font-weight: 600; word-break: break-all; }
.pkg-sub { color: #969799; font-size: 12px; margin: 6px 0; }
.pkg-detail { color: #1989fa; font-size: 11px; margin-top: 2px; }
.skeleton-card { padding: 16px 12px; }
.pkg-actions { margin-top: 8px; text-align: right; }
.pkg-files { border-top: 1px dashed #ebedf0; margin-top: 8px; padding-top: 8px; }
.file-row { font-size: 12px; padding: 4px 0; }
.f-name { margin-right: 8px; }
.f-err { color: #ee0a24; margin-top: 2px; word-break: break-all; }
</style>
