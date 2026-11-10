import { ExternalLink } from 'lucide-react'

import { formatEspCategories, formatMarketHits } from '@/lib/market-format'

/**
 * 海外同款证据的统一展示块。
 *
 * 三块证据，口径必须分开，不能合成一个数：
 *   · ESP（supplier.espwebsite.com）= ASI 旗下 ESP 供应商站群总目录 → 供给密度（差异化主依据）
 *   · 4imprint / QLP / PrintGlobe = 各自的分销商目录 → 需求证据（我们的货卖给分销商）
 * 价格上有一条硬规矩：套装不能跟单件比价，所以"同形态价格带"才是可比的，
 * 全网混合价格带只能当参考。
 */
export interface MarketEvidenceSnap {
  /** 已折算的会员折扣系数（0.6 = 六折） */
  memberDiscount?: number
  queries?: string[]
  total: number
  matched?: number
  priceLow?: number | null
  priceHigh?: number | null
  median?: number | null
  relevanceNote?: string
  samples?: Array<{ title: string; priceMin: number; priceMax?: number; url?: string }>
  esp?: {
    total: number
    matchedSample?: number
    sampleSize?: number
    priceLow?: number | null
    priceHigh?: number | null
    median?: number | null
    productForm?: 'set' | 'single' | 'unknown'
    sameFormCount?: number
    sameFormPriceLow?: number | null
    sameFormPriceHigh?: number | null
    sameFormMedian?: number | null
    sameFormMin?: number | null
    sameFormMax?: number | null
    fallback?: boolean
    categories?: Array<{ name: string; count: number }>
    relevanceNote?: string
    samples?: Array<{
      title: string
      priceMin: number
      productNo?: string
      form?: 'set' | 'single' | 'unknown'
      url?: string
    }>
  }
  demand?: {
    carriers: number
    checked: number
    reachable: number
    bestCount: number
    demandScore: number
    note: string
    priceLow?: number | null
    priceHigh?: number | null
    sources: Array<{
      id: string
      name: string
      ok: boolean
      total: number | null
      matched: number
      sampleSize: number
      priceLow?: number | null
      priceHigh?: number | null
      error?: string
      samples?: Array<{ title: string; priceMin: number; form?: 'set' | 'single' | 'unknown'; url?: string }>
    }>
  }
  /** 识图比价：只有视觉确认的同款才进价格带 */
  priceCheck?: {
    checked: number
    confirmedCount?: number
    sameCount: number
    priceLow?: number | null
    priceHigh?: number | null
    median?: number | null
    note: string
    items: Array<{
      title: string
      priceMin: number
      source: string
      url: string
      same: boolean
      confidence: number
      reason?: string
      suspicious?: boolean
    }>
  }
}

const comma = (n: number) => Math.round(n).toLocaleString('en-US')

const band = (low?: number | null, high?: number | null, median?: number | null) => {
  if (low == null && high == null) return ''
  const range = `$${low ?? '—'}–$${high ?? '—'}`
  return median != null ? `${range}（中位 $${median}）` : range
}

const formText = (f?: string) => (f === 'set' ? '套装' : f === 'single' ? '单件' : '形态未知')

/** 竞品链接：标题可点 + 价格 + 形态徽标 */
function CompetitorLine({
  item,
  showForm = true,
}: {
  item: { title: string; priceMin: number; productNo?: string; form?: string; url?: string }
  showForm?: boolean
}) {
  return (
    <div className="truncate text-slate-500">
      ·{' '}
      {showForm ? (
        <span
          className={
            item.form === 'set'
              ? 'mr-1 rounded bg-sky-50 px-1 text-[10px] text-sky-700'
              : 'mr-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500'
          }
        >
          {formText(item.form)}
        </span>
      ) : null}
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-blue-600"
        >
          {item.title}
          <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
        </a>
      ) : (
        item.title
      )}
      {item.productNo ? <span className="text-slate-400"> [{item.productNo}]</span> : null} — ${item.priceMin} 起
    </div>
  )
}

export function MarketEvidenceBlock({ snap }: { snap: MarketEvidenceSnap }) {
  const esp = snap.esp
  const hasEsp = Boolean(esp && esp.total > 0)
  const noEspMatch = Boolean(esp && esp.total <= 0)
  const cats = formatEspCategories(snap as never, 3)
  const demand = snap.demand
  const demandReachable = demand?.sources.filter((s) => s.ok).length ?? 0

  return (
    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-2 text-[11px] leading-relaxed text-slate-600">
      {/* 供给：ESP */}
      <div>
        <div className="font-semibold text-slate-700">
          海外同款证据
          {snap.memberDiscount ? (
            <span className="ml-1 rounded bg-amber-50 px-1 font-normal text-amber-700">
              已按 {Math.round(snap.memberDiscount * 100)} 折折算为我们的口径
            </span>
          ) : null}
          <span className="ml-1 font-normal text-slate-400">
            （ESP 看全 ASI 供应商供给，下面看分销商需求；套装与单件不混着比价）
          </span>
        </div>
        {hasEsp && esp ? (
          <div className="mt-1">
            <span className="rounded bg-emerald-50 px-1 py-0.5 font-medium text-emerald-700">ESP · 全 ASI 供应商</span>{' '}
            <span className="font-medium text-slate-800">{comma(esp.total)} 款匹配</span>
            {typeof esp.matchedSample === 'number' && esp.sampleSize ? (
              <span className="text-slate-500">
                {' '}
                · 抽样 {esp.sampleSize} 条里 {esp.matchedSample} 条同类
              </span>
            ) : null}
            {snap.queries?.length ? (
              <a
                href={`https://supplier.espwebsite.com/ProductResults/?SearchTerms=${encodeURIComponent(
                  snap.queries[0]
                )}&PCUrl=1`}
                target="_blank"
                rel="noreferrer"
                className="ml-1 inline-flex items-center text-blue-600 underline decoration-blue-200 underline-offset-2"
              >
                去 ESP 核验
                <ExternalLink className="ml-0.5 h-2.5 w-2.5" />
              </a>
            ) : null}
            {esp.fallback ? <span className="ml-1 text-amber-700">（泛匹配兜底，密度不可信）</span> : null}
            {cats ? <div className="mt-0.5 text-slate-500">类目分布：{cats}</div> : null}
            <div className="mt-0.5">
              <span className="text-slate-400">标题同类（{formText(esp.productForm)}）价格带 </span>
              {esp.sameFormPriceLow != null ? (
                <>
                  <span className="text-slate-600">
                    {band(esp.sameFormPriceLow, esp.sameFormPriceHigh, esp.sameFormMedian)}
                  </span>
                  <span className="text-slate-400"> · {esp.sameFormCount ?? 0} 款 · 仅看类目，不能比价</span>
                </>
              ) : (
                <span className="text-slate-400">样本不足</span>
              )}
            </div>
            {esp.priceLow != null ? (
              <div className="text-slate-400">
                全网混合价格带 {band(esp.priceLow, esp.priceHigh, esp.median)}（含单件与套装，仅参考）
              </div>
            ) : null}
            {esp.samples?.length ? (
              <div className="mt-1 space-y-0.5">
                {esp.samples.slice(0, 6).map((s, i) => (
                  <CompetitorLine key={i} item={s} />
                ))}
              </div>
            ) : null}
            {esp.relevanceNote ? <div className="mt-0.5 text-amber-700">{esp.relevanceNote}</div> : null}
          </div>
        ) : noEspMatch ? (
          <div className="mt-1">
            <span className="rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-600">ESP · 全 ASI 供应商</span>{' '}
            <span className="text-slate-700">没有匹配到任何产品</span>
          </div>
        ) : (
          <div className="mt-1 text-slate-400">
            ESP · 这条评估是旧版本做的（当时只用 4imprint），重新评估即可补上全 ASI 供应商证据
          </div>
        )}
      </div>

      {/* 识图比价：唯一能拿来判断"我们的报价贵不贵"的证据 */}
      {snap.priceCheck ? (
        <div className="border-t border-slate-100 pt-1.5">
          <div>
            <span className="rounded bg-amber-50 px-1 py-0.5 font-medium text-amber-700">识图比价</span>{' '}
            {snap.priceCheck.priceLow != null ? (
              <>
                <span className="font-medium text-slate-800">
                  同款价格带 {band(snap.priceCheck.priceLow, snap.priceCheck.priceHigh, snap.priceCheck.median)}
                </span>
                <span className="text-slate-400">
                  {' '}
                  · 识图确认 {snap.priceCheck.confirmedCount ?? snap.priceCheck.sameCount} 条 / 可用{' '}
                  {snap.priceCheck.sameCount} 条
                </span>
              </>
            ) : (
              <span className="text-amber-700">没有识图确认的同款，本次不做价格对比</span>
            )}
          </div>
          {snap.priceCheck.items?.length ? (
            <div className="mt-0.5 space-y-0.5">
              {snap.priceCheck.items.slice(0, 6).map((it, i) => (
                <div key={i} className="truncate text-slate-500">
                  {it.same ? <span className="mr-1 text-emerald-600">✔ 同款</span> : <span className="mr-1 text-slate-400">✘ 不同</span>}
                  {it.url ? (
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-blue-600"
                    >
                      {it.title}
                      <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                    </a>
                  ) : (
                    it.title
                  )}{' '}
                  — ${it.priceMin} <span className="text-slate-400">（{it.source}）</span>
                  {it.suspicious ? <span className="text-amber-700"> · 价格异常已剔除</span> : null}
                  {it.reason ? <span className="text-slate-400"> · {it.reason}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-0.5 text-slate-500">{snap.priceCheck.note}</div>
        </div>
      ) : null}

      {/* 需求：分销商 */}
      {demand ? (
        <div className="border-t border-slate-100 pt-1.5">
          <div>
            <span className="rounded bg-violet-50 px-1 py-0.5 font-medium text-violet-700">分销商需求</span>{' '}
            <span className="font-medium text-slate-800">
              {demand.carriers}/{demandReachable} 家在卖同类
            </span>
            {demand.priceLow != null ? (
              <span className="text-slate-500">
                {' '}
                · 分销商价格带（不分形态，仅参考）{band(demand.priceLow, demand.priceHigh)}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 space-y-0.5">
            {demand.sources.map((s) => (
              <div key={s.id} className="text-slate-500">
                {s.ok ? (
                  <>
                    <span className="text-slate-600">{s.name}</span> {s.total ?? s.sampleSize} 条
                    {s.matched ? ` · 同类 ${s.matched}` : ' · 无同类'}
                    {s.priceLow != null ? ` · $${s.priceLow}–$${s.priceHigh}` : ''}
                  </>
                ) : (
                  <>
                    <span className="text-slate-600">{s.name}</span>{' '}
                    <span className="text-amber-600">这次没取到</span>
                  </>
                )}
              </div>
            ))}
          </div>
          {demand.sources
            .filter((s) => s.ok && s.samples?.length)
            .slice(0, 2)
            .map((s) => (
              <div key={`${s.id}-samples`} className="mt-1 space-y-0.5">
                {s.samples!.slice(0, 3).map((item, i) => (
                  <CompetitorLine key={i} item={item} />
                ))}
              </div>
            ))}
          <div className="mt-0.5 text-slate-500">{demand.note}</div>
        </div>
      ) : null}

      {/* 4imprint 明细 */}
      <div className="border-t border-slate-100 pt-1.5">
        <span className="rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-600">4imprint</span>{' '}
        <span className="text-slate-700">{formatMarketHits(snap)}</span>
        {band(snap.priceLow, snap.priceHigh, snap.median) ? (
          <span className="text-slate-500"> · list {band(snap.priceLow, snap.priceHigh, snap.median)}</span>
        ) : null}
        {snap.queries?.length ? <span className="text-slate-400"> · 「{snap.queries.join(' / ')}」</span> : null}
      </div>

      {snap.relevanceNote ? <div className="text-amber-700">{snap.relevanceNote}</div> : null}
    </div>
  )
}
