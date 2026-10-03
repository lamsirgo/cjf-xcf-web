<template>
  <div class="home-shell">
    <!-- PC 端左侧常驻导航（移动端隐藏，继续用底部 tabbar） -->
    <aside class="pc-side-nav" :class="{ collapsed }">
      <div class="side-logo">
        <span class="logo-text">小财房</span>
        <button
          type="button"
          class="side-toggle"
          :aria-label="collapsed ? '展开导航栏' : '收起导航栏'"
          :title="collapsed ? '展开导航栏' : '收起导航栏'"
          @click="collapsed = !collapsed"
        >
          <van-icon :name="collapsed ? 'arrow-right' : 'arrow-left'" />
        </button>
      </div>
      <router-link
        v-for="m in menus"
        :key="m.path"
        :to="m.path"
        class="side-item"
        :class="{ active: route.path === m.path }"
        :title="m.title"
      >
        <van-icon :name="m.icon" class="side-ico" />
        <span class="side-text">{{ m.title }}</span>
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
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useIsPc } from '@/composables/use-media-query'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const isPc = useIsPc()

// 侧栏折叠状态：单一数据源，localStorage 持久化（刷新/会话间保持）
const SIDE_COLLAPSED_KEY = 'xcf-side-collapsed'
const collapsed = ref(localStorage.getItem(SIDE_COLLAPSED_KEY) === '1')
watch(collapsed, (v) => {
  localStorage.setItem(SIDE_COLLAPSED_KEY, v ? '1' : '0')
})

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
    transition: width 0.25s ease, padding 0.25s ease;
  }
  .side-logo {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 8px 20px;
  }
  .logo-text {
    font-size: 18px;
    font-weight: 700;
    color: var(--van-text-color, #323233);
    white-space: nowrap;
  }
  /* 折叠触发器（品牌行右侧）：无边框图标按钮 */
  .side-toggle {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--van-text-color-3, #969799);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .side-toggle:hover {
    background: var(--van-background-3, #f2f3f5);
    color: var(--van-text-color, #323233);
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
    transition: background 0.15s, padding 0.25s ease;
    white-space: nowrap;
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
    flex: none;
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
    white-space: nowrap;
    overflow: hidden;
  }
  .home-main {
    margin-left: 208px;
    /* 显式拉伸：占满侧栏右侧全部宽度并铺满视口高度 */
    width: calc(100% - 208px);
    min-height: 100vh;
    transition: margin-left 0.25s ease, width 0.25s ease;
  }

  /* ---------- 折叠态：收缩为 64px 图标栏 ---------- */
  .pc-side-nav.collapsed {
    width: 64px;
    padding: 16px 8px;
  }
  .pc-side-nav.collapsed .side-logo {
    justify-content: center;
    padding: 8px 0 20px;
  }
  .pc-side-nav.collapsed .logo-text,
  .pc-side-nav.collapsed .side-text,
  .pc-side-nav.collapsed .side-foot {
    display: none;
  }
  .pc-side-nav.collapsed .side-item {
    justify-content: center;
    gap: 0;
    padding: 10px 0;
  }
  /* 主内容区与侧栏宽度成对联动 */
  .pc-side-nav.collapsed ~ .home-main {
    margin-left: 64px;
    width: calc(100% - 64px);
  }
}
</style>
