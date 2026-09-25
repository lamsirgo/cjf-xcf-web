<template>
  <van-config-provider :theme="dark ? 'dark' : 'light'">
    <router-view />
  </van-config-provider>
</template>

<script setup lang="ts">
import { ref, provide } from 'vue'

const dark = ref(localStorage.getItem('h5-theme') === 'dark')

function toggleDark(val?: boolean) {
  dark.value = val ?? !dark.value
  localStorage.setItem('h5-theme', dark.value ? 'dark' : 'light')
}

provide('h5-dark', { dark, toggleDark })
</script>
