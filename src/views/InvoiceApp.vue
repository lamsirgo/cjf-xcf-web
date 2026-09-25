<template>
  <div class="page">
    <van-nav-bar title="发票识别" left-arrow @click-left="router.back()" />

    <div class="upload-card">
      <van-uploader
        :after-read="onAfterRead"
        :max-count="20"
        :deletable="false"
        :disabled="uploading"
        accept=".zip,.rar,.pdf,.jpg,.jpeg,.png"
      >
        <div class="upload-inner">
          <van-icon name="plus" class="u-plus" />
          <span class="u-title">选择压缩包 / 发票文件</span>
          <span class="u-cap">支持 zip/rar/pdf/jpg/png，单包 ≤100MB，自动查重</span>
        </div>
      </van-uploader>
    </div>

    <van-cell-group inset class="menu">
      <van-cell title="解析任务" is-link :border="false" @click="router.push('/tasks')">
        <template #right-icon>
          <span v-if="activeCount > 0" class="badge">{{ activeCount }}</span>
          <van-icon name="arrow" class="arrow" />
        </template>
      </van-cell>
      <van-cell title="发票库" is-link @click="router.push('/app/invoice/list')" />
      <van-cell title="导出记录" is-link @click="router.push({ path: '/profile', query: { open: 'export' } })" />
    </van-cell-group>

    <div class="tips">
      <p class="tips-title">温馨提示</p>
      <p>· 识别结果仅供参考，以税务机关查验为准</p>
      <p>· 重复上传仍会触发识别并扣减额度</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showLoadingToast, showToast } from 'vant'
import { listPackages, uploadPackages } from '@/api/packages'

const router = useRouter()
const activeCount = ref(0)
const uploading = ref(false)

const ALLOWED_EXT = ['zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png']
const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_TOTAL_SIZE = 100 * 1024 * 1024

async function onAfterRead(items: unknown) {
  if (uploading.value) return
  const arr = Array.isArray(items) ? items : [items]
  const fs = arr.map((i) => (i as { file: File }).file).filter(Boolean)
  if (fs.length === 0) return

  // 客户端预检（accept 可被绕过，这里按扩展名/大小再校验一次，服务端仍为最终防线）
  const hasArchive = fs.some((f) => /\.(zip|rar)$/i.test(f.name))
  if (hasArchive && fs.length > 1) {
    showToast('压缩包请单独上传')
    return
  }
  for (const f of fs) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXT.includes(ext)) {
      showToast(`不支持的文件类型：${f.name}`)
      return
    }
    if (!hasArchive && f.size > MAX_FILE_SIZE) {
      showToast(`单个文件不能超过 20MB：${f.name}`)
      return
    }
  }
  const total = fs.reduce((sum, f) => sum + f.size, 0)
  if (total > MAX_TOTAL_SIZE) {
    showToast('文件总大小不能超过 100MB')
    return
  }

  uploading.value = true
  const toast = showLoadingToast({ message: '上传中...', forbidClick: true, duration: 0 })
  try {
    const res = await uploadPackages(fs)
    showToast(`已提交 ${res.total_files} 个文件`)
    router.push('/tasks')
  } catch { /* 拦截器已提示 */ } finally {
    toast.close()
    uploading.value = false
  }
}

onMounted(async () => {
  const data = await listPackages(1).catch(() => null)
  activeCount.value = data?.list.filter((p) => p.status === 0 || p.status === 1).length ?? 0
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--van-background, #f6f7f9);
}
.upload-card {
  margin: 12px;
  border: 1px dashed var(--van-border-color, #dcdee0);
  border-radius: 12px;
  background: var(--van-background-2, #fff);
  overflow: hidden;
}
/* van-uploader 默认为 inline-block，会使上传卡收缩，改为整行宽度并居中 */
.upload-card :deep(.van-uploader) {
  display: block;
  width: 100%;
}
.upload-card :deep(.van-uploader__wrapper) {
  display: block;
  width: 100%;
  text-align: center;
}
.upload-inner {
  width: 100%;
  padding: 28px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.u-plus { font-size: 26px; color: #c8c9cc; }
.u-title { font-size: 15px; font-weight: 500; color: var(--van-text-color, #323233); }
.u-cap { font-size: 12px; color: var(--van-text-color-3, #969799); text-align: center; }

.menu { margin-top: 0; }
.badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-right: 4px;
  border-radius: 999px;
  background: #ee0a24;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.arrow { color: #c8c9cc; }

.tips {
  margin: 16px 16px 24px;
  font-size: 12px;
  color: #969799;
}
.tips-title { font-size: 13px; font-weight: 500; color: #646566; margin-bottom: 8px; }
.tips p { margin: 4px 0; }
</style>
