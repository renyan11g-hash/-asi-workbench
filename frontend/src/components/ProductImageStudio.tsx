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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [src, rf, imgs] = await Promise.all([
        api.getSourceImages(productId),
        api.listRefImages(productId),
        api.listProductImages(productId),
      ])
      setSources(src.images ?? [])
      setRefs(rf.refs ?? [])
      setImages(imgs ?? [])
    } catch {
      /* 单个接口失败不阻塞页面 */
    } finally {
      setLoading(false)
    }
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

  const generate = async () => {
    if (!kinds.length) {
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
                <img key={`${i}-${u.slice(0, 24)}`} src={u} alt="" className="h-16 w-16 rounded border border-slate-200 object-cover" />
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

      {/* 2. 生成设置 */}
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
    </div>
  )
}

type ProductImageKindKey = ProductImage['kind']
