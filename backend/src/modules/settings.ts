import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db, getSetting, setSetting } from '../db'
import { DEFAULT_SETTINGS, Settings } from '../types'
import { testConnection } from '../services/ai'
import { AppError } from '../middleware/errorHandler'
import { getFxStatus, refreshFxRate } from '../services/fx'
import { AI_PROVIDER_PRESETS } from '../constants/ai-providers'

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
  fxAutoUpdate: z.boolean().optional(),
  airRateCnyPerKg: z.number().min(0).optional(),
  seaRateCnyPerKg: z.number().min(0).optional(),
  volumetricDivisor: z.number().min(100).optional(),
  markupAir: z.number().min(1).max(5).optional(),
  markupSea: z.number().min(1).max(5).optional(),
  midStrategy: z.enum(['linear', 'random']).optional(),
  airQtyLevels: z.number().int().min(1).max(10).optional(),
  printCostCny: z.number().min(0).optional(),
  sampleFeeCny: z.number().min(0).optional(),
  miscFeePct: z.number().min(0).max(50).optional(),
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
 * 预设 AI 供应商列表（前端设置页下拉选择用）。
 */
settingsRouter.get('/ai-providers', async (_req: Request, res: Response) => {
  res.json({ providers: AI_PROVIDER_PRESETS })
})

/**
 * 实时汇率：后台每小时自动拉取并写回设置（价格计算自动生效）。
 * ?refresh=1 时手动强制刷新（即使关闭了自动更新也会写回）。
 */
settingsRouter.get('/fx-rate', async (req: Request, res: Response) => {
  const force = req.query.refresh === '1' || req.query.refresh === 'true'
  const status = force ? await refreshFxRate(true) : getFxStatus()
  res.json(status)
})

export { AppError }