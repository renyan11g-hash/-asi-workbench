import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, Loader2, RefreshCw, SearchCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { Evaluation, PriceRow, SourceInfo } from '@/types'

interface DraftContent {
  kind?: string
  source?: SourceInfo
  evaluation?: Evaluation | null
  priceGrid?: PriceRow[]
}

interface EvalDraft {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  content?: DraftContent
}

/** 评估库：集中存放「选品评估」页存入的云端草稿（和产品库并列的独立库） */
export default function Evaluations() {
  const navigate = useNavigate()
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['eval-drafts'],
    queryFn: async (): Promise<EvalDraft[]> => {
      const list = await api.listDrafts()
      return Promise.all(
        list.map(async (d) => {
          try {
            const { draft } = await api.getDraft(d.id)
            return { ...d, content: draft.content as DraftContent }
          } catch {
            return { ...d } as EvalDraft
          }
        })
      )
    },
  })

  const drafts = (data ?? []).filter(
    (d) => d.content?.kind === 'sourcing-evaluation' || d.content?.source
  )

  const remove = async (id: string) => {
    setDeletingId(id)
    try {
      await api.deleteDraft(id)
      toast.success('评估草稿已删除')
      void refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="评估库"
        hint="选品评估的云端草稿，换浏览器 / 换电脑都不会丢"
        right={
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isRefetching}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 刷新
          </Button>
        }
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中…
          </div>
        ) : drafts.length === 0 ? (
          <div className="py-12 text-center">
            <FolderOpen className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-600">评估库还是空的</p>
            <p className="mt-1 text-xs text-slate-400">
              在「选品评估」页点「存入评估库」，即可把评估保存到这里
            </p>
            <Button className="mt-4" variant="outline" onClick={() => navigate('/sourcing')}>
              <SearchCheck className="mr-1 h-4 w-4" /> 去做选品评估
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {drafts.map((d) => {
              const src = d.content?.source
              const ev = d.content?.evaluation ?? null
              return (
                <div
                  key={d.id}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-4 transition-colors hover:border-slate-300"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-800">
                          {d.title || '未命名评估'}
                        </span>
                        {ev ? (
                          <VerdictBadge verdict={ev.verdict} score={ev.score} />
                        ) : (
                          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">
                            未生成 AI 评估
                          </span>
                        )}
                      </div>
                      {ev?.summary && (
                        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-slate-600">
                          {ev.summary}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                        <span>更新于 {new Date(d.updatedAt).toLocaleString('zh-CN')}</span>
                        {src?.supplier && <span>供应商：{src.supplier}</span>}
                        {src?.priceCny ? <span>采购价：¥{src.priceCny}</span> : null}
                        {src?.category && <span>类目：{src.category}</span>}
                        {ev?.priceAdviceUsd && (
                          <span>
                            建议售价：${ev.priceAdviceUsd.min}-${ev.priceAdviceUsd.max}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => navigate('/sourcing', { state: { loadDraftId: d.id } })}
                      >
                        载入到选品评估
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        disabled={deletingId === d.id}
                        onClick={() => void remove(d.id)}
                      >
                        {deletingId === d.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
