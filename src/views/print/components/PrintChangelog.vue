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

const CURRENT_VERSION = 'v1.3.0'
const READ_KEY = 'print_changelog_read'

const entries: ChangelogEntry[] = [
  {
    version: 'v1.3.0',
    date: '2026-10-01',
    add: [
      '拖拽批量导入：把票据文件直接拖到页面即可导入；拖入本站链接也可导入（外域链接会被隐私策略拒绝）',
      '排版预设：把版式 / 边距 / 标记存成命名预设，一键套用（保存在本地）',
      '标记样式可配置：序号字号、标记颜色、虚线密度均可调',
      '应用开关与能力位：服务端停用应用后，入口不再可用（接口一律拒绝）',
      '导出用量计数：平台按「导出页数」记录用量（仅计数，不含任何票面字段）',
      '文件集支持顺序列表 / 缩略图网格两种视图',
      '导出配额令牌：导出前向平台申请一次性许可，平台按「每日页数」计量与风控（K02）',
      '启动门禁：每次启动联网校验应用状态（平台可配置离线宽限期），客户端版本过低会提示更新',
      '人工校正新增「查看原图」：按需高清渲染票面，便于核对发票号码与金额',
    ],
    optimize: [
      '预览虚拟化真实生效：仅绘制视口附近页面并回收画布显存，数百页时内存显著下降',
      '导入解析全部下沉 Worker：100 页 PDF 导入不再卡住界面，且主包体积大幅减小',
      '导出：按文件增量传输字节、结果零拷贝回传，并显示逐页进度；渲染进程异常可自愈',
      '扫描：同一 PDF 只解析一次，取消逐页重复解析；识别失败会给出逐条原因，不再静默',
      '草稿按登录用户隔离并 7 天过期；改设置不再重写全部票据字节',
      '预览缩略图分辨率提升，界面更清晰',
      '图标字体本地化：不再请求第三方字体 CDN，页面加载零外部请求',
      '首页注入 meta CSP：即使部署环境剥离了响应头，「数据不出本地」的约束依然生效',
    ],
    fix: [
      '修复扫描件导出：带 /Rotate（扫描件常见）或裁剪框（CropBox）的 PDF 不再方向错乱或被拉伸',
      '修复手机照片方向：带 EXIF 方向的 JPG 自动转正（预览/导出/原图三者一致）',
      '修复扫描件 /Rotate 与裁剪框：矢量页按 CropBox 与旋转矩阵嵌入，不再方向错乱或被拉伸',
      '修复打印校准偏移过大时票面被纸张边界裁掉（偏移量按页边距自动钳制）',
      '修复「重新扫描」会覆盖人工补录结果（补录内容不再被引擎结果静默回退）',
      '修复发票二维码解析错位：不再把「发票号码」当金额、把 20 位「校验码」当发票号码',
      '修复金额识别：支持千分位（1,234.56），不再出现数量级错误的金额合计',
      '修复开票日期识别：票号内嵌数字不再干扰日期提取，数电票日期/金额可正常解析',
      '修复去重误判：号码相同的不同票（日期/金额不同）不再被误标重复、不再错扣去重金额',
      '修复序号标记遮挡票面：序号改画在票面外的空白带，绝不覆盖二维码/票面要素',
      '修复超大页边距 / 非法配置导致的负尺寸与白屏（配置自动收敛到合法区间）',
      '修复导出取消仍提示成功、导出文件名重复覆盖、CSV 公式注入等问题',
    ],
  },
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
      '预览虚拟化：仅绘制可视区域附近页面（v1.3.0 修复其未生效的问题）',
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
