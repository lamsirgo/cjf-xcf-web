import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/Login.vue'), meta: { title: '登录' } },
    { path: '/register', component: () => import('@/views/Register.vue'), meta: { title: '注册' } },
    { path: '/forgot', component: () => import('@/views/ForgotPwd.vue'), meta: { title: '找回密码' } },
    {
      path: '/',
      component: () => import('@/views/Home.vue'),
      children: [
        { path: '', redirect: '/workbench' },
        { path: 'workbench', component: () => import('@/views/Workbench.vue'), meta: { title: '工作台' } },
        { path: 'tasks', component: () => import('@/views/Tasks.vue'), meta: { title: '任务' } },
        { path: 'profile', component: () => import('@/views/Profile.vue'), meta: { title: '我的' } },
      ],
    },
    { path: '/notifications', component: () => import('@/views/Notifications.vue'), meta: { title: '消息通知' } },
    // 子应用：发票识别（独立页面栈，不显示平台底部导航）
    { path: '/app/invoice', component: () => import('@/views/InvoiceApp.vue'), meta: { title: '发票识别' } },
    { path: '/app/invoice/list', component: () => import('@/views/Invoices.vue'), meta: { title: '发票库' } },
    { path: '/app/invoice/:id', component: () => import('@/views/InvoiceDetail.vue'), meta: { title: '发票详情' } },
  ],
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  const WHITE_LIST = ['/login', '/register', '/forgot']
  if (!auth.isLoggedIn && !WHITE_LIST.includes(to.path)) {
    return '/login'
  }
  document.title = (to.meta.title as string) || '智能服务平台'
})

export default router
