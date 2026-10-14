import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { DEFAULT_SETTINGS, Settings } from '../types'
import { testConnection } from '../services/ai'
import { AppError } from '../middleware/errorHandler'

export const settingsRouter: Router = Router()

export function loadSettings(): Settings {
  const row = getSetting('app')
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(row) as Partial<Settings>
    const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed }
    // 迁移：自动档位模式默认 8 档（前 4 空运 / 后 4 海运）；手动模式才用用户手填档位
    if (merged.qtyLevelsMode !== 'manual') {
      merged.qtyLevels = [...DEFAULT_SETTINGS.qtyLevels]
      merged.airQtyLevels = DEFAULT_SETTINGS.airQtyLevels
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(next: Settings): Settings {
  setSetting('app', JSON.stringify(next))
  return next
}

const settingsSchema = z.object({
  aiBaseUrl: z.string().optional(),
  aiApiKey: z.string().optional(),
  aiModel: z.string().optional(),
  fxRate: z.number().positive().optional(),
  airRateCnyPerKg: z.number().min(0).optional(),
  seaRateCnyPerKg: z.number().min(0).optional(),
  volumetricDivisor: z.number().min(100).optional(),
  markupAir: z.number().min(1).max(5).optional(),
  markupSea: z.number().min(1).max(5).optional(),
  midStrategy: z.enum(['linear', 'random']).optional(),
  airQtyLevels: z.number().int().min(1).max(10).optional(),
  rounding: z.enum(['none', 'cent05', 'end99']).optional(),
  qtyLevels: z.array(z.number().int().positive()).optional(),
  qtyLevelsMode: z.enum(['auto', 'manual']).optional(),
  defaultImprintMethods: z.array(z.string()).optional(),
  targetCategories: z.array(z.string()).optional(),
})

const maskKey = (key?: string) => {
  if (!key) return ''
  const k = key.trim()
  if (k.length <= 8) return '***'
  return `${k.slice(0, 4)}****${k.slice(-4)}`
}

settingsRouter.get('/', async (_req: Request, res: Response) => {
  const s = loadSettings()
  res.json({
    settings: { ...s, aiApiKey: maskKey(s.aiApiKey) },
    hasApiKey: Boolean(s.aiApiKey?.trim()),
  })
})

settingsRouter.put('/', async (req: Request, res: Response) => {
  const patch = settingsSchema.parse(req.body ?? {})
  const current = loadSettings()
  const next: Settings = { ...current, ...patch }
  if (patch.aiApiKey && patch.aiApiKey.includes('****')) {
    next.aiApiKey = current.aiApiKey
  }
  if (patch.qtyLevels?.length) {
    next.qtyLevels = [...patch.qtyLevels].sort((a, b) => a - b)
  }
  saveSettings(next)
  res.json({
    settings: { ...next, aiApiKey: maskKey(next.aiApiKey) },
    hasApiKey: Boolean(next.aiApiKey?.trim()),
  })
})

settingsRouter.post('/test', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<Settings>
  const current = loadSettings()
  const probe: Pick<Settings, 'aiBaseUrl' | 'aiApiKey' | 'aiModel'> = {
    aiBaseUrl: body.aiBaseUrl ?? current.aiBaseUrl,
    aiApiKey: body.aiApiKey && !body.aiApiKey.includes('****') ? body.aiApiKey : current.aiApiKey,
    aiModel: body.aiModel ?? current.aiModel,
  }
  const result = await testConnection(probe)
  res.json(result)
})

/**
 * 清空产品库。
 * scope:
 *   - 'active'   仅清空「非回收站」的产品（默认）
 *   - 'trashed'  仅清空回收站（彻底删除已软删的产品）
 *   - 'all'      全部清空（最危险，弹窗二次确认）
 */
settingsRouter.delete('/data', async (req: Request, res: Response) => {
  const scope = (req.query.scope as string) || 'active'
  let info
  if (scope === 'trashed') {
    info = db.prepare("DELETE FROM products WHERE status = 'trashed'").run()
    res.json({ ok: true, scope, deleted: info.changes, message: `已清空回收站（${info.changes} 条）` })
  } else if (scope === 'all') {
    info = db.prepare('DELETE FROM products').run()
    res.json({ ok: true, scope, deleted: info.changes, message: `已清空全部产品（${info.changes} 条）` })
  } else {
    info = db.prepare("DELETE FROM products WHERE status != 'trashed'").run()
    res.json({ ok: true, scope: 'active', deleted: info.changes, message: `已清空非回收站（${info.changes} 条）` })
  }
})

/**
 * 实时汇率：拉 exchangerate-api.com（免费、无 Key）。返回 USD/CNY（即 1 USD = N CNY），
 * 失败时回退到当前设置里的 fxRate。
 */
settingsRouter.get('/fx-rate', async (_req: Request, res: Response) => {
  const current = loadSettings()
  const fallback = Number(current.fxRate) || 6.7
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    const r = await fetch('https://open.er-api.com/v6/latest/CNY', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'asi-workbench/1.0' },
    })
    clearTimeout(timer)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { result?: string; rates?: Record<string, number> }
    if (data.result !== 'success' || !data.rates?.USD)
      throw new Error('返回格式异常')
    const usdPerCny = data.rates.USD // 1 CNY = X USD
    const cnyPerUsd = 1 / usdPerCny
    res.json({
      ok: true,
      fxRate: Math.round(cnyPerUsd * 1000) / 1000,
      source: 'open.er-api.com',
      updatedAt: new Date().toISOString(),
    })
  } catch (err) {
    res.json({
      ok: false,
      fxRate: fallback,
      source: 'fallback',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

export { AppError }