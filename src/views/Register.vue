<template>
  <div class="auth-page">
    <van-nav-bar title="注册" left-arrow @click-left="$router.back()" />
    <van-form @submit="onSubmit">
      <van-cell-group inset style="margin-top: 16px">
        <van-field v-model="mobile" label="手机号" placeholder="请输入手机号"
          :rules="[{ pattern: /^1\d{10}$/, message: '手机号格式错误' }]" />
        <van-field v-model="password" type="password" label="密码" placeholder="8-32位，含字母和数字"
          :rules="[{ pattern: /^(?=.*[A-Za-z])(?=.*\d)\S{8,32}$/, message: '密码需8-32位，且同时含字母和数字' }]" />
        <van-field v-model="captchaCode" center label="验证码" placeholder="输入右侧验证码">
          <template #button>
            <img :src="captchaImg" alt="验证码" class="captcha" @click="loadCaptcha" />
          </template>
        </van-field>
      </van-cell-group>
      <div class="submit-wrap">
        <van-button round block type="primary" native-type="submit" :loading="loading">注 册</van-button>
        <router-link to="/login" class="link">已有账号？去登录</router-link>
      </div>
    </van-form>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getCaptcha, register } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'

const mobile = ref('')
const password = ref('')
const captchaCode = ref('')
const captchaId = ref('')
const captchaImg = ref('')
const loading = ref(false)
const router = useRouter()
const auth = useAuthStore()

async function loadCaptcha() {
  const c = await getCaptcha()
  captchaId.value = c.captcha_id
  captchaImg.value = c.image
}

onMounted(loadCaptcha)

async function onSubmit() {
  loading.value = true
  try {
    const tokens = await register({
      mobile: mobile.value,
      password: password.value,
      captcha_id: captchaId.value,
      captcha_code: captchaCode.value,
    })
    auth.setTokens(tokens.access_token, tokens.refresh_token)
    showToast('注册成功')
    router.replace('/workbench')
  } catch {
    loadCaptcha()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.captcha { height: 32px; border-radius: 4px; }
.submit-wrap { margin: 24px 16px; text-align: center; }
.link { display: inline-block; margin-top: 16px; color: var(--van-primary-color); font-size: 14px; }

/* ---------- PC 适配：居中卡片（隐藏导航，由卡片标题表达） ---------- */
@media (min-width: 1024px) {
  .auth-page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--van-background, #f6f7f9);
    padding: 24px 0;
  }
  .auth-page :deep(.van-nav-bar) { display: none; }
  .auth-page :deep(.van-form) {
    width: 400px;
    background: var(--van-background-2, #fff);
    border-radius: 12px;
    padding: 24px 24px 20px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
    box-sizing: border-box;
  }
  .auth-page :deep(.van-cell-group--inset) { margin-left: 0; margin-right: 0; border-radius: 8px; }
  .submit-wrap { margin: 20px 0 0; }
}
</style>
