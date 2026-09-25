<template>
  <div class="auth-page">
    <van-nav-bar title="找回密码" left-arrow @click-left="router.back()" />
    <div class="tip">
      <van-icon name="info-o" />
      验证码将发送至该手机号绑定的邮箱，未绑定邮箱请联系管理员
    </div>
    <van-form @submit="onSubmit">
      <van-cell-group inset>
        <van-field
          v-model="mobile"
          label="手机号"
          placeholder="请输入注册手机号"
          :rules="[{ pattern: /^1\d{10}$/, message: '手机号格式错误' }]"
        />
        <van-field v-model="emailCode" label="邮箱验证码" placeholder="请输入邮箱验证码">
          <template #button>
            <van-button size="small" type="primary" plain :disabled="countdown > 0 || codeSending" @click="onSendCode">
              {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
            </van-button>
          </template>
        </van-field>
        <van-field
          v-model="newPwd"
          type="password"
          label="新密码"
          placeholder="8-32位，含字母和数字"
          :rules="[{ pattern: /^(?=.*[A-Za-z])(?=.*\d)\S{8,32}$/, message: '密码需8-32位，且同时含字母和数字' }]"
        />
      </van-cell-group>
      <div class="submit-wrap">
        <van-button round block type="primary" native-type="submit" :loading="submitLoading">重置密码</van-button>
        <router-link to="/login" class="link">想起密码了？返回登录</router-link>
      </div>
    </van-form>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showSuccessToast, showToast } from 'vant'
import { resetPassword, sendResetCode } from '@/api/auth'

const router = useRouter()
const mobile = ref('')
const emailCode = ref('')
const newPwd = ref('')
const countdown = ref(0)
const codeSending = ref(false)
const submitLoading = ref(false)
let timer: number | null = null

function startCountdown() {
  countdown.value = 60
  timer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0 && timer) {
      window.clearInterval(timer)
      timer = null
    }
  }, 1000)
}

async function onSendCode() {
  if (!/^1\d{10}$/.test(mobile.value)) {
    showToast('请先输入正确的手机号')
    return
  }
  codeSending.value = true
  try {
    await sendResetCode(mobile.value)
    // 后端防枚举统一文案：无论是否注册/绑邮箱都提示已发送
    showSuccessToast('验证码已发送，请查收绑定邮箱')
    startCountdown()
  } catch {
    /* 拦截器已提示（如发送太频繁） */
  } finally {
    codeSending.value = false
  }
}

async function onSubmit() {
  submitLoading.value = true
  try {
    await resetPassword({
      mobile: mobile.value,
      email_code: emailCode.value,
      new_password: newPwd.value,
    })
    showSuccessToast('密码重置成功，请使用新密码登录')
    router.replace({ path: '/login', query: { mobile: mobile.value } })
  } catch {
    /* 拦截器已提示 */
  } finally {
    submitLoading.value = false
  }
}

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<style scoped>
.tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 16px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--van-background-2, #f2f3f5);
  color: var(--van-text-color-2, #969799);
  font-size: 12px;
  line-height: 1.5;
}
.submit-wrap { margin: 24px 16px; text-align: center; }
.link { display: inline-block; margin-top: 16px; color: #1989fa; font-size: 14px; }
</style>
