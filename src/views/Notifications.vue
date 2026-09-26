<template>
  <div class="page">
    <van-nav-bar title="消息通知" left-arrow @click-left="router.back()">
      <template #right>
        <span v-if="unreadCount > 0" class="read-all" @click="onReadAll">全部已读</span>
      </template>
    </van-nav-bar>

    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <van-empty v-if="!loading && list.length === 0" description="暂无通知" />
      <van-list v-else v-model:loading="loading" :finished="true" class="list">
        <div
          v-for="n in list"
          :key="n.id"
          class="notice-card"
          :class="{ unread: !n.is_read }"
        >
          <div class="n-head">
            <span class="n-title">{{ n.title }}</span>
            <span v-if="!n.is_read" class="dot" />
          </div>
          <p class="n-content">{{ n.content }}</p>
          <p class="n-time">{{ fmtTime(n.created_at) }}</p>
        </div>
      </van-list>
    </van-pull-refresh>
  </div>
</template>

<script setup lang="ts">
import { onActivated, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { listNotifications, readAllNotifications, type NotificationItem } from '@/api/notifications'

const router = useRouter()

const list = ref<NotificationItem[]>([])
const loading = ref(true)
const refreshing = ref(false)

const unreadCount = computed(() => list.value.filter((n) => !n.is_read).length)

async function load() {
  loading.value = true
  try {
    const data = await listNotifications()
    list.value = data.list
  } catch {
    /* ignore */
  }
  loading.value = false
}

async function onRefresh() {
  await load()
  refreshing.value = false
}

async function onReadAll() {
  try {
    await readAllNotifications()
    list.value.forEach((n) => (n.is_read = 1))
  } catch {
    /* ignore */
  }
}

function fmtTime(s: string | null) {
  if (!s) return ''
  return s.slice(0, 16).replace('T', ' ')
}

onActivated(load)
</script>

<style scoped>
.page { min-height: 100vh; background: var(--van-background, #f6f7f9); }
.read-all { font-size: 14px; color: #1989fa; }
.list { padding: 10px 0 72px; }
.notice-card {
  margin: 8px 12px;
  padding: 12px;
  background: var(--van-background-2, #fff);
  border-radius: 8px;
}
.notice-card.unread { border-left: 3px solid #1989fa; }
.n-head { display: flex; justify-content: space-between; align-items: center; }
.n-title { font-weight: 600; font-size: 14px; color: var(--van-text-color, #323233); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ee0a24; }
.n-content {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--van-text-color-2, #646566);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.n-time { margin: 6px 0 0; font-size: 12px; color: var(--van-text-color-3, #969799); }
</style>
