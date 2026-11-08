import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ImagePlus,
  Link2,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ProductImage } from '@/types'

const KIND_LABEL: Record<string, string> = {
  main: '主图',
  dimension: '尺寸图',
  detail: '细节图',
  scene: '场景图',
  intro: '细节图',
}

/**
 * 产品图片工作台。
 *
 * 左半边是「喂给 AI 的事实」：
 *   产品图 = 产品真身图（1688 抓 / 人工上传），生成时作为事实基准；
 *   参考图 = 别人家的优秀图，只学构图/光线/场景，严禁改我们的产品。
 * 右半边是「生成什么」：主图 1、尺寸图 1、细节图+场景图合计 2~3，可选卖点组合主图。
 * 生成完每张图自动做 8 项一致性审查，结果直接标在图上；每张图仍可与 AI 对话修改。
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
  const [loading, setLoading] = useState(true)

  // 生成设置
  const [want, setWant] = useState({ main: true, dimension: true, detail: true, scene: true })
  const [detailCount, setDetailCount] = useState(1)
  const [sceneCount, setSceneCount] = useState(1)
  const [mainStyle, setMainStyle] = useState<'white' | 'combo'>('white')
  const [withLogo, setWithLogo] = useState(true)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'gen' | null>(null)
  const [progress, setProgress] = useState('')

  // 手动粘贴
  const [sourcePaste, setSourcePaste] = useState('')
  const [showSourcePaste, setShowSourcePaste] = useState(false)
  const [refPaste, setRefPaste] = useState('')
  const [fetchedInfo, setFetchedInfo] = useState<{ added: number; total: number; message: string } | null>(null)

  // 每种图各自的参考图 / 注意点 / 生成前对话
  type KindKey = 'main' | 'dimension' | 'detail' | 'scene'
  const [plan, setPlan] = useState<
    Record<KindKey, { sources: string[]; notes: string; chat: Array<{ role: 'user' | 'assistant'; content: string; at: string }> }>
  >({
    main: { sources: [], notes: '', chat: [] },
    dimension: { sources: [], notes: '', chat: [] },
    detail: { sources: [], notes: '', chat: [] },
    scene: { sources: [], notes: '', chat: [] },
  })
  const [chatKind, setChatKind] = useState<KindKey | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [src, rf, imgs, pl] = await Promise.all([
        api.getSourceImages(productId),
        api.listRefImages(productId),
        api.listProductImages(productId),
        api.getImagePlan(productId),
      ])
      setSources(src.images ?? [])
      setRefs(rf.refs ?? [])
      setImages(imgs ?? [])
      const p = pl.plan ?? {}
      setPlan({
        main: p.main ?? { sources: [], notes: '', chat: [] },
        dimension: p.dimension ?? { sources: [], notes: '', chat: [] },
        detail: p.detail ?? { sources: [], notes: '', chat: [] },
        scene: p.scene ?? { sources: [], notes: '', chat: [] },
      } as typeof plan)
    } catch {
      /* 单个接口失败不阻塞页面 */
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId])

  useEffect(() => {
    void load()
  }, [load])

  /** 细节 + 场景合计不能超过 3 张（主图/尺寸图各 1 张另算） */
  const detailSceneTotal = (want.detail ? detailCount : 0) + (want.scene ? sceneCount : 0)
  const over = detailSceneTotal > 3

  const kinds = useMemo(() => {
    const list: Array<'main' | 'dimension' | 'detail' | 'scene'> = []
    if (want.main) list.push('main')
    if (want.dimension) list.push('dimension')
    if (want.detail) for (let i = 0; i < detailCount; i++) list.push('detail')
    if (want.scene) for (let i = 0; i < sceneCount; i++) list.push('scene')
    return list
  }, [want, detailCount, sceneCount])

  const fetchFrom1688 = async () => {
    setBusy('fetch')
    setFetchedInfo(null)
    try {
      const r = await api.fetchSourceImages(productId)
      setSources(r.images ?? [])
      setFetchedInfo({ added: r.added, total: r.total, message: r.message })
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

  const addRefs = async (payload: { urls?: string[]; images?: string[] }) => {
    try {
      const r = await api.addRefImages(productId, payload)
      setRefs(r.refs ?? [])
      setRefPaste('')
      if (r.added) toast.success(`已添加 ${r.added} 张参考图`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const removeRef = async (id: string) => {
    try {
      await api.deleteRefImage(id)
      setRefs((cur) => cur.filter((x) => x.id !== id))
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const pickRefFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const v = String(reader.result ?? '')
      if (v.startsWith('data:image/')) void addRefs({ images: [v] })
    }
    reader.readAsDataURL(file)
  }

  /** 保存某种图选中的产品参考图（空数组=用全部产品图） */
  const setKindSources = async (kind: KindKey, next: string[]) => {
    // 先本地更新，界面立刻有反馈；接口失败再回滚提示
    const prev = plan[kind].sources
    setPlan((cur) => ({ ...cur, [kind]: { ...cur[kind], sources: next } }))
    try {
      const r = await api.saveImagePlan(productId, { kind, sources: next })
      setPlan((cur) => ({ ...cur, [kind]: { ...cur[kind], ...(r.plan[kind] ?? {}) } }))
    } catch (err) {
      setPlan((cur) => ({ ...cur, [kind]: { ...cur[kind], sources: prev } }))
      toast.error(getErrorMessage(err))
    }
  }

  /** 生成前对话：把用户这句话发给 AI，AI 回复构图建议并把注意点写进这张图的 notes */
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
          chat: [...cur[kind].chat, { role: 'user', content: msg, at: now }, ...(r.reply ? [{ role: 'assistant' as const, content: r.reply, at: now }] : [])],
          notes: r.plan?.[kind]?.notes ?? cur[kind].notes,
        },
      }))
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setChatBusy(false)
    }
  }

  const generate = async () => {    if (!kinds.length) {
      toast.error('至少选一种图')
      return
    }
    if (over) {
      toast.error('细节图 + 场景图合计最多 3 张')
      return
    }
    if (!sources.length) {
      toast.error('还没有产品图：先「从 1688 抓取」或手动粘贴产品图，AI 得有实物参考才画得准')
      return
    }
    setBusy('gen')
    setProgress('正在提交生成任务…')
    try {
      const imgs = await api.generateProductImages(
        productId,
        (p, elapsed) => setProgress(p ? `${p}（已耗时 ${elapsed} 秒）` : `生成中…（已耗时 ${elapsed} 秒）`),
        notes,
        kinds,
        withLogo,
        mainStyle
      )
      setImages(imgs ?? [])
      toast.success(`已生成 ${imgs.length} 张（含自动审查）`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const reviewBadge = (img: ProductImage) => {
    const r = img.review
    if (!r) return <span className="text-[10px] text-slate-400">未审查</span>
    if (r.ok)
      return (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
          <ShieldCheck className="h-3 w-3" /> 审查通过
        </span>
      )
    return (
      <span
        className="inline-flex items-center gap-0.5 text-[10px] text-amber-700"
        title={r.issues.join('\n')}
      >
        <AlertTriangle className="h-3 w-3" /> {r.issues.length} 项待修
      </span>
    )
  }

  const grouped = useMemo(() => {
    const order: ProductImageKindKey[] = ['main', 'dimension', 'detail', 'scene', 'intro']
    return order
      .map((k) => ({ kind: k, items: images.filter((i) => i.kind === k) }))
      .filter((g) => g.items.length > 0)
  }, [images])

  return (
    <div className="space-y-4">
      {/* 1. 产品图 / 参考图 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-slate-800">产品图（产品真身）</div>
              <div className="text-[11px] text-slate-500">AI 只照着这些图画，是产品事实的唯一来源</div>
            </div>
            <Button size="sm" variant="outline" disabled={busy === 'fetch'} onClick={() => void fetchFrom1688()}>
              {busy === 'fetch' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              从 1688 抓取
            </Button>
          </div>

          {fetchedInfo && (
            <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800">
              本次新增 {fetchedInfo.added} 张，现有 {fetchedInfo.total} 张
              {fetchedInfo.message ? `（${fetchedInfo.message}）` : ''}
            </div>
          )}

          <div className="mt-2 flex min-h-[80px] flex-wrap gap-2">
            {sources.length === 0 ? (
              <div className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 py-6 text-[11px] text-slate-400">
                <ImagePlus className="mb-1 h-5 w-5" />
                还没有产品图：点「从 1688 抓取」，或手动粘贴图片地址
              </div>
            ) : (
              sources.map((u, i) => (
                <div key={`${i}-${u.slice(0, 24)}`} className="relative">
                  <img src={u} alt="" className="h-16 w-16 rounded border border-slate-200 object-cover" />
                  <button
                    className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-slate-500 shadow hover:text-rose-600"
                    title="从产品图里删掉这张（不在生成时作为参考）"
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
              <div className="text-[13px] font-semibold text-slate-800">参考图（只学风格）</div>
              <div className="text-[11px] text-slate-500">学构图/排版/光线/场景，绝不会改你的产品</div>
            </div>
            <label className="cursor-pointer">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) pickRefFile(f)
                  e.target.value = ''
                }}
              />
              <span className="inline-flex h-8 items-center rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-700 hover:border-blue-300">
                <ImagePlus className="mr-1 h-3.5 w-3.5" /> 上传
              </span>
            </label>
          </div>

          <div className="mt-2 flex min-h-[80px] flex-wrap gap-2">
            {refs.length === 0 ? (
              <div className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 py-6 text-[11px] text-slate-400">
                还没有参考图（可选）。有好看的行业图片可以传上来，AI 会参考它的风格
              </div>
            ) : (
              refs.map((r) => (
                <div key={r.id} className="relative">
                  <img src={r.url} alt="" className="h-16 w-16 rounded border border-slate-200 object-cover" />
                  <button
                    className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-slate-500 shadow hover:text-rose-600"
                    onClick={() => void removeRef(r.id)}
                    title="删除这张参考图"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-2 flex gap-1.5">
            <input
              value={refPaste}
              onChange={(e) => setRefPaste(e.target.value)}
              placeholder="粘贴参考图地址（http(s)://…）"
              className="h-7 flex-1 rounded border border-slate-200 px-2 text-[11px] outline-none focus:border-blue-400"
            />
            <Button
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                const u = refPaste.trim()
                if (!/^https?:\/\//i.test(u)) {
                  toast.error('参考图地址要以 http(s):// 开头')
                  return
                }
                void addRefs({ urls: [u] })
              }}
            >
              添加
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-amber-700">
            参考图只提供构图/光线/场景，AI 不得修改产品的结构、外形、颜色、材质、配件、比例、功能和纹理。
          </p>
        </div>
      </div>

      {/* 2. 每种图各自的参考图与生成前对话 */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[13px] font-semibold text-slate-800">每张图参考哪些产品图</div>
            <div className="text-[11px] text-slate-500">
              四种图分别选各自的参考图，AI 只照着选中的图画；一张都不选就用全部产品图。生成前可以先和 AI 对话确认怎么拍。
            </div>
          </div>
        </div>

        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {(['main', 'dimension', 'detail', 'scene'] as const).map((k) => (
            <div key={k} className="rounded-lg border border-slate-200 px-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-medium text-slate-800">{KIND_LABEL[k]}</span>
                <span className="text-[11px] text-slate-400">
                  已选 {plan[k].sources.length ? `${plan[k].sources.length} 张` : '全部产品图'}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
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
                    <div key={`${k}-${i}`} className="relative">
                      <button
                        title={on ? '已选为这张图的参考图（点右上角 × 取消）' : '点一下，作为这张图的参考图'}
                        onClick={() => void setKindSources(k, on ? plan[k].sources.filter((x) => x !== u) : [...plan[k].sources, u])}
                        className={cn(
                          'block rounded border-2 p-0',
                          on ? 'border-blue-500' : 'border-transparent opacity-70 hover:opacity-100'
                        )}
                      >
                        <img src={u} alt="" className="h-10 w-10 rounded object-cover" />
                      </button>
                      {on && (
                        <button
                          title="取消这张参考图（不会删掉产品图本身）"
                          onClick={(e) => {
                            e.stopPropagation()
                            void setKindSources(k, plan[k].sources.filter((x) => x !== u))
                          }}
                          className="absolute -right-1.5 -top-1.5 rounded-full bg-white p-0.5 text-slate-500 shadow ring-1 ring-slate-200 hover:text-rose-600"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )
                })}
                {sources.length === 0 && <span className="text-[11px] text-slate-400">先在左边加产品图</span>}
              </div>
              {plan[k].sources.length > 0 && (
                <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                  <span>点缩略图加/减；× 取消这张参考</span>
                  <button
                    className="text-rose-500 hover:underline"
                    onClick={() => void setKindSources(k, [])}
                    title="清空后这张图会用全部产品图"
                  >
                    清空（用全部产品图）
                  </button>
                </div>
              )}

              <input
                value={plan[k].notes}
                onChange={(e) => setPlan((cur) => ({ ...cur, [k]: { ...cur[k], notes: e.target.value } }))}
                onBlur={async () => {
                  try {
                    await api.saveImagePlan(productId, { kind: k, notes: plan[k].notes })
                  } catch {
                    /* 静默失败，下次保存会带上 */
                  }
                }}
                placeholder="这张图的注意点（对话后自动填入，也可手改）"
                className="mt-1 h-7 w-full rounded border border-slate-200 px-2 text-[11px] outline-none focus:border-blue-400"
              />
            </div>
          ))}
        </div>
      </div>

      {/* 3. 生成设置 */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-slate-800">生成哪些图</div>
          <span className={cn('text-[11px]', over ? 'text-rose-600' : 'text-slate-400')}>
            主图 1 张 · 尺寸图 1 张 · 细节图 + 场景图合计 {detailSceneTotal} 张（上限 3）
          </span>
        </div>

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
            <input type="checkbox" className="h-3.5 w-3.5" checked={withLogo} onChange={(e) => setWithLogo(e.target.checked)} />
            主图加品牌 Logo
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
          <Button size="sm" disabled={busy === 'gen' || over || !kinds.length || !sources.length} onClick={() => void generate()}>
            {busy === 'gen' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            生成 {kinds.length} 张图（1200×1200）
          </Button>
          {!sources.length && <span className="text-[11px] text-amber-700">先加产品图才能生成</span>}
          {progress && <span className="text-[11px] text-slate-500">{progress}</span>}
        </div>
      </div>

      {/* 3. 结果 + 审查 */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-slate-800">已生成图片</div>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />} 刷新
          </Button>
        </div>

        {images.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-slate-400">还没有生成图片</div>
        ) : (
          <div className="mt-2 space-y-3">
            {grouped.map((g) => (
              <div key={g.kind}>
                <div className="mb-1 text-[11px] font-medium text-slate-500">{KIND_LABEL[g.kind] ?? g.kind}</div>
                <div className="flex flex-wrap gap-3">
                  {g.items.map((img) => (
                    <div key={img.id} className="w-40">
                      <div className="relative overflow-hidden rounded-lg border border-slate-200">
                        <img src={api.productImageUrl(img.productId, img.file)} alt="" className="h-40 w-40 object-contain" />
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        {reviewBadge(img)}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() => onChatImage(img)}
                        >
                          <MessageSquare className="mr-0.5 h-3 w-3" /> AI 修改
                        </Button>
                      </div>
                      {img.review && !img.review.ok && (
                        <ul className="mt-0.5 list-disc pl-3 text-[10px] text-amber-700">
                          {img.review.issues.slice(0, 3).map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 生成前对话：确认这张图怎么拍，AI 会给一段注意点 */}
      {chatKind && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center" onClick={() => setChatKind(null)}>
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <div className="text-[13px] font-semibold text-slate-800">
                生成前对话 · {KIND_LABEL[chatKind]}
              </div>
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
    </div>
  )
}

type ProductImageKindKey = ProductImage['kind']
