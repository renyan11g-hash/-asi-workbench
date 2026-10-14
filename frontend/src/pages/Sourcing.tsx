import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  History,
  Loader2,
  MinusCircle,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ScoreRing, SectionCard, VerdictBadge } from '@/components/ui/primitives'
import EvaluationChat from '@/components/EvaluationChat'
import { api, getErrorMessage } from '@/lib/api'
import { useProducts, useSettings } from '@/hooks/use-data'
import { useDraft, loadDraft } from '@/hooks/useDraft'
import { EMPTY_SOURCE, Evaluation, PriceRow, SourceInfo } from '@/types'
import { ASI_CATEGORIES } from '@/constants/asi'

function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-slate-600">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
    </div>
  )
}

const inputCls = 'h-9 text-sm'

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4MB each
const MAX_TOTAL_BYTES = 18 * 1024 * 1024 // 18MB total to keep payload reasonable

async function compressImage(file: File, maxEdge = 1280, quality = 0.85): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('图片读取失败'))
    i.src = URL.createObjectURL(file)
  })
  let { width, height } = img
  if (width > maxEdge || height > maxEdge) {
    const ratio = Math.min(maxEdge / width, maxEdge / height)
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持图片压缩')
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/jpeg', quality)
}

export default function Sourcing() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: settings } = useSettings()
  const { data: products } = useProducts()

  const [source, setSource] = useState<SourceInfo>(() => loadDraft<SourceInfo>('sourcing:source') ?? EMPTY_SOURCE)
  const [evaluation, setEvaluation] = useState<Evaluation | null>(() => loadDraft<Evaluation | null>('sourcing:evaluation') ?? null)
  const [priceGrid, setPriceGrid] = useState<PriceRow[]>(() => loadDraft<PriceRow[]>('sourcing:priceGrid') ?? [])
  const [keywordsText, setKeywordsText] = useState<string>(() => loadDraft<string>('sourcing:keywordsText') ?? '')
  const [imageText, setImageText] = useState<string>(() => loadDraft<string>('sourcing:imageText') ?? '')
  const [busy, setBusy] = useState(false)
  const [busySimilar, setBusySimilar] = useState(false)
  const [similar, setSimilar] = useState<Record<string, unknown> | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState<'save' | 'save-listing' | null>(null)
  const [fetching, setFetching] = useState(false)
  const [draftBanner, setDraftBanner] = useState<{ sourceAt: string; evaluationAt: string } | null>(() => {
    if (typeof window === 'undefined') return null
    const s = localStorage.getItem('asi-draft:sourcing:source')
    if (!s) return null
    try {
      const meta = JSON.parse(s)?.meta?.savedAt as string | undefined
      if (!meta) return null
      const eRaw = localStorage.getItem('asi-draft:sourcing:evaluation')
      const eMeta = eRaw ? (JSON.parse(eRaw)?.meta?.savedAt as string | undefined) : undefined
      // 只在确实有内容时显示
      const src = JSON.parse(s)?.value
      if (!src?.sourceTitle && !src?.description) return null
      return { sourceAt: meta, evaluationAt: eMeta ?? meta }
    } catch {
      return null
    }
  })

  // 草稿：实时缓存到 localStorage
  useDraft('sourcing:source', source)
  useDraft('sourcing:evaluation', evaluation)
  useDraft('sourcing:priceGrid', priceGrid)
  useDraft('sourcing:keywordsText', keywordsText)
  useDraft('sourcing:imageText', imageText)

  /** 需求 8：从 1688 链接自动抓取资料，尽量填充表单 */
  const runFetch1688 = async () => {
    const url = source.sourceUrl.trim()
    if (!url) {
      toast.error('请先粘贴 1688 商品链接')
      return
    }
    setFetching(true)
    try {
      const r = await api.fetch1688(url)
      const f = r.fetched ?? {}
      const applied: string[] = []
      setSource((s) => {
        const next = { ...s }
        if (f.sourceTitle && !next.sourceTitle) {
          next.sourceTitle = f.sourceTitle
          applied.push('标题')
        }
        if (f.description && !next.description) {
          next.description = f.description
          applied.push('描述')
        }
        if (f.materialCn && !next.materialCn) {
          next.materialCn = f.materialCn
          applied.push('材质')
        }
        if (f.colorsCn && !next.colorsCn) {
          next.colorsCn = f.colorsCn
          applied.push('颜色')
        }
        if (f.sizeCn && !next.sizeCn) {
          next.sizeCn = f.sizeCn
          applied.push('尺寸')
        }
        if (f.weightG && !next.weightG) {
          next.weightG = f.weightG
          applied.push('单件重')
        }
        if (f.moq && !next.moq) {
          next.moq = f.moq
          applied.push('MOQ')
        }
        // 箱规 "40x30x20" → L/W/H
        const m = (f.cartonSpecCm ?? '').match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/)
        if (m && !next.cartonLCm) {
          next.cartonLCm = Number(m[1])
          next.cartonWCm = Number(m[2])
          next.cartonHCm = Number(m[3])
          applied.push('箱规')
        }
        if (f.pcsPerCarton && !next.pcsPerCarton) {
          next.pcsPerCarton = f.pcsPerCarton
          applied.push('每箱数量')
        }
        if (f.cartonGwKg && !next.cartonGwKg) {
          next.cartonGwKg = f.cartonGwKg
          applied.push('箱毛重')
        }
        return next
      })
      if (f.sourceKeywords?.length && !keywordsText.trim()) {
        setKeywordsText(f.sourceKeywords.join(', '))
        applied.push('关键词')
      }
      if (r.ok) {
        toast.success(`${r.message}${applied.length ? `；已填入：${applied.join('、')}` : ''}`)
      } else {
        toast.warning(r.message)
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setFetching(false)
    }
  }

  /** 需求 8：生成问商家话术（向 1688 客服索取箱规等必要信息） */
  const copyAskSupplier = () => {
    const name = source.sourceTitle.trim() || '该产品'
    const msg = `您好，我想采购「${name}」用于出口定制，麻烦提供以下信息，方便我核算运费和报价：
1. 外箱尺寸（长×宽×高，cm）
2. 每箱装多少个？
3. 整箱毛重（kg）？
4. 单个产品净重（g）和尺寸？
5. 材质是什么？有哪些颜色？
6. 可以做哪些印刷方式（丝印 / 热转印 / 激光雕刻 / UV 彩印）？最大印刷面积是多少 cm？
7. 出口包装是彩盒、白盒还是 opp 袋？
麻烦发一份规格表，谢谢！`
    navigator.clipboard.writeText(msg).then(
      () => toast.success('话术已复制，直接粘贴发给 1688 客服即可'),
      () => toast.error('复制失败，请手动复制')
    )
  }

  const set = <K extends keyof SourceInfo>(key: K, value: SourceInfo[K]) =>
    setSource((s) => ({ ...s, [key]: value }))

  const buildSource = (): SourceInfo => ({
    ...source,
    images: [
      ...source.images,
      ...imageText
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
    ],
    sourceKeywords: keywordsText
      .split(/[\n,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
  })

  const runEvaluate = async () => {
    const payload = buildSource()
    if (!payload.sourceTitle.trim()) {
      toast.error('请先填写 1688 商品标题')
      return
    }
    if (!payload.priceCny) {
      toast.warning('未填写采购单价，成本测算会不准确')
    }
    setBusy(true)
    try {
      const res = await api.previewEvaluate(payload)
      setEvaluation(res.evaluation)
      setPriceGrid(res.priceGrid ?? [])
      setSource(payload)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const runFindSimilar = async () => {
    const payload = buildSource()
    if ((payload.images ?? []).length === 0) {
      toast.error('请先上传产品图片')
      return
    }
    setBusySimilar(true)
    try {
      const res = await api.previewFindSimilar(payload)
      setSimilar(res.similar)
      setSource(payload)
      toast.success('已生成类似商品建议')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusySimilar(false)
    }
  }

  const save = async (then: 'library' | 'listing') => {
    const payload = buildSource()
    if (!payload.sourceTitle.trim()) {
      toast.error('请先填写 1688 商品标题')
      return
    }
    setSaving(then === 'listing' ? 'save-listing' : 'save')
    try {
      const product = await api.createProduct({
        source: payload,
        evaluation,
        status: 'sourced',
      })
      // 草稿已落到产品库，清掉 localStorage 草稿避免下次误恢复
      ;['source', 'evaluation', 'priceGrid', 'keywordsText', 'imageText'].forEach((k) =>
        localStorage.removeItem(`asi-draft:sourcing:${k}`)
      )
      setDraftBanner(null)
      qc.invalidateQueries({ queryKey: ['products'] })
      toast.success('已保存到产品库')
      if (then === 'listing') navigate(`/listing/${product.id}`)
      else navigate('/library')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  const loadFrom = (id: string) => {
    const p = products?.find((x) => x.id === id)
    if (!p) return
    setSource(p.source)
    setKeywordsText((p.source.sourceKeywords ?? []).join('\n'))
    setImageText(
      (p.source.images ?? [])
        .filter((u) => u.startsWith('http'))
        .join('\n')
    )
    setEvaluation(p.evaluation)
    setPriceGrid(p.listing?.priceGrid ?? [])
    // 载入历史选品：清掉之前的草稿（避免两个不同产品的草稿混在一起）
    ;['source', 'evaluation', 'priceGrid', 'keywordsText', 'imageText'].forEach((k) =>
      localStorage.removeItem(`asi-draft:sourcing:${k}`)
    )
    setDraftBanner(null)
    toast.success('已载入历史选品')
  }

  const discardAllDrafts = () => {
    ;['source', 'evaluation', 'priceGrid', 'keywordsText', 'imageText'].forEach((k) =>
      localStorage.removeItem(`asi-draft:sourcing:${k}`)
    )
    setDraftBanner(null)
    // 同步重置 state，否则 React state 里仍残留旧值
    setSource(EMPTY_SOURCE)
    setEvaluation(null)
    setPriceGrid([])
    setKeywordsText('')
    setImageText('')
    setSimilar(null)
    toast.success('已清空草稿')
  }

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const arr = Array.from(files)
      const existing = source.images.length
      const remain = MAX_IMAGES - existing
      if (remain <= 0) {
        toast.error(`最多 ${MAX_IMAGES} 张图`)
        return
      }
      const picked = arr.slice(0, remain)
      const totalExistingBytes = source.images.reduce((s, u) => s + (u.startsWith('data:') ? u.length * 0.75 : 0), 0)
      let budget = MAX_TOTAL_BYTES - totalExistingBytes
      const out: string[] = []
      for (const f of picked) {
        if (f.size > MAX_IMAGE_BYTES) {
          toast.warning(`已跳过 ${f.name}：单图超过 4MB`)
          continue
        }
        if (budget <= 0) {
          toast.warning('图片总大小已达上限，跳过剩余')
          break
        }
        try {
          const dataUrl = await compressImage(f)
          out.push(dataUrl)
          budget -= dataUrl.length * 0.75
        } catch (err) {
          toast.warning(`已跳过 ${f.name}：${err instanceof Error ? err.message : '处理失败'}`)
        }
      }
      setSource((s) => ({ ...s, images: [...s.images, ...out] }))
      toast.success(`已添加 ${out.length} 张图`)
    } finally {
      setUploading(false)
    }
  }

  const removeImage = (idx: number) =>
    setSource((s) => ({ ...s, images: s.images.filter((_, i) => i !== idx) }))

  return (
    <div className="space-y-4">
      {draftBanner && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <div className="flex items-center gap-2">
            <History className="h-3.5 w-3.5" />
            <span>
              已自动恢复草稿（保存于 {new Date(draftBanner.sourceAt).toLocaleString('zh-CN')}）
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-amber-300 bg-white text-xs"
              onClick={discardAllDrafts}
            >
              <X className="mr-1 h-3 w-3" /> 丢弃草稿
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-12">
      <div className="space-y-4 lg:col-span-7">
        <SectionCard
          title="1688 商品信息"
          hint="信息越完整，AI 评估与英文链接质量越高。箱规和数量决定第一级"
          right={
            products && products.length > 0 ? (
              <select
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600"
                defaultValue=""
                onChange={(e) => e.target.value && loadFrom(e.target.value)}
              >
                <option value="">载入历史选品…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.source.sourceTitle.slice(0, 24) || '(未命名)'}
                  </option>
                ))}
              </select>
            ) : null
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="1688 商品标题" required>
                <Input
                  className={inputCls}
                  placeholder="如：定制logo不锈钢保温杯 20oz 真空保温"
                  value={source.sourceTitle}
                  onChange={(e) => set('sourceTitle', e.target.value)}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="1688 详细描述" hint="复制详情页正文：参数/材质/尺寸/卖点全部保留，AI 据此判断可印与合规">
                <Textarea
                  className="min-h-[120px] text-xs leading-relaxed"
                  placeholder="杯身采用 304 不锈钢，双层真空，容量 20oz（≈590ml），可激光雕刻 logo，可选颜色 12 种..."
                  value={source.description}
                  onChange={(e) => set('description', e.target.value)}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="1688 关键词（可选）" hint="一行一个或逗号分隔，来自 1688 详情页标签">
                <Textarea
                  className="min-h-[64px] text-xs"
                  placeholder="保温杯, 真空杯, 不锈钢杯, 定制水杯"
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="亚马逊 / 其他平台同类英文标题（可选）" hint="AI 会参考其句式与流量词生成 ASI 标题">
                <Input
                  className={inputCls}
                  placeholder="Custom 20 oz Stainless Steel Insulated Tumbler with Straw Lid"
                  value={source.amazonTitle}
                  onChange={(e) => set('amazonTitle', e.target.value)}
                />
              </Field>
            </div>
            <Field label="1688 商品链接" hint="粘贴后点「自动抓取」，可带出标题、材质、箱规等资料">
              <div className="flex gap-1.5">
                <Input
                  className={inputCls}
                  placeholder="https://detail.1688.com/offer/..."
                  value={source.sourceUrl}
                  onChange={(e) => set('sourceUrl', e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={fetching}
                  onClick={runFetch1688}
                >
                  {fetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  {fetching ? '抓取中…' : '自动抓取'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={copyAskSupplier}
                >
                  问商家话术
                </Button>
              </div>
            </Field>
            <Field label="供应商 / 店铺名">
              <Input
                className={inputCls}
                value={source.supplier}
                onChange={(e) => set('supplier', e.target.value)}
              />
            </Field>
            <Field label="ASI 类目（28 项官方分类）">
              <select
                className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
                value={source.category}
                onChange={(e) => set('category', e.target.value)}
              >
                <option value="">未选择（让 AI 推荐）</option>
                {ASI_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="采购单价（¥）" required>
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.01"
                value={source.priceCny || ''}
                onChange={(e) => set('priceCny', Number(e.target.value || 0))}
              />
            </Field>
            <Field label="价格上限（¥）" hint="1688 区间报价时可填">
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.01"
                value={source.priceMaxCny ?? ''}
                onChange={(e) => set('priceMaxCny', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label="起订量 MOQ（件）">
              <Input
                className={inputCls}
                type="number"
                min={0}
                value={source.moq || ''}
                onChange={(e) => set('moq', Number(e.target.value || 0))}
              />
            </Field>
            <Field label="单件重量（g）" required hint="决定体积重与计费重">
              <Input
                className={inputCls}
                type="number"
                min={0}
                value={source.weightG ?? ''}
                onChange={(e) => set('weightG', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label="材质（中文）">
              <Input
                className={inputCls}
                placeholder="如：304不锈钢"
                value={source.materialCn}
                onChange={(e) => set('materialCn', e.target.value)}
              />
            </Field>
            <Field label="颜色（中文）" hint="多色用空格分隔，黑白蓝红">
              <Input
                className={inputCls}
                placeholder="黑色 白色 蓝色 红色"
                value={source.colorsCn}
                onChange={(e) => set('colorsCn', e.target.value)}
              />
            </Field>
            <Field label="尺寸 / 规格">
              <Input
                className={inputCls}
                placeholder="如：20oz / 18×7cm"
                value={source.sizeCn}
                onChange={(e) => set('sizeCn', e.target.value)}
              />
            </Field>
            <Field label="备注" hint="可印刷方式、是否含电子件、包装方式等，都会影响评估">
              <Textarea
                className="min-h-[72px] text-sm"
                placeholder="如：可激光雕刻，含彩盒包装，有现货"
                value={source.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          title="箱规 / Carton"
          hint="系统用 max(体积重, 实际毛重) 计算运费：体积重 = L×W×H ÷ 5000"
        >
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="长 L (cm)">
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.1"
                value={source.cartonLCm ?? ''}
                onChange={(e) => set('cartonLCm', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label="宽 W (cm)">
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.1"
                value={source.cartonWCm ?? ''}
                onChange={(e) => set('cartonWCm', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label="高 H (cm)">
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.1"
                value={source.cartonHCm ?? ''}
                onChange={(e) => set('cartonHCm', e.target.value ? Number(e.target.value) : null)}
              />
            </Field>
            <Field label="每箱数量" required hint="决定单价运费分摊">
              <Input
                className={inputCls}
                type="number"
                min={1}
                value={source.pcsPerCarton ?? ''}
                onChange={(e) =>
                  set('pcsPerCarton', e.target.value ? Number(e.target.value) : null)
                }
              />
            </Field>
            <Field label="箱规毛重 (kg)" hint="含包装外边的话">
              <Input
                className={inputCls}
                type="number"
                min={0}
                step="0.01"
                value={source.cartonGwKg ?? ''}
                onChange={(e) =>
                  set('cartonGwKg', e.target.value ? Number(e.target.value) : null)
                }
              />
            </Field>
          </div>
        </SectionCard>

        <SectionCard
          title="产品图片（最多 6 张）"
          hint="AI 会基于图片识别产品类型、推荐亚马逊/ASI 搜索关键词，并估算印刷区域"
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 text-xs text-slate-600 hover:bg-slate-100">
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                上传图片
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    onUpload(e.target.files)
                    e.target.value = ''
                  }}
                />
              </label>
              <span className="text-[11px] text-slate-400">
                单图 ≤ 4MB，会自动压缩到 ≤ 1280px · 当前 {source.images.length}/{MAX_IMAGES}
              </span>
            </div>

            {source.images.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
                {source.images.map((u, i) => (
                  <div
                    key={i}
                    className="group relative aspect-square overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                  >
                    <img
                      src={u}
                      alt={`图片 ${i + 1}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      className="absolute right-1 top-1 hidden rounded-full bg-white/90 p-1 text-rose-500 shadow group-hover:block"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    {i === 0 && (
                      <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white">
                        主图
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div>
              <Field label="或粘贴图片地址（一行一个，可选）" hint="AI 也会参考网络图片（不能直接视觉识别，需 base64 上传）">
                <Textarea
                  className="min-h-[64px] text-xs"
                  placeholder={'https://.../1.jpg\nhttps://.../2.jpg'}
                  value={imageText}
                  onChange={(e) => setImageText(e.target.value)}
                />
              </Field>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={runFindSimilar} disabled={busySimilar || source.images.length === 0}>
                {busySimilar ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-1 h-4 w-4" />
                )}
                看图找亚马逊 / ASI 类似商品
              </Button>
            </div>
          </div>
        </SectionCard>

        <div className="flex flex-wrap gap-2">
          <Button onClick={runEvaluate} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-4 w-4" />
            )}
            {busy ? '评估中…' : 'AI 选品评估'}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSource(EMPTY_SOURCE)
              setImageText('')
              setKeywordsText('')
              setEvaluation(null)
              setPriceGrid([])
              setSimilar(null)
            }}
          >
            <RotateCcw className="mr-1 h-4 w-4" /> 清空
          </Button>
        </div>
      </div>

      <div className="space-y-4 lg:col-span-5">
        {!evaluation && !busy && !busySimilar && !similar && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
            <Wand2 className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-600">等待评估</p>
            <p className="mt-1 text-xs text-slate-400">
              填好左侧信息后点「AI 选品评估」，这里会给出适配度评分、
              <br />
              目标买家、使用场景和合规风险提示。
            </p>
          </div>
        )}

        {busy && (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              <div>
                <p className="text-sm font-medium">正在评估这个品在美国促销礼品市场的表现</p>
                <p className="text-xs text-slate-500">通常在 10-30 秒内完成</p>
              </div>
            </div>
          </div>
        )}

        {evaluation && !busy && (
          <>
            <SectionCard title="评估结论">
              <div className="flex items-start gap-5">
                <ScoreRing score={evaluation.score} />
                <div className="min-w-0 flex-1">
                  <VerdictBadge verdict={evaluation.verdict} score={evaluation.score} />
                  <p className="mt-2 text-sm leading-relaxed text-slate-700">
                    {evaluation.summary}
                  </p>
                  {evaluation.priceAdviceUsd?.max > 0 && (
                    <p className="mt-2 text-xs text-slate-500">
                      建议零售价区间：
                      <span className="font-semibold text-slate-800">
                        ${evaluation.priceAdviceUsd.min?.toFixed(2)} – $
                        {evaluation.priceAdviceUsd.max?.toFixed(2)}
                      </span>
                    </p>
                  )}
                  {!settings?.hasApiKey && (
                    <Alert className="mt-3 border-amber-200 bg-amber-50 py-2">
                      <AlertDescription className="text-[11px] text-amber-800">
                        当前为本地规则评分（未接 AI）。配置 API Key 后可获得买家画像、场景建议与完整风险分析。
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </div>
            </SectionCard>

            <SectionCard title="优劣势与风险">
              <div className="space-y-4">
                {[
                  {
                    title: '为什么值得做',
                    items: evaluation.pros,
                    icon: CheckCircle2,
                    cls: 'text-emerald-500',
                    empty: '未识别到明显优势',
                  },
                  {
                    title: '短板',
                    items: evaluation.cons,
                    icon: MinusCircle,
                    cls: 'text-amber-500',
                    empty: '暂未发现明显短板',
                  },
                  {
                    title: '风险提示',
                    items: evaluation.risks,
                    icon: AlertTriangle,
                    cls: 'text-rose-500',
                    empty: '暂无额外风险提示',
                  },
                ].map((group) => (
                  <div key={group.title}>
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                      <group.icon className={`h-3.5 w-3.5 ${group.cls}`} />
                      {group.title}
                    </div>
                    {group.items.length ? (
                      <ul className="space-y-1">
                        {group.items.map((it, i) => (
                          <li key={i} className="text-[13px] leading-relaxed text-slate-600">
                            · {it}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-slate-400">{group.empty}</p>
                    )}
                  </div>
                ))}
              </div>
            </SectionCard>

            {/* 弱点 + 改善建议（v3.1 增强） */}
            {(evaluation.issues?.length || evaluation.suggestions?.length) ? (
              <SectionCard
                title="弱点 + 改善策略"
                hint="AI 给出的具体问题点和上架动作，可直接照做"
              >
                <div className="space-y-4">
                  {evaluation.issues?.length ? (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-rose-600">
                        <AlertTriangle className="h-3.5 w-3.5" /> 弱点 / 问题点
                      </div>
                      <ul className="space-y-1">
                        {evaluation.issues.map((it, i) => (
                          <li key={i} className="text-[13px] leading-relaxed text-slate-700">
                            · {it}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {evaluation.suggestions?.length ? (
                    <div>
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" /> 改善策略 / 上架动作
                      </div>
                      <ul className="space-y-1">
                        {evaluation.suggestions.map((it, i) => (
                          <li key={i} className="text-[13px] leading-relaxed text-slate-700">
                            · {it}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </SectionCard>
            ) : null}

            {(evaluation.buyers?.length > 0 ||
              evaluation.occasions?.length > 0 ||
              evaluation.channels?.length > 0 ||
              evaluation.asiCategories?.length > 0 ||
              evaluation.suggestedThemes?.length) && (
              <SectionCard title="卖给谁、什么场合">
                <div className="space-y-3">
                  {[
                    { label: '目标买家', items: evaluation.buyers, cls: 'bg-blue-50 text-blue-700' },
                    { label: '使用场景', items: evaluation.occasions, cls: 'bg-violet-50 text-violet-700' },
                    { label: '销售渠道', items: evaluation.channels, cls: 'bg-slate-100 text-slate-700' },
                    {
                      label: 'ASI 类目',
                      items: evaluation.asiCategories,
                      cls: 'bg-emerald-50 text-emerald-700',
                    },
                    {
                      label: '推荐主题（5 个）',
                      items: evaluation.suggestedThemes ?? [],
                      cls: 'bg-pink-50 text-pink-700',
                    },
                  ]
                    .filter((g) => g.items.length > 0)
                    .map((g) => (
                      <div key={g.label}>
                        <div className="mb-1.5 text-xs font-medium text-slate-500">{g.label}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {g.items.map((it, i) => (
                            <span key={i} className={`rounded-md px-2 py-1 text-xs ${g.cls}`}>
                              {it}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              </SectionCard>
            )}

            {priceGrid.length > 0 && (
              <SectionCard
                title="ASI 标准价格表"
                hint={`汇率 ${settings?.settings.fxRate ?? '-'}，空运 ¥${settings?.settings.airRateCnyPerKg ?? 50}/kg，海运 ¥${settings?.settings.seaRateCnyPerKg ?? 20}/kg，计费重取 max(体积重, 毛重)`}
              >
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="pb-2">数量</th>
                      <th className="pb-2">运输</th>
                      <th className="pb-2">计费重</th>
                      <th className="pb-2">成本 ¥</th>
                      <th className="pb-2">倍率</th>
                      <th className="pb-2">建议售价</th>
                      <th className="pb-2">毛利率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceGrid.map((r) => (
                      <tr key={r.qty} className="border-t border-slate-100">
                        <td className="py-1.5 text-slate-600">{r.qty}</td>
                        <td className="py-1.5 text-slate-500">
                          {r.shipping === 'air' ? '空运' : '海运'}
                        </td>
                        <td className="py-1.5 text-slate-500">{r.billableKg} kg</td>
                        <td className="py-1.5 text-slate-500">¥{r.unitCostCny.toFixed(2)}</td>
                        <td className="py-1.5 text-slate-500">×{r.markupRate}</td>
                        <td className="py-1.5 font-semibold text-slate-900">
                          ${r.unitPrice.toFixed(2)}
                        </td>
                        <td className="py-1.5 text-emerald-600">{r.margin.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-slate-400">
                  前 {settings?.settings.airQtyLevels ?? 4} 档空运 1.4× → 1.32×，后 4 档海运 1.4× → 1.25×，整体阶梯递减且保证海运第一档 &lt; 空运最后一档。
                </p>
              </SectionCard>
            )}

            {evaluation.sourcingTips && (
              <SectionCard title="采购与谈判要点">
                <p className="text-[13px] leading-relaxed text-slate-600">
                  {evaluation.sourcingTips}
                </p>
              </SectionCard>
            )}

            {evaluation.listingHooks?.length > 0 && (
              <SectionCard
                title="可直接写进文案的卖点"
                right={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(evaluation.listingHooks.join('\n'))
                      toast.success('已复制')
                    }}
                  >
                    <Copy className="mr-1 h-3 w-3" /> 复制
                  </Button>
                }
              >
                <ul className="space-y-1.5">
                  {evaluation.listingHooks.map((h, i) => (
                    <li key={i} className="text-[13px] leading-relaxed text-slate-700">
                      · {h}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            <SectionCard title="继续讨论 / 让 AI 重新评估">
              <EvaluationChat
                productId={`sourcing:${(source.sourceTitle || 'untitled').slice(0, 30)}`}
                evaluation={evaluation}
                chatFn={async (_id, messages) => {
                  const r = await api.previewChatEvaluation(source, evaluation, messages)
                  return { evaluation: r.evaluation }
                }}
                onEvaluationUpdated={(e) => setEvaluation(e)}
              />
            </SectionCard>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save('listing')} disabled={Boolean(saving)}>
                {saving === 'save-listing' ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="mr-1 h-4 w-4" />
                )}
                保存并生成英文链接
              </Button>
              <Button variant="outline" onClick={() => save('library')} disabled={Boolean(saving)}>
                <Save className="mr-1 h-4 w-4" /> 仅保存
              </Button>
            </div>
          </>
        )}

        {similar && !busySimilar && (
          <SectionCard title="看图找的类似商品 / 参考分析">
            <SimilarResult similar={similar} />
          </SectionCard>
        )}

        {busySimilar && (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              <div>
                <p className="text-sm font-medium">正在基于图片搜索亚马逊 / ASI 类似商品…</p>
                <p className="text-xs text-slate-500">通常 10-30 秒</p>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

function SimilarResult({ similar }: { similar: Record<string, unknown> }) {
  const list = (key: string): string[] =>
    Array.isArray(similar[key]) ? ((similar[key] as unknown[]) as string[]) : []
  const asString = (key: string) => (typeof similar[key] === 'string' ? (similar[key] as string) : '')
  const asNumber = (key: string) =>
    typeof similar[key] === 'object' && similar[key] !== null
      ? (similar[key] as { min?: number; max?: number })
      : null
  return (
    <div className="space-y-4 text-xs">
      {asString('productType') && (
        <div>
          <div className="mb-1 text-slate-500">AI 识别类型</div>
          <div className="font-semibold text-slate-800">{asString('productType')}</div>
          {asString('categoryGuess') && (
            <div className="mt-0.5 text-[11px] text-slate-500">
              推测 ASI 类目：{asString('categoryGuess')}
            </div>
          )}
        </div>
      )}

      {list('visualFeatures').length > 0 && (
        <div>
          <div className="mb-1 text-slate-500">视觉特征</div>
          <div className="flex flex-wrap gap-1.5">
            {list('visualFeatures').map((v, i) => (
              <span key={i} className="rounded-md bg-slate-100 px-2 py-0.5 text-slate-700">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {list('amazonSearchTerms').length > 0 && (
        <div>
          <div className="mb-1 text-slate-500">亚马逊搜索关键词建议</div>
          <div className="flex flex-wrap gap-1.5">
            {list('amazonSearchTerms').map((v, i) => (
              <span key={i} className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700">
                {v}
              </span>
            ))}
          </div>
          {asString('amazonSearchUrl') && (
            <a
              className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline"
              href={asString('amazonSearchUrl')}
              target="_blank"
              rel="noreferrer"
            >
              → 在亚马逊搜「{list('amazonSearchTerms')[0]}」
            </a>
          )}
        </div>
      )}

      {list('asiSearchTerms').length > 0 && (
        <div>
          <div className="mb-1 text-slate-500">ASI / PPAI 搜索关键词</div>
          <div className="flex flex-wrap gap-1.5">
            {list('asiSearchTerms').map((v, i) => (
              <span key={i} className="rounded-md bg-emerald-50 px-2 py-0.5 text-emerald-700">
                {v}
              </span>
            ))}
          </div>
          {asString('asiSearchUrl') && (
            <a
              className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline"
              href={asString('asiSearchUrl')}
              target="_blank"
              rel="noreferrer"
            >
              → Google 找 ASI 分销商目录
            </a>
          )}
        </div>
      )}

      {list('referenceTitles').length > 0 && (
        <div>
          <div className="mb-1 text-slate-500">参考标题模板</div>
          <ul className="space-y-1 text-slate-700">
            {list('referenceTitles').map((v, i) => (
              <li key={i}>· {v}</li>
            ))}
          </ul>
        </div>
      )}

      {list('competingBrands').length > 0 && (
        <div>
          <div className="mb-1 text-slate-500">可能竞争品牌（参考）</div>
          <div className="flex flex-wrap gap-1.5">
            {list('competingBrands').map((v, i) => (
              <span key={i} className="rounded-md bg-pink-50 px-2 py-0.5 text-pink-700">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {(() => {
        const range = asNumber('priceRangeUsd')
        if (!range || (!range.min && !range.max)) return null
        return (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
            <div className="text-slate-500">参考价位（250pc 区间）</div>
            <div className="font-semibold text-emerald-700">
              ${range.min?.toFixed(2)} – ${range.max?.toFixed(2)}
            </div>
          </div>
        )
      })()}
    </div>
  )
}