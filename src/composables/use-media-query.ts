import { onBeforeUnmount, onMounted, ref } from 'vue'

/** 监听媒体查询，返回是否命中（响应式） */
export function useMediaQuery(query: string) {
  const matches = ref(false)
  let mql: MediaQueryList | null = null
  const onChange = (e: MediaQueryListEvent) => {
    matches.value = e.matches
  }
  onMounted(() => {
    mql = window.matchMedia(query)
    matches.value = mql.matches
    mql.addEventListener('change', onChange)
  })
  onBeforeUnmount(() => {
    mql?.removeEventListener('change', onChange)
  })
  return matches
}

/** 是否 PC 宽屏（≥1024px）：进入桌面布局 */
export function useIsPc() {
  return useMediaQuery('(min-width: 1024px)')
}
