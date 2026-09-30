<template>
  <van-popup
    :show="show"
    @update:show="emit('update:show', $event)"
    position="bottom"
    round
    closeable
    :style="{ maxHeight: '78%' }"
  >
    <div class="changelog">
      <div class="cl-title">更新日志</div>

      <div v-for="entry in entries" :key="entry.version" class="cl-entry">
        <div class="cl-version">
          <b>{{ entry.version }}</b>
          <span>{{ entry.date }}</span>
        </div>

        <div v-if="entry.add.length" class="cl-group">
          <van-tag type="success" plain>新增</van-tag>
          <ul>
            <li v-for="(t, i) in entry.add" :key="i">{{ t }}</li>
          </ul>
        </div>
        <div v-if="entry.optimize.length" class="cl-group">
          <van-tag type="primary" plain>优化</van-tag>
          <ul>
            <li v-for="(t, i) in entry.optimize" :key="i">{{ t }}</li>
          </ul>
        </div>
        <div v-if="entry.fix.length" class="cl-group">
          <van-tag type="danger" plain>修复</van-tag>
          <ul>
            <li v-for="(t, i) in entry.fix" :key="i">{{ t }}</li>
          </ul>
        </div>
      </div>
    </div>
  </van-popup>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'

interface ChangelogEntry {
  version: string
  date: string
  add: string[]
  optimize: string[]
  fix: string[]
}

const CURRENT_VERSION = 'v1.2.0'
const READ_KEY = 'print_changelog_read'

const entries: ChangelogEntry[] = [
  {
    version: 'v1.2.0',
    date: '2026-09-30',
    add: [
      '纸张规格：新增 A5 / B5 与自定义尺寸（50~500mm 任意设定）',
      '打印校准：水平 / 垂直偏移微调，可打印带网格的校准测试页，解决套打错位',
      '文件夹批量导入：一次选择整个文件夹，自动筛选其中的票据文件',
      '系统分享：合并 PDF 可直接分享到微信、邮件等应用',
    ],
    optimize: [
      '预览虚拟化：仅绘制可视区域附近页面，大量票据时滚动更流畅、占用内存显著降低',
      '识别加速：多 Worker 并行扫描，失败自动重试',
      '导出体验：Chromium 浏览器支持选择保存位置',
      '草稿存储升级为 OPFS，大文件存取更稳定（环境不支持时自动回退）',
      '本地数据支持分级清理：清空全部 / 仅清识别结果 / 仅恢复默认设置',
    ],
    fix: [],
  },
  {
    version: 'v1.1.0',
    date: '2026-09-30',
    add: [
      '发票二维码识别：jsQR + zxing 双引擎逐页扫描，自动解析号码、金额、日期',
      '一键去重：重复发票自动标记（不删除文件），支持重复详情与逐条撤销误判',
      '发票统计：已识别 / 部分识别 / 未识别分类，金额合计与去重金额对比',
      '人工补录：未识别或识别异常的票据可手工补录，结果参与去重与统计',
      '统计结果支持一键复制、导出 CSV 文件',
    ],
    optimize: ['识别与渲染均在 Worker 中执行，页面不卡顿', '识别结果随草稿自动保存在本地，恢复后无需重新扫描'],
    fix: [],
  },
  {
    version: 'v1.0.0',
    date: '2026-09-29',
    add: [
      '首次发布：PDF / PNG / JPG 票据批量导入与 PDF 逐页拆分',
      '单页 / 双页 / 四页预设与自定义版式，横竖版与页边距可调',
      '序号标记、虚线 / 角部裁切标记、同票双联打印',
      '高清预览与导出当前页 / 合并导出 PDF，票据全程本地处理',
    ],
    optimize: [],
    fix: [],
  },
]

defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
}>()

function readVersion(): string {
  try {
    return localStorage.getItem(READ_KEY) || ''
  } catch {
    return ''
  }
}

function markRead() {
  try {
    localStorage.setItem(READ_KEY, CURRENT_VERSION)
  } catch {
    /* storage unavailable */
  }
}

// 首次打开新版本自动弹出
onMounted(() => {
  if (readVersion() !== CURRENT_VERSION) {
    emit('update:show', true)
    markRead()
  }
})
</script>

<style scoped>
.changelog {
  padding: 16px 16px 24px;
}
.cl-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--van-text-color, #323233);
  margin-bottom: 12px;
}
.cl-entry {
  margin-top: 14px;
}
.cl-version {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.cl-version b {
  font-size: 14px;
  color: var(--van-text-color, #323233);
}
.cl-version span {
  font-size: 12px;
  color: var(--van-text-color-3, #969799);
}
.cl-group {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.cl-group ul {
  flex: 1;
  margin: 0;
  padding-left: 4px;
  list-style: none;
}
.cl-group li {
  position: relative;
  padding-left: 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--van-text-color-2, #646566);
}
.cl-group li::before {
  content: '·';
  position: absolute;
  left: 0;
}
</style>
