import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, MinusCircle, Sparkles, Target, Users } from 'lucide-react'

import { MarketEvidenceBlock } from '@/components/MarketEvidence'
import { VerdictBadge } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'
import type { Evaluation } from '@/types'

/**
 * 选品评估的完整呈现（英文链接编辑页右侧栏 / 评估弹窗共用）。
 *
 * 为什么要抽出来：评估结果里有 15+ 个字段，散在几个页面各写一遍必然会漏字段、口径也会漂。
 * 这里按"业务员真正会看什么"排序：结论 → 分数由哪来 → 市场证据 → 价格建议 →
 * 问题点/改善策略 → 次要信息（买家/场景/类目/主题/印刷/材质）。
 */

function List({
  title,
  items,
  tone = 'text-slate-700',
  icon: Icon,
  empty,
}: {
  title: string
  items?: string[]
  tone?: string
  icon?: typeof CheckCircle2
  empty?: string
}) {
  if (!items?.length) return null
  return (
    <div>
      <div className={cn('mb-1 flex items-center gap-1 text-[11px] font-semibold', tone)}>
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {title}
      </div>
      <ul className="space-y-0.5 text-[11px] leading-relaxed text-slate-600">
        {items.map((it, i) => (
          <li key={i}>· {it}</li>
        ))}
      </ul>
      {empty ? null : null}
    </div>
  )
}

const DIM_LABEL: Array<{ key: keyof NonNullable<Evaluation['scoreBreakdown']>; label: string }> = [
  { key: 'differentiation', label: '差异化' },
  { key: 'customization', label: '定制' },
  { key: 'shipping', label: '物流' },
  { key: 'competition', label: '竞争' },
  { key: 'compliance', label: '合规' },
]

export function EvaluationDetail({
  evaluation,
  headerRight,
}: {
  evaluation: Evaluation
  /** 右上角操作（如「补充信息」按钮） */
  headerRight?: ReactNode
}) {
  const e = evaluation
  const breakdown = e.scoreBreakdown
  const chips = (label: string, values?: string[]) =>
    values?.length ? (
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[11px] text-slate-400">{label}</span>
        {values.map((v, i) => (
          <span key={i} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
            {v}
          </span>
        ))}
      </div>
    ) : null

  return (
    <div className="space-y-3 text-[12px] text-slate-600">
      {/* 结论 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn('text-2xl font-bold', e.score >= 75 ? 'text-emerald-600' : e.score >= 55 ? 'text-amber-600' : 'text-rose-600')}>
            {e.score}
          </span>
          <VerdictBadge verdict={e.verdict} score={e.score} />
        </div>
        {headerRight}
      </div>

      {/* 分数拆解 */}
      {breakdown ? (
        <div className="grid grid-cols-5 gap-1 rounded-md bg-slate-50 p-1.5 text-center">
          {DIM_LABEL.map((d) => (
            <div key={d.key}>
              <div className="text-[10px] text-slate-400">{d.label}</div>
              <div
                className={cn(
                  'text-[12px] font-semibold tabular-nums',
                  breakdown[d.key] < 40 ? 'text-rose-600' : 'text-slate-700'
                )}
              >
                {breakdown[d.key]}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {e.scoreNote ? <div className="text-[10px] leading-relaxed text-slate-500">{e.scoreNote}</div> : null}

      {/* 结论摘要 */}
      {e.summary ? (
        <p className="rounded-md border border-slate-200 bg-white p-2 text-[12px] leading-relaxed text-slate-700">
          {e.summary}
        </p>
      ) : null}

      {/* 建议售价 */}
      {e.priceAdviceUsd && (e.priceAdviceUsd.min > 0 || e.priceAdviceUsd.max > 0) ? (
        <div className="text-[11px]">
          <span className="text-slate-400">建议报价 </span>
          <span className="font-semibold text-slate-800">
            ${e.priceAdviceUsd.min} – ${e.priceAdviceUsd.max}
          </span>
        </div>
      ) : null}

      {/* 海外同款证据（ESP 供给 / 分销商需求 / 4imprint） */}
      {e.marketSnapshot ? <MarketEvidenceBlock snap={e.marketSnapshot} /> : null}
      {!e.marketSnapshot && e.marketError ? (
        <div className="text-[11px] text-amber-700">海外同款没取到：{e.marketError}</div>
      ) : null}

      <List title="为什么值得做" items={e.pros} tone="text-emerald-700" icon={CheckCircle2} />
      <List title="短板" items={e.cons} tone="text-amber-700" icon={MinusCircle} />
      <List title="风险" items={e.risks} tone="text-rose-700" icon={AlertTriangle} />
      <List title="问题点" items={e.issues} tone="text-rose-700" icon={AlertTriangle} />
      <List title="改善建议" items={e.suggestions} tone="text-blue-700" icon={Sparkles} />
      <List title="Listing 卖点钩子" items={e.listingHooks} tone="text-slate-700" icon={Target} />

      {/* 画像类信息默认折叠，避免右栏太长 */}
      {e.buyers?.length || e.occasions?.length || e.channels?.length ? (
        <details className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
            买家 / 场景 / 渠道
          </summary>
          <div className="mt-1.5 space-y-1.5">
            <List title="目标买家" items={e.buyers} tone="text-slate-600" icon={Users} />
            <List title="适用场景" items={e.occasions} tone="text-slate-600" />
            <List title="建议渠道" items={e.channels} tone="text-slate-600" />
          </div>
        </details>
      ) : null}

      {e.asiCategories?.length ||
      e.suggestedThemes?.length ||
      e.suggestedImprintMethods?.length ||
      e.suggestedMaterial ||
      e.sourcingTips ? (
        <details className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
            类目 / 主题 / 印刷 / 采购建议
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {chips('ASI 类目', e.asiCategories)}
            {chips('主题', e.suggestedThemes)}
            {chips('印刷方式', e.suggestedImprintMethods)}
            {e.suggestedMaterial ? (
              <div className="text-[11px]">
                <span className="text-slate-400">材质 </span>
                <span className="text-slate-600">{e.suggestedMaterial}</span>
              </div>
            ) : null}
            {e.sourcingTips ? (
              <div className="text-[11px] leading-relaxed">
                <span className="text-slate-400">采购建议 </span>
                <span className="text-slate-600">{e.sourcingTips}</span>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}

      {e.evaluatedAt ? (
        <div className="text-[10px] text-slate-400">
          评估于 {new Date(e.evaluatedAt).toLocaleString('zh-CN')}
        </div>
      ) : null}
    </div>
  )
}
