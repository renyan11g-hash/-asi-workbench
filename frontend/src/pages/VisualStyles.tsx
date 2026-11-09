import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ImagePlus,
  Loader2,
  Link2,
  RefreshCw,
  Sparkles,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VisualRef, VisualStyle } from '@/types'

/**
 * 视觉风格中心。
 *
 * 三件事：
 *   1. 视觉参考库：上传 / 导 URL / 从历史生成图收藏，分类、收藏、启停、优秀或不合格、备注。
 *   2. 风格配置：AI 看参考图提炼结构化 Visual Style Profile（可人工改），出图时自动注入。
 *   3. 反馈：满意/不满意的原因汇总，用来持续改风格。
 *
 * 设计原则：日常出图不需要来这里；这里是「偶尔调教一次、长期复用」的后台。
 */

const CATEGORY_OPTIONS = [
  { key: 'main', label: '主图' },
  { key: 'showcase', label: '产品展示图' },
  { key: 'detail', label: '细节图' },
  { key: 'dimension', label: '尺寸信息图' },
  { key: 'scene', label: '场景图' },
] as const

const PROFILE_FIELDS: Array<{ key: keyof VisualStyle['profile']; label: string; hint: string }> = [
  { key: 'summary', label: '风格一句话', hint: '例如：纯白极简、柔光、产品占比 60%' },
  { key: 'composition', label: '构图方式', hint: '居中 / 三分 / 对角…' },
  { key: 'productCoverage', label: '产品主体占比', hint: '例如：画面高度 55-65%' },
  { key: 'background', label: '背景类型', hint: '纯白 / 浅灰 / 场景' },
  { key: 'lighting', label: '光影', hint: '柔光箱 / 自然光 / 高调' },
  { key: 'shadow', label: '阴影', hint: '轻度接触阴影 / 无阴影' },
  { key: 'whitespace', label: '留白', hint: '四周留白比例' },
  { key: 'layout', label: '排版布局', hint: '主产品 + 小图 / 单主体' },
  { key: 'palette', label: '色彩搭配', hint: '整体色调' },
  { key: 'texture', label: '材质质感表现', hint: '写实 / 高光处理' },
  { key: 'angle', label: '拍摄角度', hint: '平视 / 45° / 俯拍' },
  { key: 'depthOfField', label: '景深', hint: '深景深 / 浅景深' },
  { key: 'scene', label: '场景设计', hint: '办公室 / 展会 / 户外' },
  { key: 'typography', label: '字体和图标风格', hint: '无文字 / 极简无衬线' },
]

type Tab = 'refs' | 'styles' | 'feedback'

export default function VisualStyles() {
  const [tab, setTab] = useState<Tab>('refs')
  const [loading, setLoading] = useState(true)
  const [refs, setRefs] = useState<VisualRef[]>([])
  const [styles, setStyles] = useState<VisualStyle[]>([])
  const [feedback, setFeedback] = useState<{
    total: number
    likes: number
    dislikes: number
    reasons: Array<{ key: string; count: number }>
  } | null>(null)
  const [meta, setMeta] = useState<{
    categories: Array<{ key: string; label: string }>
    feedbackReasons: Array<{ key: string; label: string }>
  }>({ categories: [], feedbackReasons: [] })

  const [filterCategory, setFilterCategory] = useState('')
  const [filterVerdict, setFilterVerdict] = useState('')
  const [busy, setBusy] = useState<'upload' | 'learn' | 'refresh' | null>(null)

  // 上传 / 导入
  const [urlInput, setUrlInput] = useState('')
  const [showCandidates, setShowCandidates] = useState(false)
  const [candidates, setCandidates] = useState<
    Array<{
      productId: string
      productCode: string
      sourceTitle: string
      imageId: string
      kind: string
      url: string
      createdAt: string
      collectedRefId: string | null
    }>
  >([])

  // 风格学习弹窗
  const [learnOpen, setLearnOpen] = useState(false)
  const [learnForm, setLearnForm] = useState<{
    name: string
    category: string
    scope: 'global' | 'category'
    refIds: string[]
    note: string
    styleId?: string
  }>({ name: 'ASI 简约商业风', category: '', scope: 'global', refIds: [], note: '' })
  const [editingStyle, setEditingStyle] = useState<VisualStyle | null>(null)
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({})
  const [promptDraft, setPromptDraft] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r, s, f] = await Promise.all([
        api.listVisualRefs({ limit: 300 }),
        api.listVisualStyles(),
        api.getFeedbackSummary(),
      ])
      setRefs(r)
      setStyles(s)
      setFeedback(f)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void api
      .getVisualMeta()
      .then(setMeta)
      .catch(() => {
        /* meta 失败不影响主流程 */
      })
  }, [load])

  const filteredRefs = useMemo(() => {
    return refs.filter((r) => {
      if (filterCategory && r.category !== filterCategory) return false
      if (filterVerdict && r.verdict !== filterVerdict) return false
      return true
    })
  }, [refs, filterCategory, filterVerdict])

  const labelOfReason = (key: string) => meta.feedbackReasons.find((r) => r.key === key)?.label ?? key

  /** 读文件 → dataURL（一张一张传，避免一次 body 过大） */
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy('upload')
    let ok = 0
    for (const file of Array.from(files).slice(0, 12)) {
      if (!file.type.startsWith('image/')) continue
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.readAsDataURL(file)
      })
      if (!dataUrl.startsWith('data:image/')) continue
      try {
        await api.addVisualRef({
          dataUrl,
          category: filterCategory || 'showcase',
          title: file.name.slice(0, 60),
          origin: 'upload',
          favorite: true,
        })
        ok++
      } catch (err) {
        toast.error(`${file.name}：${getErrorMessage(err)}`)
      }
    }
    setBusy(null)
    if (ok) toast.success(`已加入参考库 ${ok} 张`)
    void load()
  }

  const importUrl = async () => {
    const url = urlInput.trim()
    if (!/^https?:\/\//i.test(url)) {
      toast.error('要填 http(s):// 开头的图片地址')
      return
    }
    setBusy('upload')
    try {
      await api.addVisualRef({
        url,
        category: filterCategory || 'showcase',
        origin: 'url',
        sourceUrl: url,
      })
      setUrlInput('')
      toast.success('已导入参考图')
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const openCandidates = async () => {
    setShowCandidates(true)
    try {
      setCandidates(await api.listGeneratedCandidates(40))
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const collect = async (productId: string, imageId: string) => {
    try {
      await api.collectGeneratedRef({ productId, imageId, verdict: 'good' })
      toast.success('已收藏进优秀作品库')
      await openCandidates()
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const patchRef = async (id: string, patch: Parameters<typeof api.updateVisualRef>[1]) => {
    try {
      const next = await api.updateVisualRef(id, patch)
      setRefs((cur) => cur.map((r) => (r.id === id ? next : r)))
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const removeRef = async (id: string) => {
    if (!window.confirm('从视觉参考库删除这张图？风格配置里引用它的地方会少一张参考。')) return
    try {
      await api.deleteVisualRef(id)
      setRefs((cur) => cur.filter((r) => r.id !== id))
      toast.success('已删除')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const openLearn = (style?: VisualStyle) => {
    setLearnForm({
      name: style?.name ?? 'ASI 简约商业风',
      category: style?.category ?? '',
      scope: style?.scope ?? 'global',
      refIds: style?.refIds ?? refs.filter((r) => r.status === 'active' && r.favorite).slice(0, 6).map((r) => r.id),
      note: style?.note ?? '',
      styleId: style?.id,
    })
    setLearnOpen(true)
  }

  const runLearn = async () => {
    if (!learnForm.name.trim()) {
      toast.error('给这条风格起个名字')
      return
    }
    if (!learnForm.refIds.length) {
      toast.error('至少选 1 张参考图（建议 3-6 张优秀作品）')
      return
    }
    setBusy('learn')
    try {
      await api.learnVisualStyle({
        name: learnForm.name.trim(),
        styleId: learnForm.styleId,
        category: learnForm.category.trim(),
        scope: learnForm.scope,
        refIds: learnForm.refIds,
        note: learnForm.note.trim() || undefined,
      })
      setLearnOpen(false)
      toast.success('风格已学习并保存，之后出图会自动套用')
      setTab('styles')
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const openEdit = (style: VisualStyle) => {
    setEditingStyle(style)
    const draft: Record<string, string> = {}
    for (const f of PROFILE_FIELDS) {
      const v = style.profile[f.key]
      draft[f.key] = Array.isArray(v) ? v.join('、') : String(v ?? '')
    }
    setProfileDraft(draft)
    setPromptDraft(style.promptBlock || style.profile.promptBlock || '')
  }

  const saveEdit = async () => {
    if (!editingStyle) return
    const profile: Record<string, string | string[]> = {}
    for (const f of PROFILE_FIELDS) {
      const v = (profileDraft[f.key] ?? '').trim()
      profile[f.key] = f.key === 'categoryFit' ? v.split(/[,，、/]/).map((x) => x.trim()).filter(Boolean) : v
    }
    try {
      const next = await api.updateVisualStyle(editingStyle.id, {
        profile: profile as Partial<VisualStyle['profile']>,
        promptBlock: promptDraft.trim(),
      })
      setStyles((cur) => cur.map((s) => (s.id === next.id ? next : s)))
      setEditingStyle(null)
      toast.success('风格配置已保存')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">视觉风格中心</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            参考图和风格配置长期保存；出图时自动匹配，不用每个产品重新找参考图、重写提示词。
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            刷新
          </Button>
          <Button size="sm" onClick={() => openLearn()}>
            <Wand2 className="mr-1 h-3.5 w-3.5" /> AI 学习新风格
          </Button>
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-[12px]">
        {(
          [
            ['refs', `参考图库 ${refs.length}`],
            ['styles', `风格配置 ${styles.length}`],
            ['feedback', '反馈汇总'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'rounded-md px-3 py-1.5 transition-colors',
              tab === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'refs' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5">
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="h-8 rounded border border-slate-200 px-2 text-[12px]"
            >
              <option value="">全部分类</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={filterVerdict}
              onChange={(e) => setFilterVerdict(e.target.value)}
              className="h-8 rounded border border-slate-200 px-2 text-[12px]"
            >
              <option value="">全部作品</option>
              <option value="good">优秀作品</option>
              <option value="bad">不合格案例</option>
            </select>
            <span className="text-[11px] text-slate-400">{filteredRefs.length} 张</span>

            <label className="ml-auto cursor-pointer">
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void uploadFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <span className="inline-flex h-8 items-center rounded-md bg-slate-900 px-2.5 text-[12px] text-white hover:bg-slate-800">
                {busy === 'upload' ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="mr-1 h-3.5 w-3.5" />
                )}
                上传参考图
              </span>
            </label>
            <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={() => void openCandidates()}>
              <Star className="mr-1 h-3.5 w-3.5" /> 从生成图收藏
            </Button>
          </div>

          <div className="flex gap-1.5">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="粘贴美国 ASI 同行产品页的图片地址（http(s)://…，只导可访问、允许使用的图）"
              className="h-8 flex-1 rounded border border-slate-200 px-2 text-[12px] outline-none focus:border-blue-400"
            />
            <Button size="sm" variant="outline" className="h-8" disabled={busy === 'upload'} onClick={() => void importUrl()}>
              <Link2 className="mr-1 h-3.5 w-3.5" /> 导入
            </Button>
          </div>

          {showCandidates && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-semibold text-slate-800">最近生成的图片（直接收藏，不用重新上传）</div>
                <button className="text-slate-400 hover:text-slate-600" onClick={() => setShowCandidates(false)}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              {candidates.length === 0 ? (
                <div className="py-6 text-center text-[12px] text-slate-400">还没有生成过图片</div>
              ) : (
                <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
                  {candidates.map((c) => (
                    <div key={c.imageId} className="rounded-lg border border-slate-200 p-1">
                      <img src={c.url} alt="" className="aspect-square w-full rounded object-cover" />
                      <div className="mt-1 truncate text-[10px] text-slate-500">{c.productCode || c.sourceTitle}</div>
                      {c.collectedRefId ? (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
                          <Check className="h-3 w-3" /> 已收藏
                        </span>
                      ) : (
                        <button
                          className="mt-0.5 text-[10px] text-blue-600 hover:underline"
                          onClick={() => void collect(c.productId, c.imageId)}
                        >
                          收藏为优秀作品
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {filteredRefs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center text-[12px] text-slate-400">
              还没有参考图：上传几张美国 ASI 同行的优秀图，或从历史生成图收藏
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {filteredRefs.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'rounded-xl border bg-white p-2',
                    r.status === 'inactive' ? 'border-slate-200 opacity-55' : 'border-slate-200'
                  )}
                >
                  <div className="relative">
                    <img src={r.url} alt="" className="aspect-square w-full rounded-lg border border-slate-100 object-cover" />
                    <button
                      className={cn(
                        'absolute right-1 top-1 rounded-full bg-white/90 p-0.5 shadow',
                        r.favorite ? 'text-amber-500' : 'text-slate-400'
                      )}
                      title={r.favorite ? '取消收藏' : '收藏'}
                      onClick={() => void patchRef(r.id, { favorite: !r.favorite })}
                    >
                      <Star className={cn('h-3.5 w-3.5', r.favorite && 'fill-amber-400')} />
                    </button>
                    {r.verdict === 'good' && (
                      <span className="absolute left-1 top-1 rounded bg-emerald-600/90 px-1 text-[10px] text-white">优秀</span>
                    )}
                    {r.verdict === 'bad' && (
                      <span className="absolute left-1 top-1 rounded bg-rose-600/90 px-1 text-[10px] text-white">不合格</span>
                    )}
                  </div>

                  <div className="mt-1.5 flex items-center gap-1">
                    <select
                      value={r.category}
                      onChange={(e) => void patchRef(r.id, { category: e.target.value })}
                      className="h-6 flex-1 rounded border border-slate-200 px-1 text-[11px]"
                    >
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <button
                      className="rounded border border-slate-200 px-1 text-[10px] text-slate-500 hover:text-slate-800"
                      onClick={() => void patchRef(r.id, { verdict: r.verdict === 'good' ? 'ok' : 'good' })}
                      title="标记优秀作品"
                    >
                      <ThumbsUp className="h-3 w-3" />
                    </button>
                    <button
                      className="rounded border border-slate-200 px-1 text-[10px] text-slate-500 hover:text-rose-600"
                      onClick={() => void patchRef(r.id, { verdict: r.verdict === 'bad' ? 'ok' : 'bad' })}
                      title="标记不合格案例"
                    >
                      <ThumbsDown className="h-3 w-3" />
                    </button>
                  </div>

                  <input
                    defaultValue={r.note}
                    placeholder="备注：为什么好 / 差在哪"
                    className="mt-1 h-6 w-full rounded border border-slate-200 px-1 text-[11px] outline-none focus:border-blue-400"
                    onBlur={(e) => {
                      if (e.target.value !== r.note) void patchRef(r.id, { note: e.target.value })
                    }}
                  />

                  <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
                    <button
                      className="hover:text-slate-700"
                      onClick={() => void patchRef(r.id, { status: r.status === 'active' ? 'inactive' : 'active' })}
                    >
                      {r.status === 'active' ? '已启用' : '已停用'}
                    </button>
                    <span className="truncate">
                      {r.origin === 'generated' ? '历史生成' : r.origin === 'url' ? '同行导入' : '上传'}
                    </span>
                    <button className="hover:text-rose-600" onClick={() => void removeRef(r.id)} title="删除">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'styles' && (
        <div className="space-y-3">
          {styles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center text-[12px] text-slate-400">
              还没有风格配置：先收藏几张优秀参考图，再点右上角「AI 学习新风格」
            </div>
          ) : (
            styles.map((s) => (
              <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-semibold text-slate-900">{s.name}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">v{s.version}</span>
                  {s.isDefault && (
                    <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">默认风格</span>
                  )}
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      s.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                    )}
                  >
                    {s.status === 'active' ? '生效中' : '已停用'}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {s.refCount} 张参考图 · {s.category || '全品类'}
                  </span>
                  <div className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openEdit(s)}>
                      查看/修改
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openLearn(s)}>
                      <Wand2 className="mr-1 h-3 w-3" /> 重新学习
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px]"
                      onClick={async () => {
                        try {
                          const next = await api.updateVisualStyle(s.id, { isDefault: true })
                          setStyles((cur) => cur.map((x) => (x.id === next.id ? next : { ...x, isDefault: false })))
                          toast.success(`「${s.name}」设为默认风格`)
                        } catch (err) {
                          toast.error(getErrorMessage(err))
                        }
                      }}
                    >
                      设为默认
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={async () => {
                        try {
                          const next = await api.updateVisualStyle(s.id, {
                            status: s.status === 'active' ? 'inactive' : 'active',
                          })
                          setStyles((cur) => cur.map((x) => (x.id === next.id ? next : x)))
                        } catch (err) {
                          toast.error(getErrorMessage(err))
                        }
                      }}
                    >
                      {s.status === 'active' ? '停用' : '启用'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] text-rose-600"
                      onClick={async () => {
                        if (!window.confirm(`删除风格「${s.name}」？参考图不会被删除。`)) return
                        try {
                          await api.deleteVisualStyle(s.id)
                          setStyles((cur) => cur.filter((x) => x.id !== s.id))
                        } catch (err) {
                          toast.error(getErrorMessage(err))
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                <div className="mt-2 grid gap-x-4 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
                  {s.profile.summary && <div className="sm:col-span-2 lg:col-span-3 text-slate-800">{s.profile.summary}</div>}
                  {PROFILE_FIELDS.filter((f) => f.key !== 'summary')
                    .map((f) => {
                      const v = s.profile[f.key]
                      const text = Array.isArray(v) ? v.join('、') : v
                      return text ? (
                        <div key={f.key} className="truncate" title={String(text)}>
                          <span className="text-slate-400">{f.label}：</span>
                          {text}
                        </div>
                      ) : null
                    })}
                </div>
                {s.promptBlock && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-slate-400">查看注入出图的英文风格指令</summary>
                    <div className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-600">
                      {s.promptBlock}
                    </div>
                  </details>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'feedback' && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[11px] text-slate-500">累计反馈</div>
              <div className="text-xl font-semibold text-slate-900">{feedback?.total ?? 0}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[11px] text-slate-500">满意</div>
              <div className="text-xl font-semibold text-emerald-600">{feedback?.likes ?? 0}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[11px] text-slate-500">不满意</div>
              <div className="text-xl font-semibold text-rose-600">{feedback?.dislikes ?? 0}</div>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-[13px] font-semibold text-slate-800">不满意原因排行（用来改风格配置）</div>
            {(feedback?.reasons.length ?? 0) === 0 ? (
              <div className="py-6 text-center text-[12px] text-slate-400">还没有反馈。生成图片后点「不满意」并选原因。</div>
            ) : (
              <div className="mt-2 space-y-1.5">
                {feedback?.reasons.map((r) => {
                  const max = Math.max(...(feedback.reasons.map((x) => x.count) ?? [1]))
                  return (
                    <div key={r.key} className="flex items-center gap-2 text-[12px]">
                      <span className="w-24 shrink-0 text-slate-600">{labelOfReason(r.key)}</span>
                      <div className="h-2 flex-1 rounded bg-slate-100">
                        <div className="h-2 rounded bg-rose-400" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
                      </div>
                      <span className="w-6 text-right text-slate-500">{r.count}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-800">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            反馈只用来改进「怎么拍」；某张图被认可，不会把那张图里的产品结构、颜色或配件套到其他产品上。
          </div>
        </div>
      )}

      {/* AI 学习风格弹窗 */}
      {learnOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setLearnOpen(false)}>
          <div
            className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-slate-800">
                {learnForm.styleId ? '重新学习风格' : 'AI 学习新风格'}
              </div>
              <button onClick={() => setLearnOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-[12px]">
                  <span className="text-slate-500">风格名称</span>
                  <input
                    value={learnForm.name}
                    onChange={(e) => setLearnForm({ ...learnForm, name: e.target.value })}
                    className="mt-0.5 h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  />
                </label>
                <label className="text-[12px]">
                  <span className="text-slate-500">适用品类（逗号分隔，留空=全品类）</span>
                  <input
                    value={learnForm.category}
                    onChange={(e) => setLearnForm({ ...learnForm, category: e.target.value })}
                    placeholder="保温杯, 蓝牙音箱, 充电宝"
                    className="mt-0.5 h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                  />
                </label>
              </div>
              <label className="block text-[12px]">
                <span className="text-slate-500">补充你的偏好（可选）</span>
                <input
                  value={learnForm.note}
                  onChange={(e) => setLearnForm({ ...learnForm, note: e.target.value })}
                  placeholder="例如：更接近 4imprint 的白底风格，不要道具，留白多一点"
                  className="mt-0.5 h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                />
              </label>

              <div>
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-slate-600">选参考图（建议 3-6 张，AI 提炼共同规律）</span>
                  <span className="text-slate-400">已选 {learnForm.refIds.length}</span>
                </div>
                <div className="mt-1 grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto rounded-lg border border-slate-200 p-1.5 sm:grid-cols-6">
                  {refs
                    .filter((r) => r.status === 'active' && r.verdict !== 'bad')
                    .map((r) => {
                      const on = learnForm.refIds.includes(r.id)
                      return (
                        <button
                          key={r.id}
                          onClick={() =>
                            setLearnForm({
                              ...learnForm,
                              refIds: on ? learnForm.refIds.filter((x) => x !== r.id) : [...learnForm.refIds, r.id],
                            })
                          }
                          className={cn('relative rounded border-2 p-0', on ? 'border-blue-500' : 'border-transparent opacity-75')}
                        >
                          <img src={r.url} alt="" className="aspect-square w-full rounded object-cover" />
                          {on && <CheckCircle2 className="absolute right-0.5 top-0.5 h-3.5 w-3.5 text-blue-600" />}
                        </button>
                      )
                    })}
                  {refs.length === 0 && <span className="col-span-4 py-4 text-center text-[11px] text-slate-400">先去参考图库上传</span>}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-500">
                学习只会提炼「怎么拍」的规则（构图/光影/背景/排版），不会复制参考图里的产品。
                如果报错提示模型不支持图片，请到「设置」把文本 AI 换成支持看图的模型（如 gpt-4o-mini / qwen-vl-plus）。
              </div>
            </div>
            <div className="flex justify-end gap-1.5 border-t border-slate-100 px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setLearnOpen(false)}>
                取消
              </Button>
              <Button size="sm" disabled={busy === 'learn'} onClick={() => void runLearn()}>
                {busy === 'learn' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                开始学习
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 风格配置编辑弹窗 */}
      {editingStyle && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setEditingStyle(null)}>
          <div
            className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-slate-800">风格配置 · {editingStyle.name}</div>
              <button onClick={() => setEditingStyle(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {PROFILE_FIELDS.map((f) => (
                  <label key={f.key} className="text-[11px]">
                    <span className="text-slate-500">{f.label}</span>
                    <input
                      value={profileDraft[f.key] ?? ''}
                      onChange={(e) => setProfileDraft({ ...profileDraft, [f.key]: e.target.value })}
                      placeholder={f.hint}
                      className="mt-0.5 h-7 w-full rounded border border-slate-200 px-1.5 text-[11px] outline-none focus:border-blue-400"
                    />
                  </label>
                ))}
              </div>
              <label className="block text-[11px]">
                <span className="text-slate-500">英文风格指令（实际注入出图提示词；留空=不套用风格）</span>
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={8}
                  className="mt-0.5 w-full rounded border border-slate-200 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-blue-400"
                />
              </label>
            </div>
            <div className="flex justify-end gap-1.5 border-t border-slate-100 px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setEditingStyle(null)}>
                取消
              </Button>
              <Button size="sm" onClick={() => void saveEdit()}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
