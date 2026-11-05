import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ClipboardPaste,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { SectionCard, VerdictBadge } from '@/components/ui/primitives'
import { api, getErrorMessage } from '@/lib/api'
import { BatchItem, BatchItemStatus, BatchJob, BatchJobStatus, BatchOptions } from '@/types'

const JOB_KEY = 'asi-batch:jobId'

const ITEM_STATUS: Record<BatchItemStatus, { label: string; cls: string }> = {
  pending: { label: '等待', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  fetching: { label: '抓取中', cls: 'bg-sky-100 text-sky-700 border-sky-200' },
  evaluating: { label: '评估中', cls: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  saving: { label: '入库中', cls: 'bg-violet-100 text-violet-700 border-violet-200' },
  listing: { label: '生成链接', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  done: { label: '完成', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  error: { label: '失败', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
  skipped: { label: '跳过', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
}

const JOB_STATUS: Record<BatchJobStatus, { label: string; cls: string }> = {
  pending: { label: '排队中', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  running: { label: '处理中', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  done: { label: '已完成', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  cancelled: { label: '已停止', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  interrupted: { label: '已中断', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
}

const DEFAULT_OPTIONS: BatchOptions = {
  fetch: true,
  evaluate: true,
  save: true,
  listing: false,
}

const SAMPLE = `https://detail.1688.com/offer/123456789.html
https://detail.1688.com/offer/123456790.html	折叠收纳盒	3.5	100	20x15x8cm	PU皮
折叠收纳盒（无链接手动录入）	5.2	200	22x16x9cm	牛津布	黑/灰`

/**
 * 批量处理：一次粘贴多条产品 → 后台逐条跑「抓取 → 评估 → 入库 → 生成 listing」。
 *
 * 刻意不在这里做任何新的业务判断：每一步都调用单品流程的服务端函数，
 * 所以评分/印刷方式/报价/市场探针与单品完全一致，这里只负责排队和展示进度。
 */
export default function Batch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [options, setOptions] = useState<BatchOptions>(DEFAULT_OPTIONS)
  const [creating, setCreating] = useState(false)
  const [job, setJob] = useState<BatchJob | null>(null)
  const [jobId, setJobId] = useState<string | null>(() => localStorage.getItem(JOB_KEY))
  const [nonce, setNonce] = useState(0)
  const [recent, setRecent] = useState<
    Array<{ id: string; status: BatchJobStatus; note: string; total: number; done: number; failed: number; createdAt: string }>
  >([])
  const stopRef = useRef(false)

  const loadRecent = useCallback(async () => {
    try {
      const r = await api.listBatchJobs()
      setRecent(r.jobs)
    } catch {
      /* 历史任务拉不到不影响主流程 */
    }
  }, [])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  // 轮询：只要任务还在跑就每 2.5 秒刷新一次进度（顺手把服务端保活，避免免费层休眠）
  useEffect(() => {
    if (!jobId) return
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      if (!alive) return
      try {
        const j = await api.getBatchJob(jobId)
        if (!alive) return
        setJob(j)
        if (j.status === 'running' || j.status === 'pending') {
          timer = window.setTimeout(tick, 2500)
        } else {
          void loadRecent()
        }
      } catch (err) {
        if (!alive) return
        const msg = getErrorMessage(err)
        if (/不存在/.test(msg)) {
          setJob(null)
          setJobId(null)
          localStorage.removeItem(JOB_KEY)
          return
        }
        timer = window.setTimeout(tick, 4000)
      }
    }
    void tick()
    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [jobId, nonce, loadRecent])

  const start = async () => {
    if (!text.trim()) {
      toast.error('先把产品链接粘贴进来')
      return
    }
    if (!options.fetch && !options.evaluate && !options.save && !options.listing) {
      toast.error('至少要选一个处理步骤')
      return
    }
    setCreating(true)
    try {
      const r = await api.createBatchJob({ text, options })
      setJob(r.job)
      setJobId(r.job.id)
      localStorage.setItem(JOB_KEY, r.job.id)
      setNonce((n) => n + 1)
      void loadRecent()
      const total = r.job.items.length
      toast.success(
        `已开始处理 ${total} 条${r.skipped ? `（${r.skipped} 行已跳过）` : ''}，关掉页面也会继续跑`
      )
      if (r.truncated) toast.warning(`一次最多处理 50 条，超出部分没有提交`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const stop = async () => {
    if (!jobId) return
    stopRef.current = true
    try {
      const j = await api.cancelBatchJob(jobId)
      setJob(j)
      setNonce((n) => n + 1)
      toast.success('已发送停止指令：正在跑的这一条结束后就停')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      stopRef.current = false
    }
  }

  const retry = async () => {
    if (!jobId) return
    try {
      const j = await api.retryBatchJob(jobId)
      setJob(j)
      setNonce((n) => n + 1)
      toast.success('已重新排队失败的条目')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const openJob = (id: string) => {
    setJobId(id)
    setJob(null)
    localStorage.setItem(JOB_KEY, id)
    setNonce((n) => n + 1)
  }

  const items = job?.items ?? []
  const stats = useMemo(() => {
    const total = items.length
    const done = items.filter((i) => i.status === 'done').length
    const failed = items.filter((i) => i.status === 'error').length
    const finished = done + failed
    const running = items.find((i) => ['fetching', 'evaluating', 'saving', 'listing'].includes(i.status))
    return {
      total,
      done,
      failed,
      finished,
      pct: total ? Math.round((finished / total) * 100) : 0,
      running,
    }
  }, [items])

  const isRunning = job?.status === 'running' || job?.status === 'pending'

  /** 粗估耗时：抓取约 15 秒、评估约 35 秒、listing 约 60 秒 */
  const estimateMin = useMemo(() => {
    const perItem =
      (options.fetch ? 15 : 0) + (options.evaluate ? 35 : 0) + (options.listing ? 60 : 0) + 5
    const n = Math.max(1, text.split('\n').filter((l) => l.trim()).length)
    return Math.ceil((perItem * n) / 60)
  }, [options, text])

  const exportCsv = () => {
    if (!items.length) return
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const head = ['序号', '标题', '链接', '状态', '评分', '结论', '海外同款', '产品ID', '错误']
    const lines = [head.map(esc).join(',')]
    for (const it of items) {
      lines.push(
        [
          it.idx,
          it.title ?? '',
          it.url,
          ITEM_STATUS[it.status]?.label ?? it.status,
          it.score ?? '',
          it.verdict ?? '',
          it.marketNote ?? '',
          it.productId ?? '',
          it.error ?? '',
        ]
          .map(esc)
          .join(',')
      )
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `batch-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const failedItems = items.filter((i) => i.status === 'error')

  return (
    <div className="space-y-4">
      {/* ① 输入 */}
      <SectionCard
        title="① 批量输入产品"
        hint="每行一个产品。只粘贴 1688 链接就能跑；从 Excel 复制多列也行（顺序：链接 / 标题 / 采购价 / MOQ / 尺寸 / 材质 / 颜色 / 备注），第一行有表头会自动识别"
        right={
          <Badge variant="outline" className="border-slate-200 bg-slate-50 text-slate-600">
            {text.split('\n').filter((l) => l.trim()).length} 行
          </Badge>
        }
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          spellCheck={false}
          placeholder={`把 1688 商品链接一行一个粘进来，例如：\n${SAMPLE}`}
          className="w-full resize-y rounded-lg border border-slate-200 bg-slate-50/60 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none focus:border-blue-400 focus:bg-white"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
            <ClipboardPaste className="mr-1 h-3.5 w-3.5" /> 填入示例
          </Button>
          {text.trim() && (
            <Button variant="ghost" size="sm" className="text-slate-500" onClick={() => setText('')}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> 清空
            </Button>
          )}
          <span className="text-[11px] text-slate-400">
            以 # 开头的行会被当注释忽略；同一批里重复的链接只跑一次；单批最多 50 条
          </span>
        </div>
      </SectionCard>

      {/* ② 步骤 */}
      <SectionCard
        title="② 选择处理步骤"
        hint="每一步用的都是单品流程的同一个函数，评分口径、印刷方式规则、报价算法、海外市场探针完全一致，只是把点击换成了排队"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <OptionRow
            checked={options.fetch}
            onChange={(v) => setOptions((o) => ({ ...o, fetch: v }))}
            title="抓取 1688 详情"
            desc="标题 / 描述 / 材质 / 颜色 / 尺寸 / 箱规 / 首图。反爬失败时用你手填的资料继续"
          />
          <OptionRow
            checked={options.evaluate}
            onChange={(v) => setOptions((o) => ({ ...o, evaluate: v }))}
            title="AI 评估"
            desc="评分 + 结论 + 海外同款比价 + 阶梯报价，并写入「历史选品」"
          />
          <OptionRow
            checked={options.save}
            onChange={(v) => setOptions((o) => ({ ...o, save: v }))}
            title="保存到产品库"
            desc="与单品「保存到产品库」同一段入库逻辑，保存后可直接去生成链接"
          />
          <OptionRow
            checked={options.listing}
            onChange={(v) => setOptions((o) => ({ ...o, listing: v || options.listing, save: v ? true : options.save }))}
            title="生成英文 listing"
            desc="较慢（每条多约 1 分钟）。勾选后会自动入库，跑完即可在链接生成页微调"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <Button onClick={() => void start()} disabled={creating || isRunning}>
            {creating ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            开始批量处理
          </Button>
          {isRunning && (
            <Button variant="outline" onClick={() => void stop()} disabled={stopRef.current}>
              <Square className="mr-1.5 h-3.5 w-3.5" /> 停止（当前这条跑完就停）
            </Button>
          )}
          <span className="text-[11px] text-slate-500">
            按当前选择粗估约 {estimateMin} 分钟；一次提交后即使关掉页面，服务端也会继续跑到底
          </span>
        </div>
      </SectionCard>

      {/* ③ 进度 */}
      {job && (
        <SectionCard
          title="③ 处理进度"
          hint={
            job.status === 'running'
              ? stats.running
                ? `第 ${stats.running.idx} 条：${stats.running.stage}`
                : '准备中…'
              : `任务 ${JOB_STATUS[job.status]?.label ?? job.status} · ${job.note}`
          }
          right={
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={JOB_STATUS[job.status]?.cls}>
                {JOB_STATUS[job.status]?.label ?? job.status}
              </Badge>
              {failedItems.length > 0 && !isRunning && (
                <Button size="sm" variant="outline" onClick={() => void retry()}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重试失败项（{failedItems.length}）
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={exportCsv} disabled={!items.length}>
                <Download className="mr-1 h-3.5 w-3.5" /> 导出结果
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-700">
              完成 <span className="font-semibold text-emerald-600">{stats.done}</span> / {stats.total}
              {stats.failed > 0 && (
                <>
                  {' · '}
                  失败 <span className="font-semibold text-rose-600">{stats.failed}</span>
                </>
              )}
            </div>
            <div className="text-[11px] text-slate-400">
              开始于 {new Date(job.createdAt).toLocaleString('zh-CN')}
            </div>
          </div>
          <Progress value={stats.pct} className="mt-2 h-2" />

          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-[12px]">
              <thead className="text-[11px] text-slate-400">
                <tr className="border-b border-slate-100">
                  <th className="py-2 pr-2 font-medium">#</th>
                  <th className="py-2 pr-2 font-medium">产品</th>
                  <th className="py-2 pr-2 font-medium">状态</th>
                  <th className="py-2 pr-2 font-medium">评分</th>
                  <th className="py-2 pr-2 font-medium">结果 / 提示</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <ItemRow key={it.idx} item={it} onOpen={() => it.productId && navigate(`/listing/${it.productId}`)} />
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* ④ 历史 */}
      {recent.length > 0 && (
        <SectionCard title="最近任务" hint="任务存在云库里，换浏览器/刷新页面都能接着看">
          <div className="divide-y divide-slate-100">
            {recent.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className={JOB_STATUS[j.status]?.cls}>
                    {JOB_STATUS[j.status]?.label ?? j.status}
                  </Badge>
                  <span className="truncate text-[12px] text-slate-700">
                    完成 {j.done}/{j.total}
                    {j.failed > 0 ? ` · 失败 ${j.failed}` : ''} · {j.note}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {new Date(j.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openJob(j.id)}>
                  查看
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {!job && recent.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
          <Layers className="mx-auto h-9 w-9 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-600">还没有批量任务</p>
          <p className="mt-1 text-xs text-slate-400">
            上面粘一批 1688 链接，选好步骤点「开始批量处理」即可
          </p>
        </div>
      )}
    </div>
  )
}

function OptionRow({
  checked,
  onChange,
  title,
  desc,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  desc: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50/50 p-3 transition-colors hover:border-slate-300">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-slate-800">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{desc}</span>
      </span>
    </label>
  )
}

function ItemRow({ item, onOpen }: { item: BatchItem; onOpen: () => void }) {
  const meta = ITEM_STATUS[item.status] ?? ITEM_STATUS.pending
  const active = ['fetching', 'evaluating', 'saving', 'listing'].includes(item.status)
  return (
    <tr className="border-b border-slate-50 align-top">
      <td className="py-2 pr-2 text-slate-400">{item.idx}</td>
      <td className="max-w-[280px] py-2 pr-2">
        <div className="truncate font-medium text-slate-800" title={item.title ?? item.url}>
          {item.title || item.url || '（手动录入）'}
        </div>
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-[11px] text-blue-600 hover:underline"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">{item.url.replace(/^https?:\/\//, '')}</span>
          </a>
        )}
      </td>
      <td className="py-2 pr-2">
        <Badge variant="outline" className={meta.cls}>
          {active && <Loader2 className="mr-0.5 h-3 w-3 animate-spin" />}
          {meta.label}
        </Badge>
      </td>
      <td className="py-2 pr-2">
        {typeof item.score === 'number' ? (
          <VerdictBadge verdict={(item.verdict as 'GO' | 'MAYBE' | 'NO' | null) ?? null} score={item.score} />
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="max-w-[320px] py-2 pr-2">
        <div className="text-[11px] text-slate-500">{item.stage}</div>
        {item.marketNote && <div className="mt-0.5 text-[11px] text-slate-500">{item.marketNote}</div>}
        {item.warn && (
          <div className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-600">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{item.warn}</span>
          </div>
        )}
        {item.error && (
          <div className="mt-0.5 text-[11px] leading-relaxed text-rose-600">{item.error}</div>
        )}
      </td>
      <td className="py-2">
        {item.productId ? (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onOpen}>
            生成链接
          </Button>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
    </tr>
  )
}
