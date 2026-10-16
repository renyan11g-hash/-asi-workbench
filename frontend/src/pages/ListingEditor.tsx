import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Globe,
  HelpCircle,
  History,
  Loader2,
  MessageSquare,
  RefreshCw,
  Ruler,
  Save,
  Search,
  Send,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CharCounter,
  ChipList,
  LIMITS,
  QcBadge,
  SectionCard,
  VerdictBadge,
} from '@/components/ui/primitives'
import EvaluationChat from '@/components/EvaluationChat'
import { api, getErrorMessage, listingToText } from '@/lib/api'
import { useProduct } from '@/hooks/use-data'
import { useDraft, loadDraft } from '@/hooks/useDraft'
import { Listing, PriceRow, SimilarResearch, SourceInfo } from '@/types'
import { ASI_IMPRINT_METHODS, ASI_MATERIALS, ASI_THEMES } from '@/constants/asi'
import { CategoryPicker } from '@/components/CategoryPicker'

function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  required?: boolean
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

/** 一键复制文本（带 toast 反馈） */
function copyText(text: string, msg = '已复制') {
  if (!text) {
    toast.warning('内容为空，无可复制')
    return
  }
  navigator.clipboard.writeText(text)
  toast.success(msg)
}

/** 字段旁的「复制」小按钮 */
function CopyBtn({ text, label = '复制', disabled }: { text: string; label?: string; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-[11px] text-slate-500 hover:text-blue-600"
      disabled={disabled}
      onClick={() => copyText(text)}
    >
      <Copy className="mr-1 h-3 w-3" /> {label}
    </Button>
  )
}

/** 单个面（W × H inch）的紧凑输入行 */
function FaceRow({
  label,
  w,
  h,
  onW,
  onH,
}: {
  label: string
  w: string
  h: string
  onW: (v: string) => void
  onH: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="flex items-center gap-1">
        <Input
          className="h-8 w-16 text-xs"
          type="number"
          step="0.1"
          min={0}
          placeholder="W"
          value={w}
          onChange={(e) => onW(e.target.value)}
        />
        <span className="text-[11px] text-slate-400">×</span>
        <Input
          className="h-8 w-16 text-xs"
          type="number"
          step="0.1"
          min={0}
          placeholder="H"
          value={h}
          onChange={(e) => onH(e.target.value)}
        />
        <span className="text-[10px] text-slate-400">in</span>
      </div>
    </div>
  )
}

const TITLE_LIMIT = LIMITS.title
const SUMMARY_LIMIT = LIMITS.summary
const DESC_LIMIT = LIMITS.description

interface ImprintFaces {
  frontW: string
  frontH: string
  backW: string
  backH: string
  wrapW: string
  wrapH: string
}

const EMPTY_FACES: ImprintFaces = {
  frontW: '',
  frontH: '',
  backW: '',
  backH: '',
  wrapW: '',
  wrapH: '',
}

/** 解析 AI 给的 imprintArea 字符串（"Front: 2.5\" W x 2\" H; Wrap: 8\" W x 3\" H"） */
function parseImprintFaces(text: string): ImprintFaces {
  if (!text) return EMPTY_FACES
  const out: ImprintFaces = { ...EMPTY_FACES }
  const pick = (label: string): { w: string; h: string } => {
    const re = new RegExp(
      `${label}\\s*:?\\s*([\\d.]+)\\s*"?\\s*W?\\s*[xX×*]\\s*([\\d.]+)\\s*"?\\s*H`,
      'i'
    )
    const m = text.match(re)
    return m ? { w: m[1], h: m[2] } : { w: '', h: '' }
  }
  const f = pick('Front')
  const b = pick('Back')
  const w = pick('Wrap')
  out.frontW = f.w
  out.frontH = f.h
  out.backW = b.w
  out.backH = b.h
  out.wrapW = w.w
  out.wrapH = w.h
  // 兜底：如果只识别了 front 而没识别 back，把 back 设为与 front 相同
  if (!out.backW && !out.backH && f.w) {
    out.backW = f.w
    out.backH = f.h
  }
  return out
}

/** 单个面 W/H 格式化 */
function formatFace(w: string, h: string): string {
  if (!w || !h) return ''
  return `${w}" W x ${h}" H`
}

/** 把三面尺寸合成为 imprintArea 字符串 */
function buildImprintString(faces: ImprintFaces): string {
  const parts: string[] = []
  if (faces.frontW && faces.frontH) parts.push(`Front: ${formatFace(faces.frontW, faces.frontH)}`)
  if (faces.backW && faces.backH) parts.push(`Back: ${formatFace(faces.backW, faces.backH)}`)
  if (faces.wrapW && faces.wrapH) parts.push(`Wrap: ${formatFace(faces.wrapW, faces.wrapH)}`)
  return parts.join('; ')
}

/** 规则估算：前端版的 imprint 估算（与后端同源算法） */
function clientEstimateImprint(source: SourceInfo, materialCn: string): ImprintFaces & { confidence: number; rationale: string } {
  const CM_TO_IN = 0.3937
  const SAFE = 0.85
  const mat = (materialCn + ' ' + (source.materialCn ?? '') + ' ' + (source.notes ?? '')).toLowerCase()
  let factor = 0.85
  let hint = '半曲面'
  if (/杯|瓶|壶|jar|mug|bottle|cup|tumbler|glass|玻璃杯|陶瓷/.test(mat)) {
    factor = 0.65
    hint = '曲面'
  } else if (/球|圆|环|手柄|sphere/.test(mat)) {
    factor = 0.5
    hint = '强曲面'
  } else if (/布|帆布|棉|涤|fabric|canvas|cotton|polyester|袋子|包/.test(mat)) {
    factor = 0.95
    hint = '平面'
  } else if (/纸|卡|notebook|book|笔记本|便签/.test(mat)) {
    factor = 0.95
    hint = '平面'
  }

  // 推断产品尺寸
  const nums: number[] = []
  const sz = source.sizeCn ?? ''
  const re = /(\d+(?:\.\d+)?)\s*(cm|厘米|mm|毫米)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sz))) {
    let n = Number(m[1])
    if (Number.isFinite(n) && n > 0 && n < 200) {
      const unit = (m[2] ?? '').toLowerCase()
      if (unit === 'mm' || unit === '毫米') n = n / 10
      nums.push(n)
    }
  }

  let L = 15
  let W = 10
  let H = 5
  let basis: 'sizeCn' | 'carton' | 'weight' | 'default' = 'default'
  if (nums.length >= 2) {
    const sorted = nums.slice(0, 3).sort((a, b) => b - a)
    L = sorted[0]
    W = sorted[1] ?? L * 0.6
    H = sorted[2] ?? L * 0.4
    basis = 'sizeCn'
  } else if (source.cartonLCm && source.pcsPerCarton && source.pcsPerCarton > 0) {
    L = source.cartonLCm * 0.5
    W = (source.cartonWCm ?? L * 0.8) * 0.5
    H = (source.cartonHCm ?? L * 0.6) * 0.5
    basis = 'carton'
  } else if (source.weightG && source.weightG > 0) {
    const side = Math.cbrt(source.weightG)
    L = side * 1.6
    W = side * 1.2
    H = side
    basis = 'weight'
  }

  const round1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0)
  const frontW = round1(L * CM_TO_IN * SAFE * factor)
  const frontH = round1(W * CM_TO_IN * SAFE * factor)
  const wrapW = round1(L * 2 * CM_TO_IN * factor * 0.7)
  const wrapH = round1(H * CM_TO_IN * SAFE * factor)
  const confidence = basis === 'sizeCn' ? 0.9 : basis === 'carton' ? 0.7 : basis === 'weight' ? 0.4 : 0.2
  return {
    frontW: String(frontW),
    frontH: String(frontH),
    backW: String(frontW),
    backH: String(frontH),
    wrapW: String(wrapW),
    wrapH: String(Math.min(wrapH, round1(wrapW * 0.4))),
    confidence,
    rationale: `按产品${basis === 'sizeCn' ? '尺寸' : basis === 'carton' ? '箱规' : basis === 'weight' ? '重量' : '默认'}估算（${hint}，留 15% 边距），请按真实产品外形微调。`,
  }
}

// ---------- 分块 AI 工具：单区块重新生成 + 分区 AI 对话窗口 ----------

/** 每个区块对应的可重生成字段（与后端 /regenerate-fields 支持的字段一致） */
const SECTION_FIELDS = {
  title: ['title', 'titleZh'],
  summary: ['summary', 'summaryZh'],
  description: ['description', 'descriptionZh'],
  keywords: ['keywords', 'keywordsZh'],
  category: ['category', 'categories'],
  material: ['material', 'materials'],
  colors: ['colors', 'colorChips'],
  imprint: ['imprintMethods'],
  warnings: ['warnings'],
} as const

/**
 * 区块级 AI 工具条：
 * - ⟳ 只重新生成本区块（不影响其他区块）
 * - 💬 打开本区块专属 AI 对话窗口，AI 返回的修改自动填入表单
 */
function SectionAiTools({
  productId,
  source,
  listing,
  fields,
  onApply,
  disabled,
}: {
  productId: string
  source: SourceInfo
  listing: Listing | null
  fields: readonly string[]
  onApply: (values: Record<string, unknown>) => void
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [input, setInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  const regen = async () => {
    setBusy(true)
    try {
      const r = await api.regenerateFields(productId, [...fields])
      onApply(r.values)
      toast.success('本区块已重新生成，请核对后保存')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || chatBusy) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setChatBusy(true)
    try {
      const r = await api.assistantChat({ source, listing, fields: [...fields], messages: next })
      setMessages([...next, { role: 'assistant', content: r.reply }])
      if (r.patch && Object.keys(r.patch).length > 0) {
        onApply(r.patch)
        toast.success('AI 已更新本区块，请核对后保存')
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setChatBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-1.5 text-slate-500 hover:text-blue-700"
        disabled={disabled || busy}
        onClick={() => void regen()}
        title="只重新生成本区块，不影响其他区块"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-1.5 text-slate-500 hover:text-blue-700"
        disabled={disabled}
        onClick={() => setChatOpen(true)}
        title="和 AI 讨论本区块"
      >
        <MessageSquare className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={chatOpen} onOpenChange={setChatOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-blue-600" /> AI 讨论本区块
            </DialogTitle>
            <DialogDescription>
              本窗口只修改当前区块（{fields.join(' / ')}），其他区块不受影响。AI 返回修改后会自动填入，核对后点「保存修改」。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 min-h-24 space-y-2 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3">
            {messages.length === 0 && (
              <p className="text-xs leading-relaxed text-slate-400">
                直接用中文告诉 AI 怎么改，例如：「标题里加上 20oz 和 Insulated」「关键词换成偏礼品场景的」「描述再口语化一点」。
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <span
                  className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-left text-xs leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'border border-slate-200 bg-white text-slate-800'
                  }`}
                >
                  {m.content}
                </span>
              </div>
            ))}
            {chatBusy && (
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" /> AI 思考中…
              </div>
            )}
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="告诉 AI 怎么改这个区块…（Enter 发送，Shift+Enter 换行）"
              className="min-h-[60px] text-sm"
            />
            <Button size="sm" onClick={() => void send()} disabled={chatBusy || !input.trim()}>
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setMessages([])} disabled={chatBusy}>
              清空对话
            </Button>
            <Button size="sm" onClick={() => setChatOpen(false)}>
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function ListingEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: product, isLoading } = useProduct(id)

  const [listing, setListing] = useState<Listing | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const syncedId = useRef<string | null>(null)
  const [draftMeta, setDraftMeta] = useState<{ savedAt: string } | null>(null)
  const [hasDraft, setHasDraft] = useState(false)
  const [imprintFaces, setImprintFaces] = useState<ImprintFaces>(EMPTY_FACES)
  const imprintSynced = useRef<string | null>(null)
  // 生成后确认（需求 2）：刚生成的 listing 处于"待确认"状态
  const [unconfirmed, setUnconfirmed] = useState(false)
  // 评估对话模态（需求 3）
  const [evalDialogOpen, setEvalDialogOpen] = useState(false)

  useEffect(() => {
    if (product && syncedId.current !== product.id) {
      // 优先用草稿（用户未保存的编辑），否则用产品当前 listing
      const draft = loadDraft<Listing>(`listing-edit:${product.id}`)
      let toUse: Listing | null = null
      if (draft && product.listing) {
        toUse = draft
        setDirty(true)
        setHasDraft(true)
        const raw =
          typeof window !== 'undefined'
            ? localStorage.getItem(`asi-draft:listing-edit:${product.id}`)
            : null
        if (raw) {
          try {
            const meta = JSON.parse(raw)?.meta
            if (meta?.savedAt) setDraftMeta({ savedAt: meta.savedAt })
          } catch {
            /* noop */
          }
        }
      } else {
        toUse = product.listing ?? null
        setHasDraft(false)
      }
      setListing(toUse)
      if (toUse) {
        // Imprint Area 默认留空，由用户自行填写（系统不再自动估算，避免与实物不符）
        setImprintFaces(parseImprintFaces(toUse.imprintArea))
        imprintSynced.current = product.id
      }
      syncedId.current = product.id
      setDirty(false)
    }
  }, [product])

  // 草稿：仅在 dirty=true 时写入（避免覆盖已保存的版本）
  useDraft(
    product ? `listing-edit:${product.id}` : 'listing-edit:unknown',
    listing,
    { debounceMs: 600 }
  )

  // 三面尺寸变化 → 同步到 listing.imprintArea（让草稿 / 保存都能拿到正确字符串）
  useEffect(() => {
    if (!listing) return
    if (imprintSynced.current !== product?.id) return
    const next = buildImprintString(imprintFaces)
    if (next && next !== listing.imprintArea) {
      setListing((l) => (l ? { ...l, imprintArea: next } : l))
      setDirty(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imprintFaces])

  const patch = (p: Partial<Listing>) => {
    setListing((l) => (l ? { ...l, ...p } : l))
    setDirty(true)
  }

  /** 触发生成：直接调用 AI 生成（不再弹窗询问，节省时间） */
  const doGenerate = async () => {
    if (!product) return
    setBusy(true)
    try {
      const updated = await api.generateProductListing(product.id)
      setListing(updated.listing)
      setDirty(false)
      setHasDraft(false)
      setDraftMeta(null)
      setUnconfirmed(true) // 进入"待确认"状态（需求 2）
      if (typeof window !== 'undefined') {
        localStorage.removeItem(`asi-draft:listing-edit:${product.id}`)
      }
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['product', id] })
      toast.success('英文链接已生成，请逐项核对')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  /** 旧 generate 保留兼容：直接调（如果以后想"跳过问题"按钮） */
  const generate = () => doGenerate()

  const discardDraft = () => {
    if (!product) return
    if (typeof window !== 'undefined') {
      localStorage.removeItem(`asi-draft:listing-edit:${product.id}`)
    }
    setListing(product.listing ?? null)
    setHasDraft(false)
    setDraftMeta(null)
    setDirty(false)
    toast.success('已丢弃未保存的草稿')
  }

  const save = async () => {
    if (!product || !listing) return
    setSaving(true)
    try {
      await api.updateProduct(product.id, { listing })
      setDirty(false)
      setHasDraft(false)
      setDraftMeta(null)
      if (typeof window !== 'undefined') {
        localStorage.removeItem(`asi-draft:listing-edit:${product.id}`)
      }
      qc.invalidateQueries({ queryKey: ['products'] })
      qc.invalidateQueries({ queryKey: ['product', id] })
      toast.success('已保存')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const reprice = async () => {
    if (!product) return
    try {
      const p = await api.reprice(product.id)
      setListing(p.listing ?? listing)
      qc.invalidateQueries({ queryKey: ['product', id] })
      toast.success('已按当前成本参数重算价格表')
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const setPrice = (qty: number, price: number) => {
    if (!listing) return
    const grid = listing.priceGrid.map((r) =>
      r.qty === qty
        ? {
            ...r,
            unitPrice: price,
            margin: r.unitCost > 0 ? (1 - r.unitCost / price) * 100 : 0,
          }
        : r
    )
    patch({ priceGrid: grid })
  }

  const toggleTheme = (t: string) => {
    if (!listing) return
    const set = new Set(listing.themes)
    if (set.has(t)) set.delete(t)
    else if (set.size < LIMITS.themes) set.add(t)
    patch({ themes: Array.from(set) })
  }

  /** 分块 AI：把「重新生成 / AI 对话」返回的字段值合并进当前 listing（不落库，确认后保存） */
  const applyValues = (values: Record<string, unknown>) => {
    patch(values as Partial<Listing>)
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
      </div>
    )
  }

  if (!product) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-sm text-slate-600">找不到这个商品</p>
        <Button className="mt-3" variant="outline" onClick={() => navigate('/library')}>
          返回产品库
        </Button>
      </div>
    )
  }

  const images = product.source.images ?? []

  return (
    <div className="space-y-5">
      {hasDraft && draftMeta && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <div className="flex items-center gap-2">
            <History className="h-3.5 w-3.5" />
            <span>
              已自动恢复未保存的草稿（{new Date(draftMeta.savedAt).toLocaleString('zh-CN')}）
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-amber-300 bg-white text-xs"
            onClick={discardDraft}
          >
            <X className="mr-1 h-3 w-3" /> 丢弃草稿
          </Button>
        </div>
      )}
      {unconfirmed && listing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-3.5 w-3.5" />
            <span>
              链接已生成。请逐项核对右侧标题 / 摘要 / 描述 / 关键词，<b>确认内容与产品实际相符</b>，再点上方
              「<b>✓ 确认无误可保存</b>」。确认前禁止保存 / 复制 / 下载。
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-amber-300 bg-white text-xs"
              onClick={generate}
              disabled={busy}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> 重新生成
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 bg-emerald-600 text-xs hover:bg-emerald-700"
              onClick={() => {
                setUnconfirmed(false)
                toast.success('已确认；如还有修改请继续编辑后点「保存修改」')
              }}
            >
              <CheckCircle2 className="mr-1 h-3 w-3" /> 确认无误可保存
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/library')}>
          <ArrowLeft className="mr-1 h-4 w-4" /> 产品库
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={generate} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
            {busy ? '生成中…' : product.listing ? '重新生成' : 'AI 生成 ASI 英文链接'}
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                setBusy(true)
                const r = await api.findSimilarForProduct(product.id)
                toast.success('已生成市场参考')
                qc.invalidateQueries({ queryKey: ['product', product.id] })
                qc.invalidateQueries({ queryKey: ['products'] })
                void r
              } catch (err) {
                toast.error(getErrorMessage(err))
              } finally {
                setBusy(false)
              }
            }}
            disabled={busy}
          >
            <Globe className="mr-1 h-4 w-4" /> 看图找类似
          </Button>
          {listing && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (unconfirmed) {
                    toast.warning('请先点"✓ 确认无误可保存"再保存')
                    return
                  }
                  void save()
                }}
                disabled={saving || !dirty || unconfirmed}
                title={unconfirmed ? '生成后请先逐项核对并点击"确认无误可保存"' : undefined}
              >
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                {unconfirmed ? '请先确认' : dirty ? '保存修改' : '已保存'}
              </Button>
              <Button
                variant="default"
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => {
                  setUnconfirmed(false)
                  toast.success('已确认；如还有修改请继续编辑后点「保存修改」')
                }}
                disabled={!unconfirmed}
              >
                <CheckCircle2 className="mr-1 h-4 w-4" /> 确认无误可保存
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(listingToText(listing))
                  toast.success('已复制完整链接内容')
                }}
                disabled={unconfirmed}
                title={unconfirmed ? '请先确认无误再复制' : undefined}
              >
                <Copy className="mr-1 h-4 w-4" /> 复制全文
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const blob = new Blob([listingToText(listing)], { type: 'text/plain;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${(listing.title || 'listing').slice(0, 40)}.txt`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                disabled={unconfirmed}
                title={unconfirmed ? '请先确认无误再下载' : undefined}
              >
                <Download className="mr-1 h-4 w-4" /> 下载
              </Button>
            </>
          )}
        </div>
      </div>

      <SectionCard
        title="1688 源信息"
        right={
          <div className="flex items-center gap-2">
            {product.evaluation && (
              <button
                type="button"
                onClick={() => setEvalDialogOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100"
                title="点击查看评估详情 / 继续讨论"
              >
                <VerdictBadge verdict={product.evaluation.verdict} score={product.evaluation.score} />
                <MessageSquare className="h-3 w-3" />
              </button>
            )}
            {listing && <QcBadge qc={listing.qc} />}
          </div>
        }
      >
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs text-slate-500">原标题</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {product.source.sourceTitle || '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">采购单价 / MOQ</div>
            <div className="mt-0.5 font-medium text-slate-800">
              ¥{product.source.priceCny} · {product.source.moq || '—'} 件
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">单件重 / 材质</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {product.source.weightG ? `${product.source.weightG} g` : '—'} ·{' '}
              {product.source.materialCn || '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">箱规 / 每箱</div>
            <div className="mt-0.5 font-medium text-slate-800">
              {product.source.cartonLCm ? `${product.source.cartonLCm}×${product.source.cartonWCm}×${product.source.cartonHCm} cm` : '—'}{' '}
              · {product.source.pcsPerCarton || '—'} pcs
            </div>
          </div>
        </div>
        {product.source.sourceUrl && (
          <a
            href={product.source.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            打开 1688 原链接 <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {images.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {images.slice(0, 8).map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                className="h-16 w-16 rounded-md border border-slate-200 object-cover"
                referrerPolicy="no-referrer"
              />
            ))}
          </div>
        )}
      </SectionCard>

      {product.similar && <SimilarCard similar={product.similar} />}

      {!listing && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-700">还没有生成 ASI 英文链接</p>
          <p className="mt-1 text-xs text-slate-500">
            系统会生成 Product Title (≤60)、Summary (≤130)、Full Description (≤800)、30 组关键词、ASI 类目与 5 个主题、材质、印刷方式、8 档价格（前 4 档空运、后 4 档海运，含中英对照）。
          </p>
          <Button className="mt-4" onClick={generate} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
            立即生成
          </Button>
        </div>
      )}

      {listing && (
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            {listing.source === 'template' && (
              <Alert className="border-amber-200 bg-amber-50">
                <AlertDescription className="text-xs text-amber-800">
                  这份内容来自本地模板（未接 AI），字段是占位骨架。到设置页配置 API Key 后重新生成才会有可用的英文文案。
                </AlertDescription>
              </Alert>
            )}

            <SectionCard
              title="Product Title"
              right={
                <div className="flex items-center gap-1">
                  <CharCounter value={listing.title} max={TITLE_LIMIT} />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.title}
                    onApply={applyValues}
                  />
                </div>
              }
              hint="≤60 字符。结构：关键词 + 流量词 + 卖点词 + 中心词。Title Case。右侧 ⟳ 只重生成标题，💬 与 AI 讨论标题。"
            >
              <Input
                value={listing.title}
                onChange={(e) => patch({ title: e.target.value.slice(0, TITLE_LIMIT) })}
                className="text-sm"
              />
              {listing.titleZh && (
                <p className="mt-2 text-xs text-slate-500">
                  中文参考：{listing.titleZh}
                </p>
              )}
            </SectionCard>

            <SectionCard
              title="Summary Description"
              right={
                <div className="flex items-center gap-1">
                  <CharCounter value={listing.summary} max={SUMMARY_LIMIT} />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.summary}
                    onApply={applyValues}
                  />
                </div>
              }
              hint="≤130 字符。突出核心卖点。末尾强制包含：Rush service is available"
            >
              <Textarea
                className="min-h-[64px] text-sm leading-relaxed"
                value={listing.summary}
                onChange={(e) => patch({ summary: e.target.value.slice(0, SUMMARY_LIMIT) })}
              />
              {listing.summaryZh && (
                <p className="mt-2 text-xs text-slate-500">中文参考：{listing.summaryZh}</p>
              )}
            </SectionCard>

            <SectionCard
              title="Full Description"
              right={
                <div className="flex items-center gap-1">
                  <CharCounter value={listing.description} max={DESC_LIMIT} />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.description}
                    onApply={applyValues}
                  />
                </div>
              }
              hint="≤800 字符。50-70% 产品描述 + 关键词自然融入；不堆砌；不出现尺寸。"
            >
              <Textarea
                className="min-h-[200px] text-sm leading-relaxed"
                value={listing.description}
                onChange={(e) => patch({ description: e.target.value.slice(0, DESC_LIMIT) })}
              />
              {listing.descriptionZh && (
                <details className="mt-2 text-xs text-slate-500">
                  <summary className="cursor-pointer text-slate-600">中文参考</summary>
                  <p className="mt-1 leading-relaxed">{listing.descriptionZh}</p>
                </details>
              )}
            </SectionCard>

            <SectionCard
              title="Keywords"
              right={
                <div className="flex items-center gap-2">
                  <CopyBtn text={(listing.keywords ?? []).join(', ')} label="复制" />
                  <CharCounter
                    value={(listing.keywords ?? []).length}
                    max={LIMITS.keywordMax}
                  />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.keywords}
                    onApply={applyValues}
                  />
                </div>
              }
              hint={`≤${LIMITS.keywordMax} 组，每组 ≤${LIMITS.keywordGroup} 字符、≤${LIMITS.keywordWords} 单词，Title Case；复制格式为「英文逗号隔开」。已剔除 Disney/Marvel/NBA 等品牌词。`}
            >
              <ChipList
                items={listing.keywords ?? []}
                variant="blue"
                onRemove={(i) => patch({ keywords: listing.keywords.filter((_, idx) => idx !== i) })}
                onAdd={(v) =>
                  patch({
                    keywords: [...(listing.keywords ?? []), v].slice(0, LIMITS.keywordMax),
                  })
                }
                placeholder="输入关键词回车"
              />
              {listing.keywordsZh && (
                <p className="mt-2 text-xs text-slate-500">中文参考：{listing.keywordsZh}</p>
              )}
            </SectionCard>

            <SectionCard
              title="ASI 类目 / Categories / Themes / Material"
              hint="必填项与下拉框数据来自 ASI 官方模板"
              right={
                <SectionAiTools
                  productId={product.id}
                  source={product.source}
                  listing={listing}
                  fields={SECTION_FIELDS.category}
                  onApply={applyValues}
                />
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Categories（最多 2 个，从金山文档类目表选择）"
                  hint="数据来自金山文档「Categories」表（1620 项）；第 1 个自动作为主类目"
                  required
                >
                  <CategoryPicker
                    value={listing.categories ?? [listing.category].filter(Boolean)}
                    max={2}
                    onChange={(next) => patch({ categories: next, category: next[0] ?? listing.category })}
                  />
                </Field>
                <Field
                  label="Material（主材质）"
                  required
                  hint="多材质用逗号隔开，chips 可增删；复制格式为「英文逗号隔开」"
                >
                  <select
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm"
                    value={listing.material}
                    onChange={(e) => {
                      const m = e.target.value
                      const set = new Set(listing.materials ?? [listing.material].filter(Boolean))
                      set.add(m)
                      patch({ material: m, materials: Array.from(set) })
                    }}
                  >
                    <option value="">未选择</option>
                    {ASI_MATERIALS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 flex items-center gap-2">
                    <ChipList
                      items={listing.materials ?? (listing.material ? [listing.material] : [])}
                      variant="blue"
                      onRemove={(i) => {
                        const cur = listing.materials ?? (listing.material ? [listing.material] : [])
                        const next = cur.filter((_, idx) => idx !== i)
                        patch({
                          materials: next,
                          material: next[0] ?? listing.material,
                        })
                      }}
                      onAdd={(v) => {
                        const cur = listing.materials ?? (listing.material ? [listing.material] : [])
                        const next = Array.from(new Set([...cur, v.trim()])).filter(Boolean)
                        patch({
                          materials: next,
                          material: listing.material || next[0] || '',
                        })
                      }}
                      placeholder="添加材质（英文，回车确认）"
                    />
                    <CopyBtn text={(listing.materials ?? [listing.material].filter(Boolean)).join(', ')} />
                  </div>
                </Field>
                <div className="sm:col-span-2">
                  <Field
                    label={`Themes（已选 ${listing.themes.length} / ${LIMITS.themes}，必含 Anniversary + Sustainable）`}
                    hint="复制格式为「英文逗号隔开」"
                  >
                    <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto rounded-md border border-slate-200 p-2">
                      {ASI_THEMES.map((t) => {
                        const on = listing.themes.includes(t)
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => toggleTheme(t)}
                            className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                              on
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            {t}
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-2">
                      <CopyBtn text={listing.themes.join(', ')} />
                    </div>
                  </Field>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Colors"
              right={
                <div className="flex items-center gap-1">
                  <CopyBtn text={listing.colors} />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.colors}
                    onApply={applyValues}
                  />
                </div>
              }
              hint={`ASI 标准格式：Black/Gray/Brown/Orange/Army Green（用 / 隔开）。chips 与字符串会自动同步；复制格式同上。`}
            >
              <Field label="Colors (string)">
                <Input
                  className="h-9 text-sm"
                  value={listing.colors}
                  onChange={(e) => {
                    const txt = e.target.value
                    const chips = txt
                      .split('/')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    patch({ colors: txt, colorChips: chips })
                  }}
                />
              </Field>
              <div className="mt-3">
                <Field label="Color Chips（可点击删除）">
                  <ChipList
                    items={listing.colorChips ?? []}
                    variant="blue"
                    onRemove={(i) => {
                      const chips = listing.colorChips.filter((_, idx) => idx !== i)
                      patch({ colorChips: chips, colors: chips.join('/') })
                    }}
                    onAdd={(v) => {
                      const chips = Array.from(new Set([...listing.colorChips, v.trim()])).filter(
                        Boolean
                      )
                      patch({ colorChips: chips, colors: chips.join('/') })
                    }}
                    placeholder="增加颜色"
                  />
                </Field>
              </div>
            </SectionCard>

            <SectionCard
              title="Imprint Method"
              right={
                <div className="flex items-center gap-1">
                  <CopyBtn text={(listing.imprintMethods ?? []).join('/')} />
                  <SectionAiTools
                    productId={product.id}
                    source={product.source}
                    listing={listing}
                    fields={SECTION_FIELDS.imprint}
                    onApply={applyValues}
                  />
                </div>
              }
              hint={`可多选，无数量上限；必含 Silkscreen / Unimprinted / Full Color（保存时系统强制补齐）。复制格式用英文 / 隔开、无空格（如 Silkscreen/Unimprinted/Full Color）。`}
            >
              <ChipList
                items={listing.imprintMethods}
                variant="blue"
                onRemove={(i) =>
                  patch({ imprintMethods: listing.imprintMethods.filter((_, idx) => idx !== i) })
                }
                onAdd={(v) => {
                  const next = Array.from(new Set([...listing.imprintMethods, v.trim()])).filter(
                    Boolean
                  )
                  patch({ imprintMethods: next })
                }}
              />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {ASI_IMPRINT_METHODS.filter((m) => !listing.imprintMethods.includes(m)).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch({ imprintMethods: [...listing.imprintMethods, m] })}
                    className="rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700"
                  >
                    + {m}
                  </button>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              title="产品尺寸 / 重量 / 包装"
              right={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    if (!product) return
                    const est = clientEstimateImprint(product.source, listing.material ?? '')
                    setImprintFaces({
                      frontW: est.frontW,
                      frontH: est.frontH,
                      backW: est.backW,
                      backH: est.backH,
                      wrapW: est.wrapW,
                      wrapH: est.wrapH,
                    })
                    toast.success(`已按产品尺寸自动估算（置信度 ${Math.round(est.confidence * 100)}%）：${est.rationale}`)
                  }}
                >
                  <Ruler className="mr-1 h-3 w-3" /> 按产品尺寸自动估算
                </Button>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <Ruler className="h-3.5 w-3.5" /> Imprint Area（按面分开，英寸）
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                    <FaceRow label="Front 正面" w={imprintFaces.frontW} h={imprintFaces.frontH}
                      onW={(v) => setImprintFaces({ ...imprintFaces, frontW: v })}
                      onH={(v) => setImprintFaces({ ...imprintFaces, frontH: v })} />
                    <FaceRow label="Back 背面" w={imprintFaces.backW} h={imprintFaces.backH}
                      onW={(v) => setImprintFaces({ ...imprintFaces, backW: v })}
                      onH={(v) => setImprintFaces({ ...imprintFaces, backH: v })} />
                    <FaceRow label="Wrap 环绕" w={imprintFaces.wrapW} h={imprintFaces.wrapH}
                      onW={(v) => setImprintFaces({ ...imprintFaces, wrapW: v })}
                      onH={(v) => setImprintFaces({ ...imprintFaces, wrapH: v })} />
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    预览：<span className="text-slate-700">{buildImprintString(imprintFaces) || '—'}</span>
                  </p>
                  <p className="mt-1 text-[10px] text-slate-400">
                    估算规则：取产品最长边 L、按 1cm = 0.394 inch、留 15% 边距、杯瓶等曲面再 ×0.65。结果仅供参考，请按真实样品核对。
                  </p>
                </div>
                <Field label="Production Time">
                  <Input
                    className="h-9 text-sm"
                    value={listing.productionTime}
                    onChange={(e) => patch({ productionTime: e.target.value })}
                  />
                </Field>
                <Field label="Product Size (inch)" hint="系统按 1 cm = 0.3937 inch 自动换算，下方 cm 可改">
                  <Input
                    className="h-9 text-sm"
                    value={listing.productSizeInch}
                    onChange={(e) => patch({ productSizeInch: e.target.value })}
                  />
                </Field>
                <Field label="Product Size (cm)" hint="产品本身的尺寸，L × W × H；用于提交表最右列">
                  <div className="flex items-center gap-1">
                    <Input
                      className="h-9 w-16 text-sm"
                      type="number"
                      step="0.1"
                      placeholder="L"
                      value={listing.productSizeCm?.l ?? ''}
                      onChange={(e) =>
                        patch({
                          productSizeCm: {
                            l: Number(e.target.value) || 0,
                            w: listing.productSizeCm?.w ?? 0,
                            h: listing.productSizeCm?.h ?? 0,
                          },
                        })
                      }
                    />
                    <span className="text-[11px] text-slate-400">×</span>
                    <Input
                      className="h-9 w-16 text-sm"
                      type="number"
                      step="0.1"
                      placeholder="W"
                      value={listing.productSizeCm?.w ?? ''}
                      onChange={(e) =>
                        patch({
                          productSizeCm: {
                            l: listing.productSizeCm?.l ?? 0,
                            w: Number(e.target.value) || 0,
                            h: listing.productSizeCm?.h ?? 0,
                          },
                        })
                      }
                    />
                    <span className="text-[11px] text-slate-400">×</span>
                    <Input
                      className="h-9 w-16 text-sm"
                      type="number"
                      step="0.1"
                      placeholder="H"
                      value={listing.productSizeCm?.h ?? ''}
                      onChange={(e) =>
                        patch({
                          productSizeCm: {
                            l: listing.productSizeCm?.l ?? 0,
                            w: listing.productSizeCm?.w ?? 0,
                            h: Number(e.target.value) || 0,
                          },
                        })
                      }
                    />
                    <span className="text-[10px] text-slate-400">cm</span>
                  </div>
                </Field>
                <Field label="Carton Size (inch)" hint="系统按箱规 cm 自动换算">
                  <Input
                    className="h-9 text-sm"
                    value={listing.cartonSizeInch}
                    onChange={(e) => patch({ cartonSizeInch: e.target.value })}
                  />
                </Field>
                <Field label="Unit Weight (lb)">
                  <Input
                    className="h-9 text-sm"
                    type="number"
                    step="0.01"
                    value={listing.unitWeightLb ?? ''}
                    onChange={(e) =>
                      patch({ unitWeightLb: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </Field>
                <Field label="Carton Gross Weight (lb)">
                  <Input
                    className="h-9 text-sm"
                    type="number"
                    step="0.01"
                    value={listing.cartonGwLb ?? ''}
                    onChange={(e) =>
                      patch({ cartonGwLb: e.target.value ? Number(e.target.value) : null })
                    }
                  />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Packaging">
                    <Textarea
                      className="min-h-[60px] text-sm"
                      value={listing.packaging}
                      onChange={(e) => patch({ packaging: e.target.value })}
                    />
                  </Field>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="合规提示 / Warnings"
              right={
                <SectionAiTools
                  productId={product.id}
                  source={product.source}
                  listing={listing}
                  fields={SECTION_FIELDS.warnings}
                  onApply={applyValues}
                />
              }
            >
              <ChipList
                items={listing.warnings}
                onRemove={(i) => patch({ warnings: listing.warnings.filter((_, idx) => idx !== i) })}
                onAdd={(v) => patch({ warnings: [...listing.warnings, v.trim()].filter(Boolean) })}
                placeholder="如 Hand wash only"
              />
            </SectionCard>
          </div>

          <div className="space-y-4 lg:col-span-4">
            <SectionCard
              title="阶梯报价 (8C · 前 4 空运 / 后 4 海运)"
              hint="售价可直接改，毛利自动重算。空运 1.4×→1.32×（自动抬升以保证海运第一档 < 空运最后一档），海运 1.4×→1.25×"
              right={
                <Button variant="ghost" size="sm" onClick={reprice}>
                  <RefreshCw className="mr-1 h-3 w-3" /> 重算
                </Button>
              }
            >
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="pb-2">Qty</th>
                    <th className="pb-2">方式</th>
                    <th className="pb-2">计费</th>
                    <th className="pb-2">×倍率</th>
                    <th className="pb-2">售价 $</th>
                    <th className="pb-2">毛利</th>
                  </tr>
                </thead>
                <tbody>
                  {(listing.priceGrid ?? []).map((r: PriceRow) => (
                    <tr key={r.qty} className="border-t border-slate-100">
                      <td className="py-1.5 text-slate-600">{r.qty}</td>
                      <td className="py-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            r.shipping === 'air'
                              ? 'bg-blue-50 text-blue-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {r.shipping === 'air' ? '空运' : '海运'}
                        </span>
                      </td>
                      <td className="py-1.5 text-slate-500">{r.billableKg}kg</td>
                      <td className="py-1.5 text-slate-500">×{r.markupRate}</td>
                      <td className="py-1">
                        <Input
                          className="h-7 w-20 text-xs"
                          type="number"
                          step="0.01"
                          value={r.unitPrice}
                          onChange={(e) => setPrice(r.qty, Number(e.target.value || 0))}
                        />
                      </td>
                      <td
                        className={`py-1.5 font-medium ${
                          r.margin >= 30 ? 'text-emerald-600' : 'text-amber-600'
                        }`}
                      >
                        {r.margin.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                计费重 = max(体积重 = L×W×H ÷ 5000, 箱毛重)。空运 ¥50/kg、海运 ¥20/kg。
                成本 = 计费重 × 费率 ÷ 每箱数量 + 采购价。
              </p>
            </SectionCard>

            {listing.qc && (
              <SectionCard
                title="ASI 标准质检（ilovecargo 等价检测）"
                hint="每次生成 / 保存后自动按同一套规则逐条校验"
              >
                {listing.qc.ilovecargo?.length ? (
                  <ul className="space-y-1.5">
                    {listing.qc.ilovecargo.map((r) => (
                      <li key={r.key} className="flex items-start gap-2 text-[12px] leading-relaxed">
                        <span className={r.ok ? 'text-emerald-500' : 'text-rose-500'}>
                          {r.ok ? '✓' : '✗'}
                        </span>
                        <span className="text-slate-700">
                          {r.label}
                          <span className="ml-1 text-slate-400">
                            （当前 {r.value}）
                            {r.reason ? ` · ${r.reason}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-400">
                    旧数据没有逐条检测记录，点「重新生成」或修改保存后会出现。
                  </p>
                )}
                {listing.qc.issues?.length ? (
                  <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-[12px] text-amber-700">
                    {listing.qc.issues.map((it, i) => (
                      <li key={i}>· {it}</li>
                    ))}
                  </ul>
                ) : null}
                <a
                  href="https://ilovecargo.com/tool/encode"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
                >
                  去 ilovecargo.com/tool/encode 复核 <ExternalLink className="h-3 w-3" />
                </a>
              </SectionCard>
            )}

            <SectionCard title="中文对照（人工核查）">
              <div className="space-y-3 text-xs">
                <div>
                  <div className="text-slate-500">标题</div>
                  <div className="mt-0.5 text-slate-800">{listing.titleZh || '—'}</div>
                </div>
                <div>
                  <div className="text-slate-500">摘要</div>
                  <div className="mt-0.5 text-slate-800">{listing.summaryZh || '—'}</div>
                </div>
                <div>
                  <div className="text-slate-500">详细描述</div>
                  <div className="mt-0.5 whitespace-pre-wrap leading-relaxed text-slate-800">
                    {listing.descriptionZh || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500">关键词</div>
                  <div className="mt-0.5 text-slate-800">{listing.keywordsZh || '—'}</div>
                </div>
              </div>
            </SectionCard>

            {product.evaluation && (
              <SectionCard title="选品评估回顾">
                <p className="text-[13px] leading-relaxed text-slate-600">
                  {product.evaluation.summary}
                </p>
                {product.evaluation.listingHooks?.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {product.evaluation.listingHooks.map((h, i) => (
                      <li key={i} className="text-xs text-slate-500">
                        · {h}
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            )}
          </div>
        </div>
      )}

      {/* 评估详情 + 继续讨论（需求 3：MAYBE 按钮） */}
      <Dialog open={evalDialogOpen} onOpenChange={setEvalDialogOpen}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-blue-600" />
              选品评估 · {product.evaluation?.verdict ?? ''} {product.evaluation?.score ?? ''}
            </DialogTitle>
            <DialogDescription>
              补充信息（颜色 / 印花 / 资质 / 客户反馈）后，AI 会按对话历史重新评估这个产品。
            </DialogDescription>
          </DialogHeader>

          {product.evaluation && (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
                <p className="text-sm leading-relaxed text-slate-700">
                  {product.evaluation.summary}
                </p>
                {product.evaluation.issues?.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-semibold text-rose-600">弱点 / 问题点</div>
                    <ul className="space-y-0.5 text-[12px] text-slate-700">
                      {product.evaluation.issues.map((it, i) => (
                        <li key={i}>· {it}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {product.evaluation.suggestions?.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-xs font-semibold text-emerald-700">改善策略</div>
                    <ul className="space-y-0.5 text-[12px] text-slate-700">
                      {product.evaluation.suggestions.map((it, i) => (
                        <li key={i}>· {it}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div>
                <EvaluationChat
                  productId={product.id}
                  evaluation={product.evaluation}
                  chatFn={api.chatEvaluation as unknown as (
                    id: string,
                    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
                  ) => Promise<unknown>}
                  onEvaluationUpdated={(e) => {
                    // product 来自 useQuery 的缓存，调用 invalidate 触发刷新
                    qc.invalidateQueries({ queryKey: ['product', product.id] })
                    void e
                  }}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEvalDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 市场参考卡：亚马逊 / ASI 类似商品与建议（持久化，随产品保留） */
function SimilarCard({ similar }: { similar: SimilarResearch }) {
  const openAsinseed = (asin: string) => {
    navigator.clipboard.writeText(asin).catch(() => undefined)
    toast.success(`ASIN ${asin} 已复制，粘贴到 asinseed 查询`)
    window.open('https://www.asinseed.com/cn', '_blank', 'noreferrer')
  }
  const amazonItems = similar.amazonItems ?? []
  const asiItems = similar.asiItems ?? []
  const range = similar.priceRangeUsd

  return (
    <SectionCard
      title="市场参考：亚马逊 / ASI 类似商品与建议"
      hint="来自「看图找类似」，随产品保留；点 ASIN 可复制并打开 asinseed 反查关键词"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {similar.productType && (
            <span className="font-semibold text-slate-800">{similar.productType}</span>
          )}
          {similar.categoryGuess && (
            <span className="text-slate-500">推测 ASI 类目：{similar.categoryGuess}</span>
          )}
          {range && (range.min != null || range.max != null) && (
            <span className="text-slate-500">
              参考价位：${range.min ?? '—'} - ${range.max ?? '—'}（250 件档）
            </span>
          )}
        </div>

        {amazonItems.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">亚马逊同类商品</div>
            <ul className="space-y-2">
              {amazonItems.map((it, i) => (
                <li key={i} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-slate-800">{it.title}</span>
                    {it.priceUsd != null && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                        ${it.priceUsd}
                      </span>
                    )}
                  </div>
                  {it.note && <p className="mt-0.5 text-[11px] text-slate-500">{it.note}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    {it.asin && (
                      <>
                        <button
                          type="button"
                          onClick={() => openAsinseed(it.asin!)}
                          className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 hover:bg-blue-100"
                        >
                          <Search className="h-3 w-3" /> {it.asin} → asinseed 反查关键词
                        </button>
                        <a
                          href={`https://www.amazon.com/dp/${it.asin}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          Amazon <ExternalLink className="h-3 w-3" />
                        </a>
                      </>
                    )}
                    <a
                      href={`https://www.amazon.com/s?k=${encodeURIComponent(it.title.slice(0, 70))}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      去 Amazon 找这条（复制 ASIN） <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {asiItems.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">ASI 分销商同类商品</div>
            <ul className="space-y-1.5">
              {asiItems.map((it, i) => (
                <li key={i} className="text-[13px] text-slate-700">
                  · {it.title}
                  {it.brand && <span className="text-slate-400">（{it.brand}）</span>}
                  {it.note && <span className="ml-1 text-[11px] text-slate-400">{it.note}</span>}
                  {it.url && (
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline"
                    >
                      链接 <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {similar.referenceTitles?.length ? (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">参考标题模板</div>
            <ul className="space-y-1 text-[12px] text-slate-600">
              {similar.referenceTitles.map((t, i) => (
                <li key={i}>· {t}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {similar.suggestions?.length ? (
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">策略建议</div>
            <ul className="space-y-1 text-[12px] leading-relaxed text-slate-600">
              {similar.suggestions.map((s, i) => (
                <li key={i}>· {s}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-[11px]">
          <a
            href={`https://www.amazon.com/s?k=${encodeURIComponent(similar.productType || 'promotional product')}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            在 Amazon 搜同类 <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href="https://lens.google.com/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            Google 识图（上传产品图） <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href="https://www.asinseed.com/cn"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            asinseed 关键词反查 <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href="https://ilovecargo.com/tool/encode"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            ilovecargo 质检 <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {similar.generatedAt && (
          <p className="text-[11px] text-slate-400">
            生成于 {new Date(similar.generatedAt).toLocaleString('zh-CN')}
          </p>
        )}
      </div>
    </SectionCard>
  )
}