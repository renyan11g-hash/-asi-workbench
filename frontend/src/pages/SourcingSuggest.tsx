import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ClipboardList,
  Compass,
  Lightbulb,
  Loader2,
  SearchCheck,
  Wand2,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScoreRing, SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { EMPTY_SOURCE, Evaluation, PriceRow, SourceInfo } from '@/types'
import { GLS_CATEGORIES } from '@/constants/gls-categories'

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-slate-600">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

const inputCls = 'h-9 text-sm'

const SOURCE_DRAFT_KEY = 'asi-draft:sourcing:source'
const KEYWORDS_DRAFT_KEY = 'asi-draft:sourcing:keywordsText'

/** 把选品方向写入产品信息预填页的 localStorage 草稿（与 useDraft 相同格式），再跳转 */
function prefillSourcingDraft(d: {
  product: string
  category: string
  search1688?: string[]
}) {
  if (typeof window === 'undefined') return
  let base: Partial<SourceInfo> = {}
  try {
    const raw = localStorage.getItem(SOURCE_DRAFT_KEY)
    if (raw) base = (JSON.parse(raw)?.value ?? {}) as Partial<SourceInfo>
  } catch {
    /* 忽略损坏的旧草稿 */
  }
  const next: SourceInfo = {
    ...EMPTY_SOURCE,
    ...base,
    sourceTitle: d.product,
    category: d.category || base.category || '',
  }
  const meta = { savedAt: new Date().toISOString(), bytes: JSON.stringify(next).length }
  localStorage.setItem(SOURCE_DRAFT_KEY, JSON.stringify({ value: next, meta }))
  const kw = [...(d.search1688 ?? [])].join(', ')
  if (kw) {
    localStorage.setItem(
      KEYWORDS_DRAFT_KEY,
      JSON.stringify({ value: kw, meta: { savedAt: meta.savedAt, bytes: kw.length } })
    )
  }
}

interface SourcingResult {
  directions: Array<{
    product: string
    why: string
    search1688: string[]
    category: string
    expectedUnitCostCny: number | null
    expectedSellUsd: { min: number; max: number } | null
    risks: string[]
  }>
  keywords1688: string[]
  tips: string[]
}

/** /preview/quick-evaluate 的返回：抓取资料 + AI 评估 + 价格表 */
interface QuickResult {
  ok: boolean
  message: string
  fetched: {
    sourceTitle: string
    sourceKeywords: string[]
    description: string
    materialCn: string
    colorsCn: string
    sizeCn: string
    weightG: number | null
    cartonSpecCm: string
    pcsPerCarton: number | null
    cartonGwKg: number | null
    moq: number | null
    priceCny: number | null
  }
  source: SourceInfo
  evaluation: Evaluation
  priceGrid: PriceRow[]
}

export default function SourcingSuggest() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [sourcing, setSourcing] = useState<SourcingResult | null>(null)
  const [input, setInput] = useState({ category: '', keywords: '', budgetCny: '', notes: '' })
  const [quickUrl, setQuickUrl] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [quick, setQuick] = useState<QuickResult | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const r = await api.sourcingSuggest({
        category: input.category || undefined,
        keywords: input.keywords || undefined,
        budgetCny: input.budgetCny ? Number(input.budgetCny) : undefined,
        notes: input.notes || undefined,
      })
      setSourcing(r)
      toast.success(`已生成 ${r.directions?.length ?? 0} 个选品方向`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 粘贴链接 → 抓取 + AI 评估一条龙 */
  const runQuick = async () => {
    const url = quickUrl.trim()
    if (!url) {
      toast.error('请先粘贴 1688 商品链接')
      return
    }
    setQuickBusy(true)
    try {
      const r = await api.quickEvaluate(url)
      setQuick(r)
      toast.success(`评估完成：${r.evaluation.score} 分`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setQuickBusy(false)
    }
  }

  /** 把抓到的资料带入「产品信息预填」页，继续补全尺寸 / 材质 / 箱规等 */
  const goPrefill = () => {
    if (!quick) return
    let base: Partial<SourceInfo> = {}
    try {
      const raw = localStorage.getItem(SOURCE_DRAFT_KEY)
      if (raw) base = (JSON.parse(raw)?.value ?? {}) as Partial<SourceInfo>
    } catch {
      /* 忽略损坏的旧草稿 */
    }
    const next: SourceInfo = {
      ...EMPTY_SOURCE,
      ...base,
      ...quick.source,
      category: base.category || quick.source.category || '',
    }
    const meta = { savedAt: new Date().toISOString(), bytes: JSON.stringify(next).length }
    localStorage.setItem(SOURCE_DRAFT_KEY, JSON.stringify({ value: next, meta }))
    // 清掉上一次的评估结果草稿，避免新旧商品混淆
    localStorage.removeItem('asi-draft:sourcing:evaluation')
    localStorage.removeItem('asi-draft:sourcing:priceGrid')
    toast.success('已带入抓取到的商品信息，请补全尺寸、材质、箱规、价格后正式评估')
    navigate('/sourcing')
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* 流程说明 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        <span className="font-semibold">工作流程：</span>
        <span className="rounded bg-white px-2 py-0.5 font-medium">① 选品预估（本页，AI 找方向）</span>
        <ArrowRight className="h-3 w-3" />
        <span className="rounded bg-white px-2 py-0.5">② 产品信息预填（补全尺寸材质箱规，正式评估）</span>
        <ArrowRight className="h-3 w-3" />
        <span className="rounded bg-white px-2 py-0.5">③ 生成英文链接 → 产品库</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 border-blue-300 bg-white text-xs"
          onClick={() => navigate('/sourcing')}
        >
          <SearchCheck className="mr-1 h-3 w-3" /> 直接去产品信息预填
        </Button>
      </div>

      {/* ② 粘贴链接快速评估（抓取 + AI 评分一条龙） */}
      <SectionCard
        title="粘贴 1688 链接，快速评估（AI 抓取 + 打分）"
        hint="只需一条商品链接：自动抓取商品资料并评估是否值得做；之后再到「产品信息预填」补充尺寸、材质、箱规等细节"
        right={
          <Button size="sm" onClick={runQuick} disabled={quickBusy}>
            {quickBusy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="mr-1 h-3.5 w-3.5" />
            )}
            {quickBusy ? '评估中…' : '快速评估'}
          </Button>
        }
      >
        <Field label="1688 商品链接">
          <Input
            className={inputCls}
            placeholder="https://detail.1688.com/offer/xxxxx.html"
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !quickBusy) void runQuick()
            }}
          />
        </Field>
        {quick && (
          <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-start gap-3">
              <ScoreRing score={quick.evaluation.score} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictBadge verdict={quick.evaluation.verdict} score={quick.evaluation.score} />
                  {quick.fetched.priceCny != null && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                      页面价 ≈ ¥{quick.fetched.priceCny}（请核实）
                    </span>
                  )}
                  {quick.fetched.moq != null && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                      起批 {quick.fetched.moq} 件
                    </span>
                  )}
                </div>
                <p className="truncate text-sm font-medium text-slate-800">
                  {quick.fetched.sourceTitle || '（未抓到标题）'}
                </p>
                <p className="text-[13px] leading-relaxed text-slate-600">{quick.evaluation.summary}</p>
              </div>
            </div>
            {quick.evaluation.risks?.length ||
            quick.evaluation.cons?.length ||
            quick.evaluation.suggestions?.length ? (
              <ul className="space-y-0.5">
                {[
                  ...(quick.evaluation.risks ?? []).map((t) => ({ t: `风险：${t}`, cls: 'text-rose-600' })),
                  ...(quick.evaluation.cons ?? []).map((t) => ({ t: `劣势：${t}`, cls: 'text-amber-700' })),
                  ...(quick.evaluation.suggestions ?? []).map((t) => ({ t: `建议：${t}`, cls: 'text-slate-700' })),
                ].map((it, i) => (
                  <li key={i} className={`text-[12px] leading-relaxed ${it.cls}`}>
                    · {it.t}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={goPrefill}>
                <ClipboardList className="mr-1 h-3.5 w-3.5" /> 去补全产品信息（产品信息预填）
              </Button>
              <span className="text-[11px] text-slate-400">{quick.message}</span>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="1688 选品方向推荐（AI 自动搜寻）"
        hint="不知道卖什么？填几个条件，AI 推荐适合美国促销礼品市场、能吸引买家下单的选品方向，并给出 1688 搜索词"
        right={
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Compass className="mr-1 h-3.5 w-3.5" />}
            {busy ? '推荐中…' : '生成选品方向'}
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="目标类目（可选）">
            <select
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
              value={input.category}
              onChange={(e) => setInput((s) => ({ ...s, category: e.target.value }))}
            >
              <option value="">不限</option>
              {GLS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="预算（¥/件，可选）">
            <Input
              className={inputCls}
              type="number"
              min={0}
              step="0.5"
              placeholder="如 15"
              value={input.budgetCny}
              onChange={(e) => setInput((s) => ({ ...s, budgetCny: e.target.value }))}
            />
          </Field>
          <Field label="偏好关键词（可选）">
            <Input
              className={inputCls}
              placeholder="如 保温杯 帆布袋"
              value={input.keywords}
              onChange={(e) => setInput((s) => ({ ...s, keywords: e.target.value }))}
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="补充说明（可选）" hint="目标人群、使用场景、想避开的品类等">
            <Input
              className={inputCls}
              placeholder="如：面向医院/诊所的员工礼品，避开电子产品"
              value={input.notes}
              onChange={(e) => setInput((s) => ({ ...s, notes: e.target.value }))}
            />
          </Field>
        </div>

        {sourcing && (
          <div className="mt-3 space-y-3">
            {sourcing.directions?.map((d, i) => (
              <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-800">
                    {i + 1}. {d.product}
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    {d.expectedUnitCostCny != null && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700">成本 ≈ ¥{d.expectedUnitCostCny}</span>
                    )}
                    {d.expectedSellUsd && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                        售价 ${d.expectedSellUsd.min}–${d.expectedSellUsd.max}
                      </span>
                    )}
                    {d.category && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{d.category}</span>}
                  </div>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">{d.why}</p>
                {d.search1688?.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-slate-500">1688 搜索：</span>
                    {d.search1688.map((k, j) => (
                      <a
                        key={j}
                        href={`https://search.1688.com/kq/-6D3O${encodeURIComponent(k)}.html`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[11px] text-orange-700 hover:bg-orange-100"
                      >
                        {k} ↗
                      </a>
                    ))}
                  </div>
                )}
                {d.risks?.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-rose-600">风险：{d.risks.join('；')}</p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 text-xs text-blue-600"
                  onClick={() => {
                    prefillSourcingDraft(d)
                    toast.success('已填入产品信息预填表单，补充尺寸、材质、箱规等信息后即可评估')
                    navigate('/sourcing')
                  }}
                >
                  <Wand2 className="mr-1 h-3 w-3" /> 填入产品信息预填表单
                </Button>
              </div>
            ))}
            {sourcing.keywords1688?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500">通用搜索词：</span>
                {sourcing.keywords1688.map((k, i) => (
                  <a
                    key={i}
                    href={`https://search.1688.com/kq/-6D3O${encodeURIComponent(k)}.html`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200"
                  >
                    {k} ↗
                  </a>
                ))}
              </div>
            )}
            {sourcing.tips?.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <div className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-amber-800">
                  <Lightbulb className="h-3 w-3" /> 选品/成交要点
                </div>
                <ul className="space-y-0.5">
                  {sourcing.tips.map((t, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-amber-800">
                      · {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
