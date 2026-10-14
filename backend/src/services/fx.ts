import { getSetting, setSetting } from '../db'
import { DEFAULT_SETTINGS, Settings } from '../types'
import { logger } from '../config/logger'

/**
 * 实时汇率服务：
 * - 服务启动时自动拉取一次 USD/CNY 汇率
 * - 之后每小时定时刷新（汇率本身每日变动有限，1 小时足够"实时"）
 * - 拉取成功后自动写回设置库，价格计算（buildPriceGrid 等）每次 loadSettings()
 *   都会读到最新汇率，无需用户手动刷新
 * - 可通过设置 fxAutoUpdate=false 关闭自动覆盖（仍可手动刷新）
 */

export interface FxStatus {
  ok: boolean
  /** 1 USD = ? CNY */
  fxRate: number
  source: 'live' | 'cache' | 'fallback'
  updatedAt: string | null
  autoUpdate: boolean
  message?: string
}

const FX_API_URL = 'https://open.er-api.com/v6/latest/CNY'
const FETCH_TIMEOUT_MS = 8000
const REFRESH_INTERVAL_MS = 60 * 60 * 1000 // 1 小时

let lastUpdatedAt: string | null = null
let lastRate: number | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

function readSettingsRaw(): Settings {
  const row = getSetting('app')
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row) as Partial<Settings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 拉取实时汇率：返回 1 USD = ? CNY */
export async function fetchCnyPerUsd(): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(FX_API_URL, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'asi-workbench/1.0' },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { result?: string; rates?: Record<string, number> }
    if (data.result !== 'success' || !data.rates?.USD) throw new Error('汇率接口返回格式异常')
    const cnyPerUsd = 1 / data.rates.USD
    return Math.round(cnyPerUsd * 1000) / 1000
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取最新汇率并写回设置库（价格计算自动生效）。
 * @param force true=忽略自动更新开关强制写回（手动刷新按钮）
 */
export async function refreshFxRate(force = false): Promise<FxStatus> {
  const settings = readSettingsRaw()
  const fallback = Number(settings.fxRate) || DEFAULT_SETTINGS.fxRate
  const autoUpdate = settings.fxAutoUpdate !== false
  try {
    const rate = await fetchCnyPerUsd()
    lastUpdatedAt = new Date().toISOString()
    lastRate = rate
    if (force || autoUpdate) {
      if (Math.abs(rate - fallback) > 1e-9) {
        setSetting('app', JSON.stringify({ ...settings, fxRate: rate }))
        logger.info({ fxRate: rate, prev: fallback }, '汇率已自动更新')
      }
    }
    return { ok: true, fxRate: rate, source: 'live', updatedAt: lastUpdatedAt, autoUpdate }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '汇率拉取失败，使用缓存/回退值')
    return {
      ok: false,
      fxRate: lastRate ?? fallback,
      source: lastRate != null ? 'cache' : 'fallback',
      updatedAt: lastUpdatedAt,
      autoUpdate,
      message,
    }
  }
}

/** 当前汇率状态（不发起网络请求） */
export function getFxStatus(): FxStatus {
  const settings = readSettingsRaw()
  return {
    ok: lastRate != null,
    fxRate: (lastRate ?? Number(settings.fxRate)) || DEFAULT_SETTINGS.fxRate,
    source: lastRate != null ? 'cache' : 'fallback',
    updatedAt: lastUpdatedAt,
    autoUpdate: settings.fxAutoUpdate !== false,
  }
}

/** 启动时调用：立即拉取一次 + 每小时定时刷新（不阻塞启动） */
export function startFxAutoRefresh(): void {
  if (refreshTimer) return
  void refreshFxRate()
  refreshTimer = setInterval(() => {
    void refreshFxRate()
  }, REFRESH_INTERVAL_MS)
  // 不阻止进程退出
  refreshTimer.unref?.()
  logger.info({ intervalMs: REFRESH_INTERVAL_MS }, '汇率自动刷新已启动')
}

export function stopFxAutoRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
