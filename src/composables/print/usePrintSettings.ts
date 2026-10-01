/**
 * 版式 / 装饰设置：预设与自定义，本地持久化。
 *
 * - localStorage 里的任何脏数据都会被 sanitizeSettings 收敛到合法区间，
 *   绝不把非法数值（超范围边距、未知纸张、NaN）传进排版/渲染内核（H1）；
 * - 装饰参数（序号字号、标记颜色、虚线密度）可配置（C06）；
 * - 命名预设支持保存 / 一键套用 / 删除（H02）。
 */

import { computed, reactive, ref, watch } from 'vue'
import type {
  DecoratorSpec,
  DividerStyle,
  LayoutPreset,
  LayoutSpec,
  Orientation,
  PaperKind,
  RGB,
} from '@/lib/print/types'

const STORAGE_KEY = 'print_settings_v1'
const PRESET_KEY = 'print_presets_v1'
const MAX_PRESETS = 20

const PRESET_GRID: Record<Exclude<LayoutPreset, 'custom'>, { rows: number; cols: number }> = {
  single: { rows: 1, cols: 1 },
  double: { rows: 1, cols: 2 },
  quad: { rows: 2, cols: 2 },
}

/** 设置项取值范围（同时用于 UI 与 sanitize，避免两处不一致） */
export const LIMITS = {
  rows: [1, 10] as const,
  cols: [1, 10] as const,
  customWidthMm: [50, 500] as const,
  customHeightMm: [50, 700] as const,
  marginMm: [0, 40] as const,
  offsetMm: [-20, 20] as const,
  numberFontPt: [6, 20] as const,
  dashLen: [1, 8] as const,
  dashGap: [0.5, 8] as const,
}

const LAYOUT_PRESETS: LayoutPreset[] = ['single', 'double', 'quad', 'custom']
const PAPERS: PaperKind[] = ['A4', 'A5', 'B5', 'custom']
const ORIENTATIONS: Orientation[] = ['portrait', 'landscape']
const DIVIDERS: DividerStyle[] = ['none', 'dashed', 'line']

/** 可选标记颜色（下发给内核的是 RGB 分量） */
export const MARK_COLORS = ['#1f1f1f', '#000000', '#8a8a8a', '#c0392b', '#1f68eb'] as const

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
  /** C06：序号字号（pt） */
  numberFontPt: number
  /** C06：标记颜色（#rrggbb） */
  markColor: string
  /** C06：虚线段长 / 间隔（pt） */
  dashLen: number
  dashGap: number
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
  numberFontPt: 10,
  markColor: '#1f1f1f',
  dashLen: 3.2,
  dashGap: 2.6,
}

export interface PrintNamedPreset {
  id: string
  name: string
  savedAt: number
  settings: SettingsState
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

/** 把任意来源（localStorage / 旧版本 / 手工篡改）的设置收敛为合法值 */
export function sanitizeSettings(raw: unknown): SettingsState {
  const d = DEFAULT_STATE
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SettingsState>
  return {
    preset: pick(o.preset, LAYOUT_PRESETS, d.preset),
    customRows: Math.round(clampNum(o.customRows, ...LIMITS.rows, d.customRows)),
    customCols: Math.round(clampNum(o.customCols, ...LIMITS.cols, d.customCols)),
    orientation: pick(o.orientation, ORIENTATIONS, d.orientation),
    paper: pick(o.paper, PAPERS, d.paper),
    customWidthMm: clampNum(o.customWidthMm, ...LIMITS.customWidthMm, d.customWidthMm),
    customHeightMm: clampNum(o.customHeightMm, ...LIMITS.customHeightMm, d.customHeightMm),
    marginMm: clampNum(o.marginMm, ...LIMITS.marginMm, d.marginMm),
    offsetXMm: clampNum(o.offsetXMm, ...LIMITS.offsetMm, d.offsetXMm),
    offsetYMm: clampNum(o.offsetYMm, ...LIMITS.offsetMm, d.offsetYMm),
    numbering: o.numbering === true,
    divider: pick(o.divider, DIVIDERS, d.divider),
    duplex: o.duplex === true,
    numberFontPt: clampNum(o.numberFontPt, ...LIMITS.numberFontPt, d.numberFontPt),
    markColor: /^#[0-9a-fA-F]{6}$/.test(String(o.markColor)) ? String(o.markColor).toLowerCase() : d.markColor,
    dashLen: clampNum(o.dashLen, ...LIMITS.dashLen, d.dashLen),
    dashGap: clampNum(o.dashGap, ...LIMITS.dashGap, d.dashGap),
  }
}

/** #rrggbb → RGB（0~1）；解析失败回退深灰 */
export function hexToRgb(hex: string): RGB {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return [0.13, 0.13, 0.13]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function loadState(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STATE }
    return sanitizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function loadPresets(): PrintNamedPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list
      .slice(0, MAX_PRESETS)
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => ({
        id: String(p.id ?? `preset_${i}`),
        name: String(p.name ?? `预设 ${i + 1}`).slice(0, 20),
        savedAt: Number(p.savedAt) || Date.now(),
        settings: sanitizeSettings(p.settings),
      }))
  } catch {
    return []
  }
}

function genPresetId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function usePrintSettings() {
  const state = reactive<SettingsState>(loadState())
  const namedPresets = ref<PrintNamedPreset[]>(loadPresets())

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
    numberFontPt: state.numberFontPt,
    markColor: hexToRgb(state.markColor),
    dashLen: state.dashLen,
    dashGap: state.dashGap,
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

  watch(
    namedPresets,
    (val) => {
      try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(val))
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

  /** 保存当前设置为命名预设（同名覆盖） */
  function savePreset(name: string): PrintNamedPreset | null {
    const trimmed = name.trim().slice(0, 20)
    if (!trimmed) return null
    const settings = sanitizeSettings({ ...state })
    const exist = namedPresets.value.find((p) => p.name === trimmed)
    if (exist) {
      exist.settings = settings
      exist.savedAt = Date.now()
      namedPresets.value = [...namedPresets.value]
      return exist
    }
    const preset: PrintNamedPreset = {
      id: genPresetId(),
      name: trimmed,
      savedAt: Date.now(),
      settings,
    }
    namedPresets.value = [preset, ...namedPresets.value].slice(0, MAX_PRESETS)
    return preset
  }

  /** 一键套用命名预设 */
  function applyPreset(id: string): boolean {
    const preset = namedPresets.value.find((p) => p.id === id)
    if (!preset) return false
    Object.assign(state, sanitizeSettings(preset.settings))
    return true
  }

  function deletePreset(id: string) {
    namedPresets.value = namedPresets.value.filter((p) => p.id !== id)
  }

  return {
    state,
    namedPresets,
    selectPreset,
    layoutSpec,
    decorator,
    resetSettings,
    savePreset,
    applyPreset,
    deletePreset,
  }
}
