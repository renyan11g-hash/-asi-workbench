import { useCallback, useEffect, useRef, useState } from 'react'

export interface DraftMeta {
  /** ISO 时间戳，用于显示"X 分钟前" */
  savedAt: string
  /** 草稿大小（字节估算） */
  bytes: number
}

const KEY_PREFIX = 'asi-draft:'
const DEBOUNCE_DEFAULT = 800

function readDraft<T>(key: string): { value: T; meta: DraftMeta } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { value: T; meta: DraftMeta }
    if (parsed?.meta?.savedAt && parsed.value != null) return parsed
    return null
  } catch {
    return null
  }
}

function writeDraft<T>(key: string, value: T) {
  if (typeof window === 'undefined') return
  try {
    const meta: DraftMeta = {
      savedAt: new Date().toISOString(),
      bytes: JSON.stringify(value).length,
    }
    localStorage.setItem(KEY_PREFIX + key, JSON.stringify({ value, meta }))
  } catch {
    /* localStorage 满了或被禁用，静默 */
  }
}

function clearDraft(key: string) {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(KEY_PREFIX + key)
  } catch {
    /* noop */
  }
}

/**
 * 草稿 hook：把 value 持久化到 localStorage。
 * - 首次挂载时如果存在草稿，会调 onRestore(value) 让业务方决定是否采用。
 * - 之后 value 每次变化（debounce）自动写入。
 */
export function useDraft<T>(key: string, value: T, opts?: { debounceMs?: number }): {
  meta: DraftMeta | null
  clear: () => void
  accept: () => void
  discard: () => void
} {
  const debounceMs = opts?.debounceMs ?? DEBOUNCE_DEFAULT
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [meta, setMeta] = useState<DraftMeta | null>(null)
  const [active, setActive] = useState(true)
  const firstSync = useRef(false)

  // 初始化：先从 localStorage 读出 meta（用于显示"X 分钟前"），但不覆盖 value
  useEffect(() => {
    const existing = readDraft<T>(key)
    if (existing) setMeta(existing.meta)
    firstSync.current = true
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [key])

  // 监听 value 变化写入（debounce）
  useEffect(() => {
    if (!firstSync.current) return
    if (!active) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      writeDraft(key, value)
      setMeta({ savedAt: new Date().toISOString(), bytes: JSON.stringify(value).length })
    }, debounceMs)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value), key, debounceMs, active])

  const clear = useCallback(() => {
    clearDraft(key)
    setMeta(null)
  }, [key])

  const accept = useCallback(() => setActive(true), [])
  const discard = useCallback(() => {
    clearDraft(key)
    setMeta(null)
  }, [key, clear])

  return { meta, clear, accept, discard }
}

/** 读草稿（不订阅），用于初始化 state */
export function loadDraft<T>(key: string): T | null {
  const got = readDraft<T>(key)
  return got ? got.value : null
}
