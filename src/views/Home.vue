<template>
  <router-view v-slot="{ Component }">
    <keep-alive>
      <component :is="Component" />
    </keep-alive>
  </router-view>
  <van-tabbar route>
    <van-tabbar-item to="/workbench" icon="apps-o">工作台</van-tabbar-item>
    <van-tabbar-item to="/tasks" icon="orders-o">任务</van-tabbar-item>
    <van-tabbar-item to="/profile" icon="user-o">我的</van-tabbar-item>
  </van-tabbar>
</template>
