/** 版式 / 装饰设置：预设与自定义，本地持久化（导出预设记忆）。 */

import { computed, reactive, watch } from 'vue'
import type {
  DecoratorSpec,
  DividerStyle,
  LayoutPreset,
  LayoutSpec,
  Orientation,
  PaperKind,
} from '@/lib/print/types'

const STORAGE_KEY = 'print_settings_v1'

const PRESET_GRID: Record<Exclude<LayoutPreset, 'custom'>, { rows: number; cols: number }> = {
  single: { rows: 1, cols: 1 },
  double: { rows: 1, cols: 2 },
  quad: { rows: 2, cols: 2 },
}

export interface SettingsState {
  preset: LayoutPreset
  customRows: number
  customCols: number
  orientation: Orientation
  paper: PaperKind
  customWidthMm: number
  customHeightMm: number
  marginMm: number
  offsetXMm: number
  offsetYMm: number
  numbering: boolean
  divider: DividerStyle
  duplex: boolean
}

const DEFAULT_STATE: SettingsState = {
  preset: 'double',
  customRows: 3,
  customCols: 3,
  orientation: 'portrait',
  paper: 'A4',
  customWidthMm: 210,
  customHeightMm: 297,
  marginMm: 12,
  offsetXMm: 0,
  offsetYMm: 0,
  numbering: false,
  divider: 'dashed',
  duplex: false,
}

function loadState(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STATE }
    const parsed = JSON.parse(raw) as Partial<SettingsState>
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function usePrintSettings() {
  const state = reactive<SettingsState>(loadState())

  function selectPreset(p: LayoutPreset) {
    state.preset = p
    // 预设联动默认方向：四页横版，单/双页竖版；自定义保持当前
    if (p === 'quad') state.orientation = 'landscape'
    else if (p !== 'custom') state.orientation = 'portrait'
  }

  const layoutSpec = computed<LayoutSpec>(() => {
    const grid =
      state.preset === 'custom'
        ? { rows: state.customRows, cols: state.customCols }
        : PRESET_GRID[state.preset]
    return {
      rows: grid.rows,
      cols: grid.cols,
      orientation: state.orientation,
      paper: state.paper,
      customWidthMm: state.customWidthMm,
      customHeightMm: state.customHeightMm,
      marginMm: state.marginMm,
      offsetXMm: state.offsetXMm,
      offsetYMm: state.offsetYMm,
    }
  })

  const decorator = computed<DecoratorSpec>(() => ({
    numbering: state.numbering,
    divider: state.divider,
    duplex: state.duplex,
  }))

  watch(
    state,
    (val) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
      } catch {
        /* storage full */
      }
    },
    { deep: true },
  )

  /** 恢复默认设置 */
  function resetSettings() {
    Object.assign(state, DEFAULT_STATE)
  }

  return { state, selectPreset, layoutSpec, decorator, resetSettings }
}
