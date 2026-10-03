<template>
  <div class="home-shell">
    <!-- PC 端左侧常驻导航（移动端隐藏，继续用底部 tabbar） -->
    <aside class="pc-side-nav">
      <div class="side-logo">小财房</div>
      <router-link
        v-for="m in menus"
        :key="m.path"
        :to="m.path"
        class="side-item"
        :class="{ active: route.path === m.path }"
      >
        <van-icon :name="m.icon" class="side-ico" />
        <span>{{ m.title }}</span>
      </router-link>
      <div class="side-foot">
        <div class="side-user">{{ maskedMobile }}</div>
      </div>
    </aside>

    <div class="home-main">
      <router-view v-slot="{ Component }">
        <keep-alive>
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </div>

    <van-tabbar v-if="!isPc" route>
      <van-tabbar-item to="/workbench" icon="apps-o">工作台</van-tabbar-item>
      <van-tabbar-item to="/tasks" icon="orders-o">任务</van-tabbar-item>
      <van-tabbar-item to="/profile" icon="user-o">我的</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useIsPc } from '@/composables/use-media-query'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const isPc = useIsPc()

const menus = [
  { path: '/workbench', icon: 'apps-o', title: '工作台' },
  { path: '/tasks', icon: 'orders-o', title: '任务' },
  { path: '/profile', icon: 'user-o', title: '我的' },
]

const maskedMobile = computed(() => {
  const m = auth.user?.mobile || ''
  return m.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
})
</script>

<style scoped>
@media (min-width: 1024px) {
  .pc-side-nav {
    display: flex;
    flex-direction: column;
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    width: 208px;
    z-index: 10;
    padding: 16px 12px;
    background: var(--van-background-2, #fff);
    border-right: 1px solid var(--van-border-color, #ebedf0);
    box-sizing: border-box;
  }
  .side-logo {
    font-size: 18px;
    font-weight: 700;
    color: var(--van-text-color, #323233);
    padding: 8px 12px 20px;
  }
  .side-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 14px;
    color: var(--van-text-color-2, #646566);
    text-decoration: none;
    margin-bottom: 4px;
    transition: background 0.15s;
  }
  .side-item:hover {
    background: var(--van-background-3, #f2f3f5);
  }
  .side-item.active {
    background: #ecf5ff;
    color: var(--van-primary-color);
    font-weight: 500;
  }
  .side-ico {
    font-size: 18px;
  }
  .side-foot {
    margin-top: auto;
    padding: 10px 12px;
    border-top: 1px solid var(--van-border-color, #ebedf0);
  }
  .side-user {
    font-size: 12px;
    color: var(--van-text-color-3, #969799);
  }
  .home-main {
    margin-left: 208px;
  }
}
</style>
