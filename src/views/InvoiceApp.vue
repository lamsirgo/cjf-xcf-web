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

    <div v-if="uploading" class="upload-panel">
      <div class="up-head">
        <span class="up-title">{{ phase }}</span>
        <span class="up-size">{{ humanSize(progress.loaded) }} / {{ humanSize(progress.total) }}</span>
      </div>
      <van-progress :percentage="progress.percent" stroke-color="var(--van-primary-color)" />
      <div class="up-names">{{ fileNames }}</div>
      <div class="up-actions">
        <van-button size="small" plain type="danger" @click="onCancel">取消上传（可稍后断点续传）</van-button>
      </div>
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
import { showSuccessToast, showToast } from 'vant'
import { listPackages, uploadPackagesChunked } from '@/api/packages'

const router = useRouter()
const activeCount = ref(0)
const uploading = ref(false)
const phase = ref('')
const fileNames = ref('')
const progress = ref({ loaded: 0, total: 0, percent: 0 })

const ALLOWED_EXT = ['zip', 'rar', 'pdf', 'jpg', 'jpeg', 'png']
const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_TOTAL_SIZE = 100 * 1024 * 1024

let abortController: AbortController | null = null

function humanSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}

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
  phase.value = '校验文件指纹...'
  fileNames.value = fs.map((f) => f.name).join('、')
  progress.value = { loaded: 0, total, percent: 0 }
  abortController = new AbortController()
  try {
    const res = await uploadPackagesChunked(
      fs,
      (p) => {
        phase.value = '上传中...'
        progress.value = p
      },
      abortController.signal,
    )
    showSuccessToast(`已提交 ${res.total_files} 个文件`)
    router.push('/tasks')
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') {
      showToast('已取消，再次选择相同文件可断点续传')
    } else if (progress.value.percent > 0) {
      showToast('上传中断，再次选择相同文件可断点续传')
    }
    /* 其他错误拦截器已提示 */
  } finally {
    uploading.value = false
    abortController = null
  }
}

function onCancel() {
  abortController?.abort()
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

.upload-panel {
  margin: 0 12px 12px;
  padding: 14px;
  border: 1px solid var(--van-border-color, #dcdee0);
  border-radius: 12px;
  background: var(--van-background-2, #fff);
}
.up-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.up-head .up-title { font-size: 14px; font-weight: 500; color: var(--van-text-color, #323233); }
.up-size { font-size: 12px; color: var(--van-text-color-3, #969799); }
.up-names {
  margin-top: 10px;
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
  word-break: break-all;
}
.up-actions { margin-top: 12px; text-align: right; }
.upload-inner {
  width: 100%;
  padding: 28px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.u-plus { font-size: 26px; color: var(--van-gray-5); }
.u-title { font-size: 15px; font-weight: 500; color: var(--van-text-color, #323233); }
.u-cap { font-size: 12px; color: var(--van-text-color-3, #969799); text-align: center; }

.menu { margin-top: 0; }
.badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-right: 4px;
  border-radius: 999px;
  background: var(--van-danger-color);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.arrow { color: var(--van-gray-5); }

.tips {
  margin: 16px 16px 24px;
  font-size: 12px;
  color: var(--van-gray-6);
}
.tips-title { font-size: 13px; font-weight: 500; color: var(--van-gray-7); margin-bottom: 8px; }
.tips p { margin: 4px 0; }
</style>
