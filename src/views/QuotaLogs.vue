<template>
  <div class="page">
    <van-nav-bar title="额度流水" left-arrow @click-left="$router.back()" />

    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <van-list
        v-model:loading="loading"
        v-model:error="error"
        :finished="finished"
        finished-text="没有更多了"
        error-text="加载失败，点击重试"
        @load="onLoad"
      >
        <div v-for="r in list" :key="r.id" class="log-card">
          <div class="log-top">
            <span class="log-type">
              <van-tag plain :type="r.change > 0 ? 'success' : r.change < 0 ? 'danger' : 'primary'">
                {{ r.change_type_text }}
              </van-tag>
            </span>
            <span class="log-change" :class="r.change > 0 ? 'plus' : r.change < 0 ? 'minus' : ''">
              {{ r.change > 0 ? '+' : '' }}{{ r.change }}
            </span>
          </div>
          <div v-if="r.remark" class="log-remark">{{ r.remark }}</div>
          <div class="log-meta">
            <span>余额 {{ r.before }} → {{ r.after }}</span>
            <span>{{ r.created_at?.slice(0, 19).replace('T', ' ') }}</span>
          </div>
        </div>
        <van-empty v-if="finished && !list.length" description="暂无额度流水" />
      </van-list>
    </van-pull-refresh>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { listQuotaLogs, type QuotaLogItem } from '@/api/user'

const list = ref<QuotaLogItem[]>([])
const loading = ref(false)
const finished = ref(false)
const refreshing = ref(false)
const error = ref(false)
const page = ref(1)
const PAGE_SIZE = 20

async function onLoad() {
  try {
    const data = await listQuotaLogs({ page: page.value, page_size: PAGE_SIZE })
    list.value.push(...data.list)
    loading.value = false
    refreshing.value = false
    error.value = false
    if (list.value.length >= data.total) {
      finished.value = true
    } else {
      page.value += 1
    }
  } catch {
    // 失败时终止 loading 并置 error（van-list 展示"点击重试"），否则会一直重试
    loading.value = false
    refreshing.value = false
    error.value = true
  }
}

function onRefresh() {
  finished.value = false
  error.value = false
  page.value = 1
  list.value = []
  loading.value = true
  onLoad()
}
</script>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--van-background, #f6f7f9);
}
.log-card {
  margin: 10px 16px;
  padding: 12px;
  background: var(--van-background-2, #fff);
  border-radius: 10px;
}
.log-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.log-change {
  font-size: 17px;
  font-weight: 700;
  color: var(--van-text-color-2, #646566);
}
.log-change.plus {
  color: var(--van-success-color);
}
.log-change.minus {
  color: var(--van-danger-color);
}
.log-remark {
  margin-top: 8px;
  font-size: 13px;
  color: var(--van-text-color, #323233);
}
.log-meta {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}

/* ---------- PC 适配：内容限宽居中 ---------- */
@media (min-width: 1024px) {
  .page { max-width: 720px; margin: 0 auto; }
  .log-card { margin-left: 0; margin-right: 0; }
}
</style>
