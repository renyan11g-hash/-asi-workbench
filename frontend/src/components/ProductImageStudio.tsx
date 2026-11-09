import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
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
import type { ImageCapabilities, ProductImage, ShotPlan, StyleMatch, VisualRef } from '@/types'

const KIND_LABEL: Record<string, string> = {
  main: '主图',
  dimension: '尺寸图',
  detail: '细节图',
  scene: '场景图',
  intro: '细节图',
}

const REASON_FALLBACK = [
  { key: 'product_detail', label: '产品细节错误' },
  { key: 'product_color', label: '产品颜色错误' },
  { key: 'composition', label: '构图不协调' },
  { key: 'background', label: '背景不合适' },
  { key: 'texture', label: '质感不足' },
  { key: 'scene', label: '场景不真实' },
  { key: 'layout', label: '排版不精致' },
]

type KindKey = 'main' | 'dimension' | 'detail' | 'scene'
type KindPlanState = {
  sources: string[]
  refs: string[]
  notes: string
  chat: Array<{ role: 'user' | 'assistant'; content: string; at: string }>
}

const EMPTY_PLAN: Record<KindKey, KindPlanState> = {
  main: { sources: [], refs: [], notes: '', chat: [] },
  dimension: { sources: [], refs: [], notes: '', chat: [] },
  detail: { sources: [], refs: [], notes: '', chat: [] },
  scene: { sources: [], refs: [], notes: '', chat: [] },
}

function normalizePlan(raw: unknown): Record<KindKey, KindPlanState> {
  const p = (raw ?? {}) as Record<string, Partial<KindPlanState> | undefined>
  const pick = (k: KindKey): KindPlanState => ({
    sources: Array.isArray(p[k]?.sources) ? (p[k]?.sources as string[]) : [],
    refs: Array.isArray(p[k]?.refs) ? (p[k]?.refs as string[]) : [],
    notes: typeof p[k]?.notes === 'string' ? (p[k]?.notes as string) : '',
    chat: Array.isArray(p[k]?.chat) ? (p[k]?.chat as KindPlanState['chat']) : [],
  })
  return { main: pick('main'), dimension: pick('dimension'), detail: pick('detail'), scene: pick('scene') }
}

/**
 * 产品图片工作台。
 *
 * 默认走「简单模式」：上传/抓取 1688 产品图 → AI 自动识别 → 自动匹配已保存的视觉风格
 * → 自动配一套图 → 人工确认（满意/不满意/重生成/收藏）。
 *
 * 高级操作（手动指定产品图、图种、风格参考图、注意点、生成前对话）都收在「高级设置」里，
 * 日常不需要点。每张图都能看到：用了哪些参考图、实际发给模型的提示词、命中的风格版本。
 */
export function ProductImageStudio({
  productId,
  onChatImage,
}: {
  productId: string
  onChatImage: (img: ProductImage) => void
}) {
  const [sources, setSources] = useState<string[]>([])
  const [refs, setRefs] = useState<Array<{ id: string; url: string }>>([])
  const [images, setImages] = useState<ProductImage[]>([])
  const [plan, setPlan] = useState<Record<KindKey, KindPlanState>>(EMPTY_PLAN)
  const [loading, setLoading] = useState(true)

  // 自动匹配状态
  const [match, setMatch] = useState<StyleMatch | null>(null)
  const [suggestion, setSuggestion] = useState<ShotPlan | null>(null)
  const [caps, setCaps] = useState<ImageCapabilities | null>(null)
  const [libraryRefs, setLibraryRefs] = useState<VisualRef[]>([])
  const [styles, setStyles] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([])
  const [feedbackReasons, setFeedbackReasons] = useState(REASON_FALLBACK)

  // 生成设置
  const [auto, setAuto] = useState(true)
  const [manualStyleId, setManualStyleId] = useState('')
  const [manualRefIds, setManualRefIds] = useState<string[]>([])
  const [noStyleRefs, setNoStyleRefs] = useState(false)
  const [want, setWant] = useState({ main: true, dimension: true, detail: true, scene: true })
  const [detailCount, setDetailCount] = useState(1)
  const [sceneCount, setSceneCount] = useState(1)
  const [mainStyle, setMainStyle] = useState<'white' | 'combo'>('white')
  const [mainMode, setMainMode] = useState<'ai' | 'compose'>('ai')
  const [withLogo, setWithLogo] = useState(true)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'gen' | 'match' | null>(null)
  const [progress, setProgress] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  // 尺寸输入（后端存 inch，这里用字符串便于清空）
  const [dimForm, setDimForm] = useState({ lengthIn: '', widthIn: '', heightIn: '', thicknessIn: '' })
  const [extraDim, setExtraDim] = useState<Array<{ label: string; value: number }>>([])
  const [newDimLabel, setNewDimLabel] = useState('')
  const [newDimValue, setNewDimValue] = useState('')

  // 手动粘贴产品图
  const [sourcePaste, setSourcePaste] = useState('')
  const [showSourcePaste, setShowSourcePaste] = useState(false)

  // 生成前对话
  const [chatKind, setChatKind] = useState<KindKey | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  // 反馈
  const [dislikeImage, setDislikeImage] = useState<ProductImage | null>(null)
  const [dislikeReasons, setDislikeReasons] = useState<string[]>([])
  const [dislikeNote, setDislikeNote] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [src, rf, imgs, pl, styleInfo, cap, refLibrary, styleList, meta] = await Promise.all([
        api.getSourceImages(productId),
        api.listRefImages(productId),
        api.listProductImages(productId),
        api.getImagePlan(productId),
        api.getProductStyle(productId),
        api.getImageCapabilities(),
        api.listVisualRefs({ status: 'active', limit: 200 }),
        api.listVisualStyles(),
        api.getVisualMeta(),
      ])
      setSources(src.images ?? [])
      setRefs(rf.refs ?? [])
      setImages(imgs ?? [])
      setPlan(normalizePlan(pl.plan))
      setMatch(styleInfo.match)
      setSuggestion(styleInfo.suggestion ?? null)
      const d = styleInfo.dimensions
      setDimForm({
        lengthIn: d.lengthIn != null ? String(d.lengthIn) : '',
        widthIn: d.widthIn != null ? String(d.widthIn) : '',
        heightIn: d.heightIn != null ? String(d.heightIn) : '',
        thicknessIn: d.thicknessIn != null ? String(d.thicknessIn) : '',
      })
      setExtraDim(d.extra ?? [])
      setCaps(cap)
      setLibraryRefs(refLibrary)
      setStyles(styleList.map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault })))
      setFeedbackReasons(meta.feedbackReasons?.length ? meta.feedbackReasons : REASON_FALLBACK)
      if (styleInfo.suggestion) {
        setWant({
          main: true,
          dimension: styleInfo.suggestion.kinds.includes('dimension'),
          detail: styleInfo.suggestion.kinds.includes('detail'),
          scene: styleInfo.suggestion.kinds.includes('scene'),
        })
        setDetailCount(Math.max(0, styleInfo.suggestion.detailCount))
        setSceneCount(Math.max(0, styleInfo.suggestion.sceneCount))
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  const detailSceneTotal = (want.detail ? detailCount : 0) + (want.scene ? sceneCount : 0)
  const over = detailSceneTotal > 3

  const kinds = useMemo(() => {
    const list: KindKey[] = []
    if (want.main) list.push('main')
    if (want.dimension) list.push('dimension')
    if (want.detail) for (let i = 0; i < detailCount; i++) list.push('detail')
    if (want.scene) for (let i = 0; i < sceneCount; i++) list.push('scene')
    return list
  }, [want, detailCount, sceneCount])

  const saveDims = async (patch?: Partial<Record<'lengthIn' | 'widthIn' | 'heightIn' | 'thicknessIn', string>>) => {
    const numOrNull = (v: string) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const form = { ...dimForm, ...(patch ?? {}) }
    try {
      await api.saveProductDimensions(productId, {
        lengthIn: numOrNull(form.lengthIn),
        widthIn: numOrNull(form.widthIn),
        heightIn: numOrNull(form.heightIn),
        thicknessIn: numOrNull(form.thicknessIn),
        extra: extraDim,
      })
      toast.success('尺寸已保存（尺寸图按这个数据标注）')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const fetchFrom1688 = async () => {
    setBusy('fetch')
    try {
      const r = await api.fetchSourceImages(productId)
      setSources(r.images ?? [])
      if (r.added > 0) toast.success(`从 1688 抓到 ${r.added} 张产品图（共 ${r.total} 张）`)
      else toast.warning(r.message || '没有抓到新图：可以手动粘贴图片地址')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const addSources = async () => {
    const urls = sourcePaste
      .split(/[\n,，\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^(https?:\/\/|data:image\/)/i.test(s))
    if (!urls.length) {
      toast.error('没识别到图片地址（要以 http(s):// 开头）')
      return
    }
    try {
      const r = await api.addSourceImages(productId, urls)
      setSources(r.images ?? [])
      setSourcePaste('')
      toast.success(`已添加产品图，共 ${(r.images ?? []).length} 张`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const reidentify = async () => {
    setBusy('match')
    try {
      const m = await api.matchProductStyle(productId, true)
      setMatch(m)
      toast.success(
        m.style
          ? `识别为「${m.identification.category || '未命名品类'}」，匹配风格「${m.style.name}」`
          : `识别为「${m.identification.category || '未命名品类'}」；参考库还没有风格配置`
      )
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const savePlan = async (kind: KindKey, patch: Partial<KindPlanState>) => {
    const prev = plan[kind]
    setPlan((cur) => ({ ...cur, [kind]: { ...cur[kind], ...patch } }))
    try {
      const r = await api.saveImagePlan(productId, { kind, ...patch })
      setPlan(normalizePlan(r.plan))
    } catch (err) {
      setPlan((cur) => ({ ...cur, [kind]: prev }))
      toast.error(getErrorMessage(err))
    }
  }

  const sendChat = async () => {
    if (!chatKind || !chatInput.trim()) return
    const kind = chatKind
    const msg = chatInput.trim()
    setChatBusy(true)
    setChatInput('')
    try {
      const r = await api.chatImagePlan(productId, {
        kind,
        message: msg,
        messages: plan[kind].chat.map((m) => ({ role: m.role, content: m.content })),
      })
      const now = new Date().toISOString()
      setPlan((cur) => ({
        ...cur,
        [kind]: {
          ...cur[kind],
          chat: [
            ...cur[kind].chat,
            { role: 'user', content: msg, at: now },
            ...(r.reply ? [{ role: 'assistant' as const, content: r.reply, at: now }] : []),
          ],
          notes: r.plan?.[kind]?.notes ?? cur[kind].notes,
        },
      }))
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setChatBusy(false)
    }
  }

  const generate = async () => {
    if (!auto && !kinds.length) {
      toast.error('至少选一种图')
      return
    }
    if (!auto && over) {
      toast.error('细节图 + 场景图合计最多 3 张')
      return
    }
    if (!sources.length) {
      toast.error('还没有产品图：先「从 1688 抓取」或手动粘贴产品图，AI 得有实物参考才画得准')
      return
    }
    if (mainMode === 'compose' && withLogo) {
      toast.warning('原图直出不会自动加 Logo（不重绘产品）；需要 Logo 请用 AI 生成主图')
    }
    setBusy('gen')
    setProgress('正在保存尺寸并提交生成任务…')
    try {
      await api.saveProductDimensions(productId, {
        lengthIn: Number(dimForm.lengthIn) > 0 ? Number(dimForm.lengthIn) : null,
        widthIn: Number(dimForm.widthIn) > 0 ? Number(dimForm.widthIn) : null,
        heightIn: Number(dimForm.heightIn) > 0 ? Number(dimForm.heightIn) : null,
        thicknessIn: Number(dimForm.thicknessIn) > 0 ? Number(dimForm.thicknessIn) : null,
        extra: extraDim,
      })
      // 先单独跑「识别 + 匹配风格」：这一步可能调视觉模型，放在出图请求之外，
      // 避免 Render 100 秒代理超时；结果会落库缓存，出图接口直接命中。
      if (auto) {
        setProgress('AI 正在识别产品、匹配视觉风格…')
        try {
          const m = await api.matchProductStyle(productId, false)
          setMatch(m)
        } catch {
          /* 识别失败不阻塞出图：后端会按资料库字段兜底匹配 */
        }
      }
      setProgress('正在提交生成任务…')
      const imgs = await api.generateProductImages(
        productId,
        (p, elapsed) => setProgress(p ? `${p}（已耗时 ${elapsed} 秒）` : `生成中…（已耗时 ${elapsed} 秒）`),
        notes,
        auto ? undefined : kinds,
        withLogo,
        mainStyle,
        {
          auto,
          styleId: manualStyleId || undefined,
          styleRefIds: manualRefIds.length ? manualRefIds : undefined,
          noStyleRefs,
          mainMode,
          dimensions: {
            lengthIn: Number(dimForm.lengthIn) > 0 ? Number(dimForm.lengthIn) : null,
            widthIn: Number(dimForm.widthIn) > 0 ? Number(dimForm.widthIn) : null,
            heightIn: Number(dimForm.heightIn) > 0 ? Number(dimForm.heightIn) : null,
            thicknessIn: Number(dimForm.thicknessIn) > 0 ? Number(dimForm.thicknessIn) : null,
            extra: extraDim,
          },
        }
      )
      setImages(imgs ?? [])
      toast.success(`已生成 ${imgs.length} 张（每张都带产品保真审查）`)
      void load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const regenerate = async (img: ProductImage) => {
    const note = window.prompt('这张图要怎么改？（可留空，只换一版；旧版会保留在历史版本里）', '')
    if (note === null) return
    setBusy('gen')
    setProgress(`正在重跑这张${KIND_LABEL[img.kind] ?? '图'}…`)
    try {
      await api.regenerateProductImage(productId, img.id, note || undefined)
      toast.success('已重跑并保留旧版本')
      await load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const like = async (img: ProductImage) => {
    try {
      await api.submitImageFeedback(productId, img.id, { verdict: 'like' })
      setImages((cur) =>
        cur.map((i) =>
          i.id === img.id ? { ...i, feedback: { verdict: 'like', reasons: [], note: '', at: new Date().toISOString() } } : i
        )
      )
      toast.success('已记下满意；如果觉得这张可以当模板，点「加入优秀作品库」')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const collect = async (img: ProductImage) => {
    try {
      const category =
        img.kind === 'main' ? 'main' : img.kind === 'dimension' ? 'dimension' : img.kind === 'scene' ? 'scene' : 'detail'
      await api.collectGeneratedRef({ productId, imageId: img.id, category, verdict: 'good' })
      toast.success('已加入优秀作品库，下次学习风格/出图会自动用上')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const submitDislike = async () => {
    if (!dislikeImage) return
    try {
      await api.submitImageFeedback(productId, dislikeImage.id, {
        verdict: 'dislike',
        reasons: dislikeReasons,
        note: dislikeNote.trim(),
        addToLibrary: false,
      })
      setImages((cur) =>
        cur.map((i) =>
          i.id === dislikeImage.id
            ? {
                ...i,
                feedback: { verdict: 'dislike', reasons: dislikeReasons, note: dislikeNote.trim(), at: new Date().toISOString() },
              }
            : i
        )
      )
      setDislikeImage(null)
      setDislikeReasons([])
      setDislikeNote('')
      toast.success('已记下问题，反馈会汇总到视觉风格中心')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const reviewBadge = (img: ProductImage) => {
    const r = img.review
    if (!r) return <span className="text-[10px] text-slate-400">未审查</span>
    if (r.ok)
      return (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
          <ShieldCheck className="h-3 w-3" /> 保真审查通过
        </span>
      )
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-700" title={r.issues.join('\n')}>
        <AlertTriangle className="h-3 w-3" /> {r.issues.length} 项待修
      </span>
    )
  }

  const current = images.filter((i) => !i.archived)
  const archived = images.filter((i) => i.archived)
  const grouped = useMemo(() => {
    const order: Array<ProductImage['kind']> = ['main', 'dimension', 'detail', 'scene', 'intro']
    return order
      .map((k) => ({ kind: k, items: current.filter((i) => i.kind === k) }))
      .filter((g) => g.items.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images])

  const shownRefs = manualRefIds.length
    ? libraryRefs.filter((r) => manualRefIds.includes(r.id))
    : (match?.refs ?? [])

  return (
    <div className="space-y-4">
      {/* 1. 自动匹配状态：AI 识别 → 风格 → 参考图 */}
      <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white">
            <Sparkles className="h-3 w-3" /> 自动模式
          </span>
          <span className="text-[13px] font-semibold text-slate-800">上传原图 → 自动识别 → 匹配风格 → 生成</span>
          <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-600">
            <input type="checkbox" className="h-3.5 w-3.5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自动配图/自动套风格
          </label>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy === 'match'} onClick={() => void reidentify()}>
            {busy === 'match' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
            重新识别
          </Button>
        </div>

        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">AI 识别</div>
            {match ? (
              <>
                <div className="mt-0.5 text-[12px] font-medium text-slate-800">
                  {match.identification.category || '未命名品类'}
                  {match.identification.categoryEn ? ` · ${match.identification.categoryEn}` : ''}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-slate-500">
                  {[
                    match.identification.material,
                    match.identification.colors.join('/'),
                    match.identification.accessories.length ? `配件：${match.identification.accessories.join('、')}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || '按资料库字段匹配'}
                </div>
              </>
            ) : (
              <div className="mt-0.5 text-[11px] text-slate-400">生成时会自动识别；也可点「重新识别」先看结果</div>
            )}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">匹配风格</div>
            <div className="mt-0.5 text-[12px] font-medium text-slate-800">
              {manualStyleId
                ? styles.find((s) => s.id === manualStyleId)?.name ?? '手动指定'
                : match?.style?.name ?? '暂无风格配置'}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-slate-500">
              {match?.reason ?? '先去「视觉风格中心」收藏参考图并学习一条风格'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wide text-slate-400">本次风格参考图</div>
              <div className="text-[10px] text-slate-400">{shownRefs.length} 张（最多 2 张送模型）</div>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {shownRefs.length === 0 && <span className="text-[10px] text-slate-400">无（只用产品图，保真优先）</span>}
              {shownRefs.slice(0, 6).map((r) => (
                <img key={r.id} src={api.proxyImageUrl(r.url)} alt="" title={r.title || r.category} className="h-8 w-8 rounded border border-slate-200 object-cover" />
              ))}
            </div>
          </div>
        </div>
        {caps && (
          <div className="mt-1.5 text-[10px] text-slate-400">
            图像模型：{caps.provider} · {caps.model} · {caps.multiRef ? `最多 ${caps.maxRefs} 张参考图` : '仅支持单参考图'}
            {caps.supportsEdit ? ' · 支持指令编辑' : ''}
          </div>
        )}
      </div>

      {/* 2. 产品图 + 确认尺寸 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-slate-800">产品图（唯一事实来源）</div>
              <div className="text-[11px] text-slate-500">AI 只照这些图画；颜色/结构/配件不许改</div>
            </div>
            <Button size="sm" variant="outline" disabled={busy === 'fetch'} onClick={() => void fetchFrom1688()}>
              {busy === 'fetch' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              从 1688 抓取
            </Button>
          </div>
          <div className="mt-2 flex min-h-[80px] flex-wrap gap-2">
            {sources.length === 0 ? (
              <div className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 py-6 text-[11px] text-slate-400">
                <ImagePlus className="mb-1 h-5 w-5" />
                还没有产品图：点「从 1688 抓取」，或手动粘贴图片地址
              </div>
            ) : (
              sources.map((u, i) => (
                <div key={`${i}-${u.slice(0, 24)}`} className="relative">
                  <img src={api.proxyImageUrl(u)} alt="" className="h-16 w-16 rounded border border-slate-200 object-cover" />
                  <button
                    className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-slate-500 shadow hover:text-rose-600"
                    title="从产品图里删掉这张"
                    onClick={async () => {
                      if (!window.confirm('从产品图里删掉这张？删除后 AI 生图就不会再参考它。')) return
                      try {
                        const r = await api.removeSourceImage(productId, u)
                        setSources(r.images ?? [])
                        toast.success('已删除这张产品图')
                      } catch (err) {
                        toast.error(getErrorMessage(err))
                      }
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="mt-2">
            {showSourcePaste ? (
              <div className="space-y-1.5">
                <textarea
                  value={sourcePaste}
                  onChange={(e) => setSourcePaste(e.target.value)}
                  rows={3}
                  placeholder="粘贴产品图片地址，一行一个（http(s):// 开头）"
                  className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-blue-400"
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-7 text-[11px]" onClick={() => void addSources()}>
                    添加
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setShowSourcePaste(false)}>
                    收起
                  </Button>
                </div>
              </div>
            ) : (
              <button
                className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
                onClick={() => setShowSourcePaste(true)}
              >
                <Link2 className="h-3 w-3" /> 抓不到？手动粘贴图片地址
              </button>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-slate-800">确认尺寸（英寸）</div>
              <div className="text-[11px] text-slate-500">尺寸图只标你填的数字；没填就不出尺寸图</div>
            </div>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void saveDims()}>
              保存
            </Button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {(
              [
                ['lengthIn', '长 Length'],
                ['widthIn', '宽 Width'],
                ['heightIn', '高 Height'],
                ['thicknessIn', '厚度 Thickness'],
              ] as Array<['lengthIn' | 'widthIn' | 'heightIn' | 'thicknessIn', string]>
            ).map(([key, label]) => (
              <label key={key} className="text-[11px]">
                <span className="text-slate-500">{label}</span>
                <input
                  value={dimForm[key]}
                  onChange={(e) => setDimForm({ ...dimForm, [key]: e.target.value })}
                  onBlur={() => void saveDims({ [key]: dimForm[key] })}
                  inputMode="decimal"
                  placeholder="0.0"
                  className="mt-0.5 h-7 w-full rounded border border-slate-200 px-1.5 text-[11px] outline-none focus:border-blue-400"
                />
              </label>
            ))}
          </div>
          {extraDim.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {extraDim.map((e, i) => (
                <div key={`${e.label}-${i}`} className="flex items-center gap-1 text-[10px] text-slate-600">
                  <span className="flex-1 truncate">
                    {e.label}：{e.value} in
                  </span>
                  <button
                    className="text-rose-500 hover:underline"
                    onClick={() => setExtraDim((cur) => cur.filter((_, idx) => idx !== i))}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-1.5 flex gap-1">
            <input
              value={newDimLabel}
              onChange={(e) => setNewDimLabel(e.target.value)}
              placeholder="其他尺寸名（如 Handle）"
              className="h-7 flex-1 rounded border border-slate-200 px-1.5 text-[11px]"
            />
            <input
              value={newDimValue}
              onChange={(e) => setNewDimValue(e.target.value)}
              placeholder="in"
              inputMode="decimal"
              className="h-7 w-16 rounded border border-slate-200 px-1.5 text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => {
                const v = Number(newDimValue)
                if (!newDimLabel.trim() || !Number.isFinite(v) || v <= 0) {
                  toast.error('填尺寸名和数字')
                  return
                }
                setExtraDim((cur) => [...cur, { label: newDimLabel.trim(), value: v }].slice(0, 6))
                setNewDimLabel('')
                setNewDimValue('')
              }}
            >
              加
            </Button>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            底部长、右侧高、左斜宽；厚度和其他尺寸由程序画在图例里，保证数字准确。
          </p>
        </div>
      </div>

      {/* 3. 生成设置 */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-slate-800">生成哪些图</div>
          {suggestion && (
            <span className="text-[11px] text-slate-500">
              建议：{suggestion.kinds.map((k) => KIND_LABEL[k]).join(' + ')}
            </span>
          )}
        </div>

        {auto ? (
          <div className="mt-1 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
            {suggestion
              ? suggestion.reasons.map((r, i) => <div key={i}>· {r}</div>)
              : '按产品特点自动配图：主图 + 尺寸图（有确认尺寸时）+ 细节图 + 场景图'}
            <div className="mt-1 text-slate-400">想自己选图种？取消上面「自动配图」。</div>
          </div>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
              {(
                [
                  ['main', '主图'],
                  ['dimension', '尺寸图'],
                  ['detail', '细节图'],
                  ['scene', '场景图'],
                ] as Array<['main' | 'dimension' | 'detail' | 'scene', string]>
              ).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={want[key]}
                    onChange={(e) => setWant({ ...want, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <span className="text-slate-300">|</span>
              <label className="inline-flex items-center gap-1">
                细节张数
                <select
                  value={detailCount}
                  onChange={(e) => setDetailCount(Number(e.target.value))}
                  className="h-6 rounded border border-slate-200 px-1 text-[11px]"
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-1">
                场景张数
                <select
                  value={sceneCount}
                  onChange={(e) => setSceneCount(Number(e.target.value))}
                  className="h-6 rounded border border-slate-200 px-1 text-[11px]"
                >
                  <option value={0}>0</option>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                </select>
              </label>
            </div>
            <div className={cn('mt-1 text-[11px]', over ? 'text-rose-600' : 'text-slate-400')}>
              细节图 + 场景图合计 {detailSceneTotal} 张（上限 3）
            </div>
          </>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
          <label className="inline-flex items-center gap-1">
            主图样式
            <select
              value={mainStyle}
              onChange={(e) => setMainStyle(e.target.value as 'white' | 'combo')}
              className="h-6 rounded border border-slate-200 px-1 text-[11px]"
            >
              <option value="white">纯白底：主产品 + 其他颜色小图</option>
              <option value="combo">卖点组合：产品 + 卖点特写</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1">
            主图方式
            <select
              value={mainMode}
              onChange={(e) => setMainMode(e.target.value as 'ai' | 'compose')}
              className="h-6 rounded border border-slate-200 px-1 text-[11px]"
            >
              <option value="ai">AI 生成（可加 Logo / 多色）</option>
              <option value="compose">原图直出（换白底，保真优先）</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" className="h-3.5 w-3.5" checked={withLogo} onChange={(e) => setWithLogo(e.target.checked)} />
            主图加品牌 Logo
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" className="h-3.5 w-3.5" checked={noStyleRefs} onChange={(e) => setNoStyleRefs(e.target.checked)} />
            不用风格参考图（保真优先）
          </label>
        </div>

        <div className="mt-2">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="这次出图的注意点（可空），例如：主图展示正面、细节图拍缝线、场景用办公桌"
            className="h-8 w-full rounded border border-slate-200 px-2 text-[12px] outline-none focus:border-blue-400"
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy === 'gen' || (!auto && (over || !kinds.length)) || !sources.length}
            onClick={() => void generate()}
          >
            {busy === 'gen' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            生成一套 ASI 产品图（1200×1200）
          </Button>
          {!sources.length && <span className="text-[11px] text-amber-700">先加产品图才能生成</span>}
          {progress && <span className="text-[11px] text-slate-500">{progress}</span>}
        </div>
      </div>

      {/* 4. 结果 + 每张图反馈 */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-slate-800">已生成图片</div>
            <div className="text-[11px] text-slate-500">每张都能单独确认、重跑或收藏；旧版本不会被覆盖</div>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? '隐藏历史版本' : `历史版本 ${archived.length}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
              {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />} 刷新
            </Button>
          </div>
        </div>

        {current.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-slate-400">还没有生成图片</div>
        ) : (
          <div className="mt-2 space-y-3">
            {grouped.map((g) => (
              <div key={g.kind}>
                <div className="mb-1 text-[11px] font-medium text-slate-500">{KIND_LABEL[g.kind] ?? g.kind}</div>
                <div className="flex flex-wrap gap-3">
                  {g.items.map((img) => (
                    <div key={img.id} className="w-44">
                      <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-white">
                        <img src={api.productImageUrl(img.productId, img.file)} alt="" className="aspect-square w-full object-contain" />
                        {img.feedback?.verdict === 'like' && (
                          <span className="absolute left-1 top-1 rounded bg-emerald-600/90 px-1 text-[10px] text-white">已确认</span>
                        )}
                        {img.feedback?.verdict === 'dislike' && (
                          <span className="absolute left-1 top-1 rounded bg-rose-600/90 px-1 text-[10px] text-white">待改</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center justify-between">{reviewBadge(img)}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <button
                          className="inline-flex items-center gap-0.5 rounded border border-emerald-200 px-1.5 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50"
                          onClick={() => void like(img)}
                        >
                          <ThumbsUp className="h-3 w-3" /> 满意
                        </button>
                        <button
                          className="inline-flex items-center gap-0.5 rounded border border-rose-200 px-1.5 py-0.5 text-[10px] text-rose-700 hover:bg-rose-50"
                          onClick={() => {
                            setDislikeImage(img)
                            setDislikeReasons(img.feedback?.verdict === 'dislike' ? img.feedback.reasons : [])
                            setDislikeNote(img.feedback?.note ?? '')
                          }}
                        >
                          <ThumbsDown className="h-3 w-3" /> 不满意
                        </button>
                        <button
                          className="inline-flex items-center gap-0.5 rounded border border-amber-200 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-50"
                          title="收藏进优秀作品库（供 AI 学习风格）"
                          onClick={() => void collect(img)}
                        >
                          <Star className="h-3 w-3" /> 收藏
                        </button>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <button
                          className="inline-flex items-center gap-0.5 text-[10px] text-slate-500 hover:text-slate-800"
                          onClick={() => void regenerate(img)}
                        >
                          <RefreshCw className="h-3 w-3" /> 重新生成
                        </button>
                        <button
                          className="inline-flex items-center gap-0.5 text-[10px] text-slate-500 hover:text-slate-800"
                          onClick={() => onChatImage(img)}
                        >
                          <MessageSquare className="h-3 w-3" /> 修改要求
                        </button>
                        <button
                          className="inline-flex items-center gap-0.5 text-[10px] text-slate-500 hover:text-slate-800"
                          onClick={() => setExpanded((cur) => ({ ...cur, [img.id]: !cur[img.id] }))}
                        >
                          {expanded[img.id] ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          参考图/提示词
                        </button>
                      </div>

                      {img.review && !img.review.ok && (
                        <ul className="mt-0.5 list-disc pl-3 text-[10px] text-amber-700">
                          {img.review.issues.slice(0, 3).map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      )}

                      {expanded[img.id] && (
                        <div className="mt-1 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-1.5 text-[10px] text-slate-600">
                          <div>
                            风格：{img.styleName || '未套用'} · 版本：{img.promptVersion || '-'} · 主图方式：
                            {img.refsUsed?.mainMode === 'compose' ? '原图直出' : 'AI 生成'}
                          </div>
                          <div>产品参考图：{img.refsUsed?.product?.length ?? 0} 张</div>
                          {(img.refsUsed?.product?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {img.refsUsed?.product.slice(0, 6).map((u, i) => (
                                <img key={i} src={api.proxyImageUrl(u)} alt="" className="h-7 w-7 rounded border border-slate-200 object-cover" />
                              ))}
                            </div>
                          )}
                          <div>风格参考图：{img.refsUsed?.style?.length ?? 0} 张{img.refsUsed?.logo ? ' · 含品牌 Logo' : ''}</div>
                          {(img.refsUsed?.style?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {img.refsUsed?.style.map((s, i) => (
                                <img key={i} src={api.proxyImageUrl(s.url)} alt="" title={s.title} className="h-7 w-7 rounded border border-slate-200 object-cover" />
                              ))}
                            </div>
                          )}
                          <details>
                            <summary className="cursor-pointer text-slate-500">实际发给模型的提示词</summary>
                            <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white p-1 text-[9px] leading-relaxed text-slate-500">
                              {img.prompt}
                            </pre>
                          </details>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {showHistory && archived.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-2">
            <div className="text-[11px] text-slate-500">历史版本（{archived.length} 张，不会被删除）</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {archived.map((img) => (
                <div key={img.id} className="w-24 opacity-70">
                  <img src={api.productImageUrl(img.productId, img.file)} alt="" className="aspect-square w-full rounded border border-slate-200 object-contain" />
                  <div className="truncate text-[9px] text-slate-400">
                    {KIND_LABEL[img.kind] ?? img.kind} · {new Date(img.createdAt).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 5. 高级设置：手动指定参考图 / 图种 / 生成前对话 */}
      <details className="rounded-xl border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-[12px] font-medium text-slate-700">
          高级设置（手动指定参考图 / 每种图的注意点 / 生成前对话）
        </summary>

        <div className="mt-3 space-y-3">
          <div className="grid gap-2 lg:grid-cols-2">
            <div>
              <div className="text-[12px] font-medium text-slate-700">风格参考图（从视觉风格中心选，可排除）</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {libraryRefs.slice(0, 18).map((r) => {
                  const on = manualRefIds.includes(r.id)
                  return (
                    <button
                      key={r.id}
                      onClick={() =>
                        setManualRefIds((cur) => (on ? cur.filter((x) => x !== r.id) : [...cur, r.id].slice(0, 2)))
                      }
                      className={cn('rounded border-2 p-0', on ? 'border-blue-500' : 'border-transparent opacity-70')}
                      title={`${r.title || r.category}${on ? '（已选）' : ''}`}
                    >
                      <img src={api.proxyImageUrl(r.url)} alt="" className="h-10 w-10 rounded object-cover" />
                    </button>
                  )
                })}
                {libraryRefs.length === 0 && (
                  <span className="text-[11px] text-slate-400">
                    参考库还是空的，去「视觉风格中心」上传几张优秀图
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                <span>最多选 2 张；不选=自动匹配</span>
                {manualRefIds.length > 0 && (
                  <button className="text-rose-500 hover:underline" onClick={() => setManualRefIds([])}>
                    清空
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="text-[12px] font-medium text-slate-700">手动指定风格</div>
              <select
                value={manualStyleId}
                onChange={(e) => setManualStyleId(e.target.value)}
                className="mt-1 h-7 w-full rounded border border-slate-200 px-1 text-[11px]"
              >
                <option value="">自动匹配（推荐）</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isDefault ? '（默认）' : ''}
                  </option>
                ))}
              </select>
              <div className="mt-1 text-[10px] text-slate-400">
                手动选了风格就不会再用自动识别的结果；参考图仍取该风格绑定的图。
              </div>
            </div>
          </div>

          <div>
            <div className="text-[12px] font-medium text-slate-700">每种图参考哪些产品图</div>
            <div className="mt-1 grid gap-2 lg:grid-cols-2">
              {(['main', 'dimension', 'detail', 'scene'] as const).map((k) => (
                <div key={k} className="rounded-lg border border-slate-200 px-2 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium text-slate-800">{KIND_LABEL[k]}</span>
                    <span className="text-[10px] text-slate-400">
                      已选 {plan[k].sources.length ? `${plan[k].sources.length} 张` : '全部产品图'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 px-2 text-[10px]"
                      onClick={() => {
                        setChatKind(k)
                        setChatInput('')
                      }}
                    >
                      <MessageSquare className="mr-0.5 h-3 w-3" /> 先和 AI 对话
                    </Button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {sources.slice(0, 12).map((u, i) => {
                      const on = plan[k].sources.includes(u)
                      return (
                        <button
                          key={`${k}-${i}`}
                          title={on ? '已选为这张图的参考图' : '点一下，作为这张图的参考图'}
                          onClick={() =>
                            void savePlan(k, { sources: on ? plan[k].sources.filter((x) => x !== u) : [...plan[k].sources, u] })
                          }
                          className={cn('rounded border-2 p-0', on ? 'border-blue-500' : 'border-transparent opacity-70')}
                        >
                          <img src={api.proxyImageUrl(u)} alt="" className="h-9 w-9 rounded object-cover" />
                        </button>
                      )
                    })}
                    {sources.length === 0 && <span className="text-[10px] text-slate-400">先加产品图</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={plan[k].notes}
                      onChange={(e) => setPlan((cur) => ({ ...cur, [k]: { ...cur[k], notes: e.target.value } }))}
                      onBlur={() => void savePlan(k, { notes: plan[k].notes })}
                      placeholder="这张图的注意点（对话后自动填入）"
                      className="h-7 flex-1 rounded border border-slate-200 px-2 text-[11px] outline-none focus:border-blue-400"
                    />
                    {plan[k].sources.length > 0 && (
                      <button className="text-[10px] text-rose-500 hover:underline" onClick={() => void savePlan(k, { sources: [] })}>
                        清空
                      </button>
                    )}
                  </div>
                  <label className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500">
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={plan[k].refs.includes('__none__')}
                      onChange={(e) => void savePlan(k, { refs: e.target.checked ? ['__none__'] : [] })}
                    />
                    这张图不用风格参考图
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[12px] font-medium text-slate-700">每产品手工参考图（旧入口，仍可用）</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {refs.map((r) => (
                <div key={r.id} className="relative">
                  <img src={api.proxyImageUrl(r.url)} alt="" className="h-14 w-14 rounded border border-slate-200 object-cover" />
                  <button
                    className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-slate-500 shadow hover:text-rose-600"
                    onClick={async () => {
                      try {
                        await api.deleteRefImage(r.id)
                        setRefs((cur) => cur.filter((x) => x.id !== r.id))
                      } catch (err) {
                        toast.error(getErrorMessage(err))
                      }
                    }}
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <label className="flex h-14 w-14 cursor-pointer items-center justify-center rounded border border-dashed border-slate-300 text-slate-400 hover:border-blue-300">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    const reader = new FileReader()
                    reader.onload = async () => {
                      const v = String(reader.result ?? '')
                      if (!v.startsWith('data:image/')) return
                      try {
                        const r = await api.addRefImages(productId, { images: [v] })
                        setRefs(r.refs ?? [])
                        toast.success('已添加参考图')
                      } catch (err) {
                        toast.error(getErrorMessage(err))
                      }
                    }
                    reader.readAsDataURL(f)
                  }}
                />
                <ImagePlus className="h-4 w-4" />
              </label>
            </div>
            <div className="mt-1 text-[10px] text-slate-400">
              这些图只学构图/光线/场景；产品结构、颜色、配件一律以产品图为准。
            </div>
          </div>
        </div>
      </details>

      {/* 生成前对话 */}
      {chatKind && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setChatKind(null)}>
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-slate-800">生成前对话 · {KIND_LABEL[chatKind]}</div>
              <button onClick={() => setChatKind(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
              {plan[chatKind].chat.length === 0 && (
                <p className="text-[12px] text-slate-500">
                  告诉 AI 这张图想怎么拍，例如：「主图展示正面，白色小图放右下角，不要加文字」。AI 会确认构图并给出生图注意点。
                </p>
              )}
              {plan[chatKind].chat.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed',
                    m.role === 'user' ? 'ml-8 bg-blue-50 text-slate-800' : 'mr-8 bg-slate-100 text-slate-700'
                  )}
                >
                  {m.content}
                </div>
              ))}
              {chatBusy && <div className="text-[11px] text-slate-400">AI 正在回复…</div>}
            </div>
            <div className="flex gap-1.5 border-t border-slate-100 px-4 py-2.5">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendChat()
                  }
                }}
                placeholder="说一句这张图的要求…"
                className="h-8 flex-1 rounded border border-slate-200 px-2 text-[12px] outline-none focus:border-blue-400"
              />
              <Button size="sm" disabled={chatBusy || !chatInput.trim()} onClick={() => void sendChat()}>
                {chatBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '发送'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 不满意原因 */}
      {dislikeImage && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setDislikeImage(null)}>
          <div
            className="w-full max-w-md overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-slate-800">
                哪里不满意 · {KIND_LABEL[dislikeImage.kind] ?? dislikeImage.kind}
              </div>
              <button onClick={() => setDislikeImage(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2 px-4 py-3">
              <img
                src={api.productImageUrl(dislikeImage.productId, dislikeImage.file)}
                alt=""
                className="mx-auto max-h-48 rounded border border-slate-200 object-contain"
              />
              <div className="grid grid-cols-2 gap-1 text-[12px]">
                {feedbackReasons.map((r) => (
                  <label key={r.key} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={dislikeReasons.includes(r.key)}
                      onChange={(e) =>
                        setDislikeReasons((cur) =>
                          e.target.checked ? [...cur, r.key] : cur.filter((x) => x !== r.key)
                        )
                      }
                    />
                    {r.label}
                  </label>
                ))}
              </div>
              <input
                value={dislikeNote}
                onChange={(e) => setDislikeNote(e.target.value)}
                placeholder="补充说明（可空）"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
              />
            </div>
            <div className="flex justify-end gap-1.5 border-t border-slate-100 px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={() => setDislikeImage(null)}>
                取消
              </Button>
              <Button size="sm" onClick={() => void submitDislike()}>
                提交反馈
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
