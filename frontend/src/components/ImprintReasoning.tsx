/**
 * 印刷方式推导视图（对照截图里要求的格式）：
 *   产品 / 材质
 *   适配「牛津布」的工艺（首选）
 *     1. Silkscreen（丝印） 适配：高
 *        为什么 / 操作要点 / 优点 / 注意 / 典型用途
 *   有限适配（视具体情况而定）
 *   不适合本产品的工艺（含原因）
 */
import { Button } from '@/components/ui/button'
import type { ImprintRecommendResult } from '@/types'

export function ImprintReasoning({
  reco,
  title,
  busy = false,
  onLoad,
}: {
  reco: ImprintRecommendResult | null
  title: string
  busy?: boolean
  onLoad: () => void
}) {
  if (!reco) {
    return (
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onLoad} disabled={busy}>
        {busy ? '解读中…' : '按当前材质解读印刷方式'}
      </Button>
    )
  }

  const profOf = (tag: string) =>
    reco.materialProfiles.find((x) => x.name.toLowerCase() === tag.toLowerCase())
  const tags = reco.materialTags.length ? reco.materialTags : reco.materialProfiles.map((x) => x.name)
  const used = new Set<string>()
  const primaryOf = (tag: string) =>
    reco.recommendations.filter((r) => {
      if (r.tier === 'required' || r.tier === 'conditional') return false
      if (!(r.matchedMaterials ?? []).some((m) => m.toLowerCase() === tag.toLowerCase())) return false
      const key = `p:${r.method}`
      if (used.has(key)) return false
      used.add(key)
      return true
    })
  const groups = tags.map((tag) => {
    const prof = profOf(tag)
    return {
      tag,
      label: prof ? `${prof.nameZh}（${prof.name}）` : tag,
      prof,
      list: primaryOf(tag),
    }
  })
  const limited = reco.recommendations.filter((r) => r.tier === 'conditional')
  const adap = (score: number) => (score >= 3 ? '高' : score === 2 ? '中' : '低')

  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-slate-600">
      <div className="rounded bg-white p-2 text-slate-700">
        <div>产品：{title || '（未命名）'}</div>
        <div>
          当前材质：{(reco.inputMaterials?.length ? reco.inputMaterials : groups.map((g) => g.label)).join('、') || '未填写'}
        </div>
        {reco.materialDetected ? (
          <div className="text-slate-500">
            规则识别为：{groups.map((g) => g.label).join('、')}（{reco.families.join('/')}）
          </div>
        ) : (
          <div className="text-amber-700">
            规则表里还没有这个材质，下面按常见促销礼品兜底，务必向工厂确认工艺（换一个 ASI 材质可重新推导）
          </div>
        )}
        {reco.unmappedMaterials?.length ? (
          <div className="text-amber-700">未纳入规则表：{reco.unmappedMaterials.join('、')}</div>
        ) : null}
      </div>

      {groups.map((g) => (
        <div key={g.tag} className="rounded bg-white p-2">
          <div className="font-semibold text-slate-700">适配「{g.prof ? g.prof.nameZh : g.tag}」的工艺（首选）</div>
          {g.prof ? (
            <div className="mt-0.5 text-slate-500">
              这种材质：{g.prof.pros.join('、')}；注意 {g.prof.cons.join('、')}
            </div>
          ) : null}
          {g.list.length === 0 ? (
            <div className="mt-1 text-slate-400">这种材质没有首选工艺，见下方有限适配</div>
          ) : null}
          {g.list.map((r, i) => (
            <div key={r.method} className="mt-1.5 border-t border-slate-100 pt-1.5">
              <div className="font-medium text-slate-700">
                {i + 1}. {r.method}（{r.nameZh}）
                <span className="ml-1 rounded bg-emerald-50 px-1 text-[10px] text-emerald-700">
                  适配：{adap(r.score)}
                </span>
              </div>
              <div className="text-slate-600">{r.why}</div>
              {r.caveat ? <div className="text-sky-700">操作要点：{r.caveat}</div> : null}
              {r.pros?.length ? <div className="text-emerald-700">优点：{r.pros.join('；')}</div> : null}
              {r.cons?.length ? <div className="text-amber-700">注意：{r.cons.join('；')}</div> : null}
              {r.bestFor ? <div className="text-slate-500">典型用途：{r.bestFor}</div> : null}
            </div>
          ))}
        </div>
      ))}

      {limited.length ? (
        <div className="rounded bg-white p-2">
          <div className="font-semibold text-slate-700">有限适配（视具体情况而定）</div>
          {limited.map((r, i) => (
            <div key={r.method} className="mt-1.5 border-t border-slate-100 pt-1.5">
              <div className="font-medium text-slate-700">
                {i + 1}. {r.method}（{r.nameZh}）
                <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700">
                  适配：{adap(r.score)}
                </span>
              </div>
              <div className="text-slate-600">{r.why}</div>
              {r.caveat ? <div className="text-sky-700">操作要点：{r.caveat}</div> : null}
              {r.cons?.length ? <div className="text-amber-700">注意：{r.cons.join('；')}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {reco.excluded?.length ? (
        <div className="rounded bg-rose-50 p-2 text-rose-700">
          <div className="font-semibold">不适合本产品的工艺</div>
          {reco.excluded.map((e) => (
            <div key={e.method}>
              · {e.method}（{e.nameZh}）：{e.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
