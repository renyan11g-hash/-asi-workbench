import { ExternalLink } from 'lucide-react'

import { formatEspCategories, formatMarketHits } from '@/lib/market-format'

/**
 * 海外同款证据的统一展示块。
 *
 * 两个来源必须分开显示，不能只报一个数：
 *   · ESP（supplier.espwebsite.com）= ASI 旗下 ESP 供应商站群的总目录 → 差异化的主依据
 *   · 4imprint = 单一分销商目录（最多约 28 条）→ 只能说明"这一家切了多少"
 * 早先只显示 4imprint 的"1 条命中"，会被误读成"薄品类、差异化高"。
 */
export interface MarketEvidenceSnap {
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
    fallback?: boolean
    categories?: Array<{ name: string; count: number }>
    relevanceNote?: string
    samples?: Array<{ title: string; priceMin: number; productNo?: string; url?: string }>
  }
}

const comma = (n: number) => Math.round(n).toLocaleString('en-US')

const band = (low?: number | null, high?: number | null, median?: number | null) => {
  if (low == null && high == null) return ''
  const range = `$${low ?? '—'}–$${high ?? '—'}`
  return median != null ? `${range}（中位 $${median}）` : range
}

export function MarketEvidenceBlock({ snap }: { snap: MarketEvidenceSnap }) {
  const esp = snap.esp
  const hasEsp = Boolean(esp && esp.total > 0)
  const noEspMatch = Boolean(esp && esp.total <= 0)
  const cats = formatEspCategories(snap, 4)

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2 text-[11px] leading-relaxed text-slate-600">
      <div className="font-semibold text-slate-700">
        海外同款证据
        <span className="ml-1 font-normal text-slate-400">
          （ESP 看全 ASI 供应商，4imprint 只看一家分销商）
        </span>
      </div>

      {hasEsp && esp ? (
        <div className="mt-1">
          <span className="rounded bg-emerald-50 px-1 py-0.5 font-medium text-emerald-700">ESP · 全 ASI 供应商</span>{' '}
          <span className="font-medium text-slate-800">{comma(esp.total)} 款匹配</span>
          {typeof esp.matchedSample === 'number' && esp.sampleSize ? (
            <span className="text-slate-500">
              {' '}
              · 抽样 {esp.sampleSize} 条里 {esp.matchedSample} 条是同类
            </span>
          ) : null}
          {band(esp.priceLow, esp.priceHigh, esp.median) ? (
            <span className="text-slate-500"> · 样本价 {band(esp.priceLow, esp.priceHigh, esp.median)}</span>
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
          {esp.samples?.length ? (
            <div className="mt-1 space-y-0.5">
              {esp.samples.slice(0, 3).map((s, i) => (
                <div key={i} className="truncate text-slate-500">
                  ·{' '}
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-blue-600"
                    >
                      {s.title}
                      <ExternalLink className="ml-0.5 inline h-2.5 w-2.5" />
                    </a>
                  ) : (
                    s.title
                  )}
                  {s.productNo ? <span className="text-slate-400"> [{s.productNo}]</span> : null} — ${s.priceMin} 起
                </div>
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

      <div className="mt-1">
        <span className="rounded bg-slate-100 px-1 py-0.5 font-medium text-slate-600">4imprint · 单一分销商</span>{' '}
        <span className="text-slate-700">{formatMarketHits(snap)}</span>
        {band(snap.priceLow, snap.priceHigh, snap.median) ? (
          <span className="text-slate-500"> · list {band(snap.priceLow, snap.priceHigh, snap.median)}</span>
        ) : null}
        {snap.queries?.length ? (
          <span className="text-slate-400"> · 「{snap.queries.join(' / ')}」</span>
        ) : null}
      </div>

      {snap.relevanceNote ? <div className="mt-0.5 text-amber-700">{snap.relevanceNote}</div> : null}
    </div>
  )
}
