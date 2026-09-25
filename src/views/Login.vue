<template>
  <div class="auth-page">
    <div class="logo">
      <h2>发票识别助手</h2>
      <p>批量识别 · 自动查重 · 一键导出</p>
    </div>
    <van-form @submit="onSubmit">
      <van-cell-group inset>
        <van-field v-model="mobile" name="mobile" label="手机号" placeholder="请输入手机号"
          :rules="[{ pattern: /^1\d{10}$/, message: '手机号格式错误' }]" />
        <van-field v-model="password" type="password" name="password" label="密码" placeholder="请输入密码"
          :rules="[{ required: true, message: '请输入密码' }]" />
      </van-cell-group>
      <div class="submit-wrap">
        <van-button round block type="primary" native-type="submit" :loading="loading">登 录</van-button>
        <router-link to="/register" class="link">没有账号？立即注册</router-link>
      </div>
    </van-form>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { login } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

const mobile = ref('')
const password = ref('')
const loading = ref(false)
const router = useRouter()
const auth = useAuthStore()

async function onSubmit() {
  loading.value = true
  try {
    const tokens = await login({ mobile: mobile.value, password: password.value })
    auth.setTokens(tokens.access_token, tokens.refresh_token)
    router.replace('/workbench')
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.auth-page { padding-top: 12vh; }
.logo { text-align: center; margin-bottom: 32px; }
.logo h2 { margin: 0 0 8px; color: #1989fa; }
.logo p { margin: 0; color: #969799; font-size: 13px; }
.submit-wrap { margin: 24px 16px; text-align: center; }
.link { display: inline-block; margin-top: 16px; color: #1989fa; font-size: 14px; }
</style>
