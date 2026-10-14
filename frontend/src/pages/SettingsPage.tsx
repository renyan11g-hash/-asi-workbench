import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Save, Trash2, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { useSettings } from '@/hooks/use-data'
import { Settings } from '@/types'

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-slate-600">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

const PRESETS = [
  { name: 'DeepSeek（便宜，中文场景常用）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
]

export default function SettingsPage() {
  const qc = useQueryClient()
  const { data } = useSettings()
  const [form, setForm] = useState<Settings | null>(null)
  const [qtyText, setQtyText] = useState('')
  const [imprintText, setImprintText] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [refreshingFx, setRefreshingFx] = useState(false)
  const [fxMeta, setFxMeta] = useState<{ source?: string; updatedAt?: string } | null>(null)

  useEffect(() => {
    if (data && !form) {
      setForm(data.settings)
      setQtyText(data.settings.qtyLevels.join(', '))
      setImprintText(data.settings.defaultImprintMethods.join(', '))
    }
  }, [data, form])

  const patch = (p: Partial<Settings>) => setForm((f) => (f ? { ...f, ...p } : f))

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      await api.saveSettings({
        ...form,
        qtyLevels: qtyText
          .split(/[,，\s]+/)
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b),
        defaultImprintMethods: imprintText
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
      })
      qc.invalidateQueries({ queryKey: ['settings'] })
      toast.success('设置已保存')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    if (!form) return
    setTesting(true)
    try {
      const res = await api.testConnection({
        aiBaseUrl: form.aiBaseUrl,
        aiApiKey: form.aiApiKey,
        aiModel: form.aiModel,
      })
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  const clearAll = async () => {
    const choice = window.prompt(
      '清空产品库选项（输入数字）：\n  1 = 清空非回收站（保留回收站）\n  2 = 仅清空回收站\n  3 = 全部清空（最危险，先导出 CSV）'
    )
    const map: Record<string, 'active' | 'trashed' | 'all'> = { '1': 'active', '2': 'trashed', '3': 'all' }
    const scope = map[String(choice || '').trim()]
    if (!scope) {
      toast.error('已取消或选项无效')
      return
    }
    const labels: Record<typeof scope, string> = {
      active: '清空非回收站（保留回收站）',
      trashed: '仅清空回收站',
      all: '全部清空（含回收站，最危险）',
    }
    if (!window.confirm(`确定「${labels[scope]}」？此操作不可恢复。`)) return
    try {
      const r = await api.clearProducts(scope)
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success(r.message)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const refreshFx = async () => {
    setRefreshingFx(true)
    try {
      const r = await api.refreshFxRate()
      if (r.ok) {
        patch({ fxRate: r.fxRate })
        setFxMeta({ source: r.source, updatedAt: new Date().toISOString() })
        toast.success(`汇率已更新为 1 USD = ${r.fxRate} CNY（来源：${r.source}）`)
      } else {
        toast.error(`获取汇率失败：${r.message ?? '未知错误'}，已使用当前值`)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setRefreshingFx(false)
    }
  }

  if (!form) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载设置…
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-5">
      <SectionCard title="AI 接口" hint="用于选品评估与英文链接生成，支持任何 OpenAI 兼容接口">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => patch({ aiBaseUrl: p.baseUrl, aiModel: p.model })}
                className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Base URL">
                <Input
                  className="h-9 text-sm"
                  value={form.aiBaseUrl}
                  onChange={(e) => patch({ aiBaseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com"
                />
              </Field>
            </div>
            <Field
              label="API Key"
              hint={data?.hasApiKey ? '已保存 Key，留空则不修改' : '尚未配置'}
            >
              <Input
                className="h-9 text-sm"
                type="password"
                value={form.aiApiKey}
                onChange={(e) => patch({ aiApiKey: e.target.value })}
                placeholder="sk-..."
              />
            </Field>
            <Field label="模型名称">
              <Input
                className="h-9 text-sm"
                value={form.aiModel}
                onChange={(e) => patch({ aiModel: e.target.value })}
                placeholder="deepseek-chat"
              />
            </Field>
          </div>
          <Button variant="outline" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wifi className="mr-1 h-4 w-4" />}
            测试连接
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="ASI 8C 价格模型（前 4 空运 / 后 4 海运）"
        hint="体积重 = L×W×H ÷ 除数；计费重 = max(体积重, 实际毛重)。前 N 档空运、后 6-N 档海运。倍率从 markupAir 线性插值到 markupSea。"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            label={
              <span className="flex items-center gap-2">
                汇率（1 USD = ? CNY）
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                  onClick={refreshFx}
                  disabled={refreshingFx}
                  title="从 exchangerate-api.com 拉取实时汇率"
                >
                  {refreshingFx ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  实时刷新
                </button>
              </span>
            }
            hint={fxMeta?.source ? `数据来源：${fxMeta.source}${fxMeta.updatedAt ? ' · 更新于 ' + new Date(fxMeta.updatedAt).toLocaleTimeString() : ''}` : '可点右侧按钮从 exchangerate-api.com 拉取实时汇率，失败时保留当前值'}
          >
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.01"
              value={form.fxRate}
              onChange={(e) => patch({ fxRate: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="空运（¥/kg）" hint="前 airQtyLevels 档使用">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.1"
              value={form.airRateCnyPerKg}
              onChange={(e) => patch({ airRateCnyPerKg: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="海运（¥/kg）" hint="其余档使用">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.1"
              value={form.seaRateCnyPerKg}
              onChange={(e) => patch({ seaRateCnyPerKg: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="体积重除数">
            <Input
              className="h-9 text-sm"
              type="number"
              step="100"
              value={form.volumetricDivisor}
              onChange={(e) => patch({ volumetricDivisor: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="空运首档倍率（默认 1.4）">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.01"
              value={form.markupAir}
              onChange={(e) => patch({ markupAir: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="海运末档倍率（默认 1.25）">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.01"
              value={form.markupSea}
              onChange={(e) => patch({ markupSea: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="中间档策略">
            <select
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={form.midStrategy}
              onChange={(e) => patch({ midStrategy: e.target.value as Settings['midStrategy'] })}
            >
              <option value="linear">线性插值（推荐）</option>
              <option value="random">随机抖动 ±10%</option>
            </select>
          </Field>
          <Field label="空运档数" hint="前 N 档走空运，默认 3">
            <Input
              className="h-9 text-sm"
              type="number"
              min={1}
              max={10}
              value={form.airQtyLevels}
              onChange={(e) => patch({ airQtyLevels: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="价格取整">
            <select
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={form.rounding}
              onChange={(e) => patch({ rounding: e.target.value as Settings['rounding'] })}
            >
              <option value="cent05">向上取整到 0.05</option>
              <option value="end99">X.99 结尾</option>
              <option value="none">不取整（两位小数）</option>
            </select>
          </Field>
          <Field label="报价阶梯模式" hint="自动：首档 数量×售价 > $200，取 30/50/100 等整数档">
            <select
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={form.qtyLevelsMode ?? 'auto'}
              onChange={(e) => patch({ qtyLevelsMode: e.target.value as Settings['qtyLevelsMode'] })}
            >
              <option value="auto">自动定档（推荐）</option>
              <option value="manual">手动指定档位</option>
            </select>
          </Field>
          {form.qtyLevelsMode === 'manual' && (
            <Field label="报价阶梯数量" hint="逗号分隔，从小到大">
              <Input
                className="h-9 text-sm"
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
              />
            </Field>
          )}
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="默认印花方式" hint="逗号分隔，生成链接时会带入">
              <Input
                className="h-9 text-sm"
                value={imprintText}
                onChange={(e) => setImprintText(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </SectionCard>

      <div className="flex items-center justify-between">
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          保存设置
        </Button>
        <Button variant="ghost" className="text-rose-500 hover:text-rose-600" onClick={clearAll}>
          <Trash2 className="mr-1 h-4 w-4" /> 清空产品库
        </Button>
      </div>
    </div>
  )
}