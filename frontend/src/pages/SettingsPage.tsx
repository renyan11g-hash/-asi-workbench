import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Save, Trash2, Wifi } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SectionCard } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import apiClient from '@/lib/api-client'
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

interface ProviderPreset {
  id: string
  name: string
  kind: 'text' | 'image'
  baseUrl: string
  models: string[]
  keyUrl: string
  needsProxy: boolean
  supportsVision: boolean
  priceNote: string
  note: string
}

export default function SettingsPage() {
  const qc = useQueryClient()
  const { data } = useSettings()
  const [form, setForm] = useState<Settings | null>(null)
  const [qtyText, setQtyText] = useState('')
  const [imprintText, setImprintText] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testingImage, setTestingImage] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [refreshingFx, setRefreshingFx] = useState(false)
  const [fxMeta, setFxMeta] = useState<{ source?: string; updatedAt?: string; autoUpdate?: boolean } | null>(null)
  const [providers, setProviders] = useState<ProviderPreset[]>([])

  // 从后端加载 AI 供应商预设（与后端保持同步）
  useEffect(() => {
    api
      .listAiProviders()
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]))
  }, [])

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

  const testImage = async () => {
    if (!form) return
    setTestingImage(true)
    try {
      const res = await api.testImageConnection({
        imageBaseUrl: form.imageBaseUrl,
        imageApiKey: form.imageApiKey,
        imageModel: form.imageModel,
      })
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setTestingImage(false)
    }
  }

  const uploadLogo = async (file: File) => {
    setUploadingLogo(true)
    try {
      // 后端接受 JSON base64 dataURL（避免 multipart 依赖）
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      await apiClient.post('/product-images/logo', { dataUrl })
      // 加时间戳破缓存，立即显示新 Logo
      setLogoUrl(`/api/product-images/logo?t=${Date.now()}`)
      toast.success('Logo 已上传，生成主图时将自动融合到产品正面')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setUploadingLogo(false)
    }
  }

  // 加载已上传 Logo 预览（404 = 尚未上传，忽略）
  useEffect(() => {
    let cancelled = false
    apiClient
      .get('/product-images/logo', { responseType: 'blob' })
      .then((r) => {
        if (!cancelled) setLogoUrl(URL.createObjectURL(r.data as Blob))
      })
      .catch(() => {
        if (!cancelled) setLogoUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      const r = await api.refreshFxRate(true)
      if (r.ok) {
        patch({ fxRate: r.fxRate })
        setFxMeta({ source: r.source, updatedAt: r.updatedAt ?? new Date().toISOString(), autoUpdate: r.autoUpdate })
        toast.success(`汇率已更新为 1 USD = ${r.fxRate} CNY（来源：${r.source ?? 'live'}）`)
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
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {providers.filter((p) => p.kind === 'text').map((p) => (
                <button
                  key={p.id}
                  onClick={() => patch({ aiBaseUrl: p.baseUrl, aiModel: p.models[0] ?? '' })}
                  title={`${p.note}\n价格：${p.priceNote}${p.needsProxy ? '\n需科学上网' : ' · 国内直连'}${p.supportsVision ? ' · 支持图片识别' : ''}`}
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    form.aiBaseUrl === p.baseUrl
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700'
                  }`}
                >
                  {p.name}
                  {p.supportsVision && <span className="ml-1 text-[10px] text-emerald-600">图</span>}
                  {p.needsProxy && <span className="ml-1 text-[10px] text-amber-600">VPN</span>}
                </button>
              ))}
            </div>
            {(() => {
              const cur = providers.find((p) => p.baseUrl === form.aiBaseUrl)
              if (!cur) return null
              return (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                  <div className="font-medium text-slate-700">{cur.name}</div>
                  <div>{cur.note}</div>
                  <div className="mt-0.5 text-slate-500">
                    参考价格：{cur.priceNote}
                    {cur.needsProxy ? ' · 需科学上网' : ' · 国内直连'}
                    {cur.supportsVision ? ' · 支持图片识别（选品识图需要）' : ' · 不支持图片'}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span>推荐模型：</span>
                    {cur.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => patch({ aiModel: m })}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                          form.aiModel === m
                            ? 'border-blue-400 bg-blue-100 text-blue-700'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                    <a
                      href={cur.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 text-blue-600 hover:underline"
                    >
                      → 获取 API Key
                    </a>
                  </div>
                </div>
              )
            })()}
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
        title="图像生成（产品图片）"
        hint="用于生成产品主图/尺寸图/介绍图。火山引擎即梦 Seedream 国内直连、支付宝充值；也兼容 OpenAI gpt-image-1。与上方文本 AI 相互独立。"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {providers.filter((p) => p.kind === 'image').map((p) => (
                <button
                  key={p.id}
                  onClick={() => patch({ imageBaseUrl: p.baseUrl, imageModel: p.models[0] ?? '' })}
                  title={`${p.note}\n价格：${p.priceNote}${p.needsProxy ? '\n需科学上网' : ' · 国内直连'}`}
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    form.imageBaseUrl === p.baseUrl
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
            {(() => {
              const cur = providers.find((p) => p.kind === 'image' && p.baseUrl === form.imageBaseUrl)
              if (!cur) return null
              return (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                  <div className="font-medium text-slate-700">{cur.name}</div>
                  <div>{cur.note}</div>
                  <div className="mt-0.5 text-slate-500">参考价格：{cur.priceNote}{cur.needsProxy ? ' · 需科学上网' : ' · 国内直连'}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span>推荐模型：</span>
                    {cur.models.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => patch({ imageModel: m })}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                          form.imageModel === m
                            ? 'border-blue-400 bg-blue-100 text-blue-700'
                            : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                    <a href={cur.keyUrl} target="_blank" rel="noreferrer" className="ml-1 text-blue-600 hover:underline">
                      → 获取 API Key
                    </a>
                  </div>
                </div>
              )
            })()}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Base URL" hint="火山引擎填 https://ark.cn-beijing.volces.com/api/v3（粘贴完整端点也可自动识别）">
                <Input
                  className="h-9 text-sm"
                  value={form.imageBaseUrl}
                  onChange={(e) => patch({ imageBaseUrl: e.target.value })}
                  placeholder="https://ark.cn-beijing.volces.com/api/v3"
                />
              </Field>
            </div>
            <Field label="API Key" hint={data?.hasImageApiKey ? '已保存 Key，留空则不修改' : '尚未配置'}>
              <Input
                className="h-9 text-sm"
                type="password"
                value={form.imageApiKey}
                onChange={(e) => patch({ imageApiKey: e.target.value })}
                placeholder="火山引擎 API Key"
              />
            </Field>
            <Field label="模型名称" hint="需与方舟控制台开通的模型 ID 一致">
              <Input
                className="h-9 text-sm"
                value={form.imageModel}
                onChange={(e) => patch({ imageModel: e.target.value })}
                placeholder="doubao-seedream-4-0-250828"
              />
            </Field>
            <Field label="生成尺寸" hint="火山：1K / 2K / 4K；OpenAI：1024x1024 等">
              <Input
                className="h-9 text-sm"
                value={form.imageSize}
                onChange={(e) => patch({ imageSize: e.target.value })}
              />
            </Field>
            <Field label="生成质量" hint="OpenAI 专用（low/medium/high），火山忽略">
              <select
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
                value={form.imageQuality}
                onChange={(e) => patch({ imageQuality: e.target.value as Settings['imageQuality'] })}
              >
                <option value="low">low（省额度）</option>
                <option value="medium">medium</option>
                <option value="high">high（默认）</option>
              </select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={testImage} disabled={testingImage}>
              {testingImage ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wifi className="mr-1 h-4 w-4" />}
              测试连接（会真实生成一张小图）
            </Button>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-medium text-slate-600">品牌 Logo（生成主图时自动融合到产品正面）</div>
            <div className="flex items-center gap-3">
              {logoUrl && (
                <img src={logoUrl} alt="Logo" className="h-14 w-14 rounded border border-slate-200 bg-white object-contain p-1" />
              )}
              <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-blue-300 hover:text-blue-700">
                {uploadingLogo ? '上传中…' : '上传 Logo（PNG 透明底最佳）'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  disabled={uploadingLogo}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadLogo(f)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
          </div>
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
                  title="强制从 open.er-api.com 拉取最新汇率"
                >
                  {refreshingFx ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  强制刷新
                </button>
              </span>
            }
            hint={
              fxMeta?.autoUpdate
                ? `已开启自动实时更新（每小时自动拉取，价格计算自动使用最新汇率）${fxMeta.updatedAt ? ` · 上次更新 ${new Date(fxMeta.updatedAt).toLocaleString('zh-CN')}` : ''}${fxMeta.source ? `（${fxMeta.source}）` : ''}`
                : fxMeta?.source
                  ? `数据来源：${fxMeta.source}${fxMeta.updatedAt ? ' · 更新于 ' + new Date(fxMeta.updatedAt).toLocaleString('zh-CN') : ''}`
                  : '服务端每小时自动拉取实时汇率，价格计算自动使用最新值；也可点右侧按钮强制刷新'
            }
          >
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.01"
              value={form.fxRate}
              onChange={(e) => patch({ fxRate: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="印刷成本（¥/件）" hint="每件固定印刷加工费，默认 1.5">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.1"
              value={form.printCostCny ?? 1.5}
              onChange={(e) => patch({ printCostCny: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="样品费（¥/次）" hint="打样费用，摊入报价首档，默认 300">
            <Input
              className="h-9 text-sm"
              type="number"
              step="10"
              value={form.sampleFeeCny ?? 300}
              onChange={(e) => patch({ sampleFeeCny: Number(e.target.value || 0) })}
            />
          </Field>
          <Field label="杂费比例（% 售价）" hint="手续费 3% + 损耗 1% + 汇率缓冲 1%，默认 5">
            <Input
              className="h-9 text-sm"
              type="number"
              step="0.5"
              value={form.miscFeePct ?? 5}
              onChange={(e) => patch({ miscFeePct: Number(e.target.value || 0) })}
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