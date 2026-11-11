import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Database,
  Download,
  ExternalLink,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SectionCard } from '@/components/ui/primitives'
import { useNavigate } from 'react-router-dom'
import { api, getErrorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProductSpecCards } from './ProductSpecs'
import { MasterProduct, MasterStage } from '@/types'

/** 资料库列表上方的分类：一条资料现在走到哪一关（判定在后台 stageOf 里，口径与流水线一致） */
const STAGE_META: Record<MasterStage, { label: string; hint: string; badge: string }> = {
  'need-specs': {
    label: '待补全资料',
    hint: '缺箱规 / 克重 / 图片等，补齐才能评估',
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  'need-eval': {
    label: '待评估',
    hint: '资料齐全，还没跑 AI 选品评估',
    badge: 'border-sky-200 bg-sky-50 text-sky-700',
  },
  'need-listing': {
    label: '待生成英文链接',
    hint: '评估已经出结果，还没生成英文 listing',
    badge: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  },
  'need-pre': {
    label: '待录入预产品库',
    hint: '英文链接已生成，等审核通过进预产品库',
    badge: 'border-violet-200 bg-violet-50 text-violet-700',
  },
  pre: {
    label: '已在预产品库',
    hint: '已发 GLS 号，在预产品库里（还没进 RPA 档案库）',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  rpa: {
    label: '已入库RPA',
    hint: '已进 RPA 档案库',
    badge: 'border-slate-300 bg-slate-900 text-white',
  },
}

const STAGE_ORDER: MasterStage[] = ['need-specs', 'need-eval', 'need-listing', 'need-pre', 'pre', 'rpa']

type FormState = {
  id?: string
  sourceUrl: string
  title: string
  priceCny: string
  sizeCn: string
  weightG: string
  cartonL: string
  cartonW: string
  cartonH: string
  pcsPerCarton: string
  cartonGwKg: string
  materialCn: string
  colorsCn: string
  supplier: string
  /** 备选供应商：一个或多个，每行一个 */
  altSuppliers: string
  notes: string
  images: string[]
}

const EMPTY: FormState = {
  sourceUrl: '',
  title: '',
  priceCny: '',
  sizeCn: '',
  weightG: '',
  cartonL: '',
  cartonW: '',
  cartonH: '',
  pcsPerCarton: '',
  cartonGwKg: '',
  materialCn: '',
  colorsCn: '',
  supplier: '',
  altSuppliers: '',
  notes: '',
  images: [],
}

function toForm(p: MasterProduct): FormState {
  return {
    id: p.id,
    sourceUrl: p.sourceUrl,
    title: p.title,
    priceCny: p.priceCny != null ? String(p.priceCny) : '',
    sizeCn: p.sizeCn,
    weightG: p.weightG != null ? String(p.weightG) : '',
    cartonL: p.cartonLCm != null ? String(p.cartonLCm) : '',
    cartonW: p.cartonWCm != null ? String(p.cartonWCm) : '',
    cartonH: p.cartonHCm != null ? String(p.cartonHCm) : '',
    pcsPerCarton: p.pcsPerCarton != null ? String(p.pcsPerCarton) : '',
    cartonGwKg: p.cartonGwKg != null ? String(p.cartonGwKg) : '',
    materialCn: p.materialCn,
    colorsCn: p.colorsCn,
    supplier: p.supplier,
    altSuppliers: p.altSuppliers ?? '',
    notes: p.notes,
    images: p.images ?? [],
  }
}

const numOrNull = (v: string): number | null => {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * 产品资料库：自己录一次的产品主数据。
 * 关键作用：批量处理 / 单品预填去抓 1688 时，先查这里——命中就直接用，
 * 不用再重复补箱规、每箱数、箱毛重，图片也能一次录多张供出图参考。
 */
/** 本地文件 → data URL（上传由后端压缩入库，前端不做图形处理） */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function MasterDataPanel() {
  const navigate = useNavigate()
  const [list, setList] = useState<MasterProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  /** 上方的分类筛选：all = 全部 */
  const [stage, setStage] = useState<'all' | MasterStage>('all')
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [imgUrl, setImgUrl] = useState('')
  const [imgUploading, setImgUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const imgFileRef = useRef<HTMLInputElement | null>(null)
  const [importing, setImporting] = useState(false)
  /** 勾选的资料 id（批量删除用） */
  const [selected, setSelected] = useState<string[]>([])
  const [pushing, setPushing] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{
    created: number
    updated: number
    skipped: number
    total: number
    errors: Array<{ row: number; error: string }>
    pendingImages?: number
    imageTaskId?: string | null
  } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  /** 读文件 → base64 → 后端解析 */
  const onImportFile = async (file: File | null) => {
    if (!file) return
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      toast.error('只支持 .xlsx / .csv（老 .xls 请在 Excel 里另存为 xlsx 或 csv）')
      return
    }
    if (file.size > 30 * 1024 * 1024) {
      toast.error(`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 太大了，请拆成几个文件分批导入`)
      return
    }
    setImporting(true)
    setImportResult(null)
    setImportError(null)
    try {
      const buf = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      const r = await api.importMasterProducts(file.name, btoa(binary))
      setImportResult(r)
      toast.success(`导入完成：新增 ${r.created} 条，更新 ${r.updated} 条`)
      await load(q)
      // 表格里的「嵌入单元格图片」在后台慢慢解，这里轮询到完成再刷新一次
      if (r.imageTaskId) {
        setImporting(true)
        setImportResult({ ...r, total: r.total, errors: r.errors })
        for (let i = 0; i < 200; i++) {
          await new Promise((res) => setTimeout(res, 3000))
          try {
            const t = await api.getTask(r.imageTaskId)
            if (t.status === 'done') {
              toast.success('表格里的图片已解析完成')
              await load(q)
              break
            }
            if (t.status === 'error') {
              toast.error(`图片解析失败：${t.error ?? '未知原因'}（文字资料已导入）`)
              break
            }
          } catch {
            /* 服务重启会丢任务，直接停 */
            break
          }
        }
        setImporting(false)
      }
    } catch (err) {
      const msg = getErrorMessage(err)
      setImportError(msg)
      toast.error(msg)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const load = useCallback(async (keyword?: string) => {
    setLoading(true)
    try {
      const rows = await api.listMasterProducts(keyword?.trim() || undefined)
      setList(rows)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 资料/建档状态会变（导入、推进、评估），每 30 秒自动刷新一次
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  /** 每个分类各有多少条（stage 由后台按流水线口径算好） */
  const stageCounts = useMemo(() => {
    const base: Record<MasterStage, number> = {
      'need-specs': 0,
      'need-eval': 0,
      'need-listing': 0,
      'need-pre': 0,
      pre: 0,
      rpa: 0,
    }
    for (const p of list) if (p.stage) base[p.stage] += 1
    return base
  }, [list])

  const filtered = useMemo(
    () => (stage === 'all' ? list : list.filter((p) => p.stage === stage)),
    [list, stage]
  )

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f))

  const save = async () => {
    if (!form) return
    if (!form.title.trim() && !form.sourceUrl.trim()) {
      toast.error('至少填商品名称或 1688 链接')
      return
    }
    setSaving(true)
    try {
      const payload = {
        sourceUrl: form.sourceUrl.trim(),
        title: form.title.trim(),
        priceCny: numOrNull(form.priceCny),
        sizeCn: form.sizeCn.trim(),
        weightG: numOrNull(form.weightG),
        cartonLCm: numOrNull(form.cartonL),
        cartonWCm: numOrNull(form.cartonW),
        cartonHCm: numOrNull(form.cartonH),
        pcsPerCarton: numOrNull(form.pcsPerCarton),
        cartonGwKg: numOrNull(form.cartonGwKg),
        materialCn: form.materialCn.trim(),
        colorsCn: form.colorsCn.trim(),
        supplier: form.supplier.trim(),
        altSuppliers: form.altSuppliers.trim(),
        notes: form.notes.trim(),
        images: form.images.filter(Boolean),
      }
      if (form.id) {
        const r = await api.updateMasterProduct(form.id, payload)
        toast.success(
          r.synced
            ? `资料已更新：已同步 ${r.synced} 个产品的档案、英文链接、资料卡与评估草稿${r.repriced ? `，重算 ${r.repriced} 张价格表` : ''}`
            : '资料已更新'
        )
      } else {
        const r = await api.saveMasterProduct(payload)
        toast.success(
          (r.updated ? '这条链接已有资料，已覆盖更新' : '已加入产品资料库') +
            (r.repriced ? `，已重算 ${r.repriced} 张价格表` : '')
        )
      }
      setForm(null)
      await load(q)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (p: MasterProduct) => {
    if (!window.confirm(`确定删除「${p.title || '（未命名）'}」？删掉之后这条链接再抓取就不会自动命中资料库了。`)) return
    try {
      await api.deleteMasterProduct(p.id)
      toast.success('已删除')
      setSelected((cur) => cur.filter((id) => id !== p.id))
      await load(q)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  /** 批量删除：资料库条目多了以后，逐条点叉很费时间 */
  const removeSelected = async () => {
    if (!selected.length) return
    if (!window.confirm(`确定删除选中的 ${selected.length} 条资料？删除后不可恢复。`)) return
    setBulkDeleting(true)
    try {
      const r = await api.bulkDeleteMasterProducts(selected)
      toast.success(`已删除 ${r.removed} 条`)
      setSelected([])
      await load(q)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBulkDeleting(false)
    }
  }

  /**
   * 推进到下一进程：把选中的资料建进产品流水线，然后直接排队做产品评估。
   * 资料在导入时其实已经建过档了，这里只是让用户能明确地「再推一次 + 立刻评估」。
   */
  const pushToSystem = async (ids: string[]) => {
    if (!ids.length) return
    setPushing(true)
    try {
      const r = await api.pushMasterProducts({ ids })
      if (r.productIds.length) {
        await api.evaluateProducts({
          productIds: r.productIds.slice(0, 20),
          clientKey: `eval-${Date.now()}`,
        })
        toast.success(
          `已进入系统 ${r.productIds.length} 条（新建 ${r.created} / 复用 ${r.existing}），已开始产品评估，可在「产品流水线」看进度`
        )
      } else {
        toast.warning('没有可推进的资料')
      }
      setSelected([])
      await load(q)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setPushing(false)
    }
  }

  /** 从 1688 链接抓标题/价格等（有资料库记录就直接带出来） */
  const grabFromLink = async () => {
    if (!form?.sourceUrl.trim()) {
      toast.error('先填 1688 链接')
      return
    }
    setFetching(true)
    try {
      const r = await api.fetch1688(form.sourceUrl.trim())
      const f = r.fetched ?? ({} as typeof r.fetched)
      setForm((cur) =>
        cur
          ? {
              ...cur,
              title: cur.title || f.sourceTitle || '',
              priceCny: cur.priceCny || (f.priceCny != null ? String(f.priceCny) : ''),
              sizeCn: cur.sizeCn || f.sizeCn || '',
              materialCn: cur.materialCn || f.materialCn || '',
              colorsCn: cur.colorsCn || f.colorsCn || '',
              weightG: cur.weightG || (f.weightG != null ? String(f.weightG) : ''),
              pcsPerCarton: cur.pcsPerCarton || (f.pcsPerCarton != null ? String(f.pcsPerCarton) : ''),
              cartonGwKg: cur.cartonGwKg || (f.cartonGwKg != null ? String(f.cartonGwKg) : ''),
            }
          : cur
      )
      if (f.images?.length || f.image) {
        const got = (f.images?.length ? f.images : [f.image]).filter((x): x is string => Boolean(x))
        setForm((cur) => (cur ? { ...cur, images: Array.from(new Set([...cur.images, ...got])) } : cur))
      }
      toast.success(r.message || '已抓取')
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setFetching(false)
    }
  }

  const grabImages = async () => {
    if (!form?.sourceUrl.trim()) {
      toast.error('先填 1688 链接')
      return
    }
    setFetching(true)
    try {
      const r = await api.fetch1688Images(form.sourceUrl.trim())
      if (r.images?.length) {
        setForm((cur) => (cur ? { ...cur, images: Array.from(new Set([...cur.images, ...r.images])) } : cur))
        toast.success(r.message || `抓到 ${r.images.length} 张图`)
      } else {
        toast.warning(r.message || '没抓到图，可以手动粘贴图片地址')
      }
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setFetching(false)
    }
  }

  const addImageUrl = () => {
    const u = imgUrl.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u) && !u.startsWith('/api/')) {
      toast.error('图片地址要以 http 开头（本地图片请用「上传本地图片」或直接拖进来）')
      return
    }
    setForm((cur) => (cur ? { ...cur, images: Array.from(new Set([...cur.images, u])) } : cur))
    setImgUrl('')
  }

  /** 本地文件 / 拖拽 / 剪贴板 → 读成 dataURL → 后端压缩入库 → 拿回站内地址 */
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!list.length) {
      toast.error('没有可用的图片文件（支持 jpg / png / webp / gif）')
      return
    }
    if (list.length > 12) {
      toast.error('一次最多 12 张，请分批上传')
      return
    }
    setImgUploading(true)
    try {
      const dataUrls: string[] = []
      for (const f of list) {
        if (f.size > 8 * 1024 * 1024) {
          toast.error(`${f.name} 超过 8MB，请压缩后再传`)
          continue
        }
        dataUrls.push(await fileToDataUrl(f))
      }
      if (!dataUrls.length) return
      const r = await api.uploadMasterImages(dataUrls)
      setForm((cur) =>
        cur ? { ...cur, images: Array.from(new Set([...cur.images, ...r.urls])) } : cur
      )
      if (r.failed?.length) toast.warning(`${r.urls.length} 张已添加，${r.failed.length} 张失败`)
      else toast.success(`已添加 ${r.urls.length} 张图片`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setImgUploading(false)
    }
  }

  const coverage = useMemo(() => list.filter((p) => p.cartonLCm && p.pcsPerCarton && p.cartonGwKg).length, [list])
  const noImageRows = useMemo(() => list.filter((p) => (p.images?.length ?? 0) === 0 && p.sourceUrl), [list])
  const [grabbingAll, setGrabbingAll] = useState(false)
  const [grabProgress, setGrabProgress] = useState({ done: 0, total: 0, got: 0 })

  /**
   * 批量抓图：导入的 Excel 里如果图片是「嵌入单元格的图片」（WPS 的 DISPIMG），
   * 表格里拿不到图片地址，只能按 1688 链接回去抓。一条一条抓，抓完自动存。
   */
  const grabAllImages = async () => {
    const targets = noImageRows
    if (!targets.length) {
      toast.success('没有缺图的行')
      return
    }
    setGrabbingAll(true)
    setGrabProgress({ done: 0, total: targets.length, got: 0 })
    let got = 0
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i]
      try {
        const r = await api.fetch1688Images(p.sourceUrl)
        if (r.images?.length) {
          await api.updateMasterProduct(p.id, { images: r.images })
          got += 1
        }
      } catch {
        /* 单条失败继续下一条 */
      }
      setGrabProgress({ done: i + 1, total: targets.length, got })
    }
    setGrabbingAll(false)
    toast.success(`抓图完成：${got}/${targets.length} 条拿到图`)
    await load(q)
  }

  return (
    <div className="space-y-4">
      <SectionCard
        title="产品资料库"
        hint="录一次就够了：批量处理 / 产品信息预填去抓 1688 时，会先查这里，命中就直接用你录的箱规和图片，不用再补"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
              资料齐全 {coverage}/{list.length}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(api.masterExportUrl('xlsx'), '_blank')}
            >
              <Download className="mr-1 h-3.5 w-3.5" /> 导出 Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(api.masterExportUrl('csv'), '_blank')}
            >
              <Download className="mr-1 h-3.5 w-3.5" /> 导出 CSV
            </Button>
            <Button size="sm" variant="outline" disabled={importing} onClick={() => fileRef.current?.click()}>
              {importing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
              导入表格
            </Button>
            {noImageRows.length > 0 && (
              <Button size="sm" variant="outline" disabled={grabbingAll} onClick={() => void grabAllImages()}>
                {grabbingAll ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="mr-1 h-3.5 w-3.5" />
                )}
                {grabbingAll
                  ? `抓图中 ${grabProgress.done}/${grabProgress.total}`
                  : `批量抓图（缺 ${noImageRows.length} 条）`}
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)}
            />
            <Button size="sm" onClick={() => setForm({ ...EMPTY })}>
              <Plus className="mr-1 h-3.5 w-3.5" /> 新增商品
            </Button>
          </div>
        }
      >
        {importError && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700">
            <div className="font-medium">导入失败</div>
            <div className="mt-0.5 break-all">{importError}</div>
            <div className="mt-1 text-[11px] text-rose-600">
              排查顺序：① 文件是不是 .xlsx/.csv（老的 .xls 请另存为 xlsx）② 表头里有没有「1688链接」「商品名称」
              ③ 行数很多时文件别超过 5MB
            </div>
          </div>
        )}
        {importResult && (
          <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-700">
            <div>
              导入结果：共 {importResult.total} 行 · 新增 <b className="text-emerald-600">{importResult.created}</b> ·
              更新 <b className="text-blue-600">{importResult.updated}</b> · 跳过 {importResult.skipped}
              {importResult.errors.length > 0 && (
                <span className="text-rose-600"> · 出错 {importResult.errors.length}</span>
              )}
            </div>
            {importResult.errors.length > 0 && (
              <ul className="mt-1 max-h-24 overflow-y-auto text-[11px] text-rose-600">
                {importResult.errors.map((e) => (
                  <li key={e.row}>第 {e.row} 行：{e.error}</li>
                ))}
              </ul>
            )}
            <div className="mt-1 text-[11px] text-slate-400">
              按 1688 链接去重：已存在就更新，不存在就新增。
              {importResult.pendingImages
                ? ` · 表格里有 ${importResult.pendingImages} 行带「嵌入单元格的图片」，正在后台解析（${importing ? '进行中…' : '已完成'}）`
                : ' · 图片列支持换行分隔的多张网址'}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="h-8 w-64 rounded border border-slate-200 pl-7 pr-2 text-[12px]"
              placeholder="搜标题 / 链接 / 材质 / 备注"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(q)
              }}
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => void load(q)}>
            搜索
          </Button>
          <span className="text-[11px] text-slate-400">
            批量处理时，粘贴同一链接会自动用这里的资料（含图片），不再重复抓取
          </span>
        </div>
      </SectionCard>

      {form && (
        <SectionCard
          title={form.id ? '编辑商品资料' : '新增商品资料'}
          hint="箱规、每箱数、箱毛重是运费测算的关键；图片数量不限，出图时按需取用（多角度图越多，AI 越不容易画错结构）"
          right={
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
              <X className="mr-1 h-3.5 w-3.5" /> 关闭
            </Button>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="1688 链接" full>
              <div className="flex gap-1">
                <input
                  className="h-8 flex-1 rounded border border-slate-200 px-2 text-[12px]"
                  placeholder="https://detail.1688.com/offer/xxx.html"
                  value={form.sourceUrl}
                  onChange={(e) => set('sourceUrl', e.target.value)}
                />
                <Button size="sm" variant="outline" onClick={() => void grabFromLink()} disabled={fetching}>
                  {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </Field>
            <Field label="商品名称" full>
              <input
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </Field>
            <Field label="采购价（元）">
              <input
                type="number"
                step="0.01"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.priceCny}
                onChange={(e) => set('priceCny', e.target.value)}
              />
            </Field>
            <Field label="产品尺寸（cm）">
              <input
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                placeholder="20x15x8"
                value={form.sizeCn}
                onChange={(e) => set('sizeCn', e.target.value)}
              />
            </Field>
            <Field label="单个重量（g）">
              <input
                type="number"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.weightG}
                onChange={(e) => set('weightG', e.target.value)}
              />
            </Field>
            <Field label="箱规 长（cm）">
              <input
                type="number"
                step="0.1"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.cartonL}
                onChange={(e) => set('cartonL', e.target.value)}
              />
            </Field>
            <Field label="箱规 宽（cm）">
              <input
                type="number"
                step="0.1"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.cartonW}
                onChange={(e) => set('cartonW', e.target.value)}
              />
            </Field>
            <Field label="箱规 高（cm）">
              <input
                type="number"
                step="0.1"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.cartonH}
                onChange={(e) => set('cartonH', e.target.value)}
              />
            </Field>
            <Field label="一箱数量">
              <input
                type="number"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.pcsPerCarton}
                onChange={(e) => set('pcsPerCarton', e.target.value)}
              />
            </Field>
            <Field label="一箱毛重（kg）">
              <input
                type="number"
                step="0.01"
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.cartonGwKg}
                onChange={(e) => set('cartonGwKg', e.target.value)}
              />
            </Field>
            <Field label="材质">
              <input
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.materialCn}
                onChange={(e) => set('materialCn', e.target.value)}
              />
            </Field>
            <Field label="颜色">
              <input
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.colorsCn}
                onChange={(e) => set('colorsCn', e.target.value)}
              />
            </Field>
            <Field label="供应商">
              <input
                className="h-8 w-full rounded border border-slate-200 px-2 text-[12px]"
                value={form.supplier}
                onChange={(e) => set('supplier', e.target.value)}
              />
            </Field>
            {/* 备选供应商：主供应商断货/涨价时直接换，录一次后面都能查 */}
            <Field label="备选供应商（一个或多个，每行一个）" full>
              <textarea
                rows={3}
                className="w-full rounded border border-slate-200 px-2 py-1 text-[12px]"
                placeholder={'主供应商之外可替代的厂家，一行一个，例如：\n东莞市XX礼品有限公司 王先生 13800138000\n义乌XX日用品厂 https://shop123.1688.com'}
                value={form.altSuppliers}
                onChange={(e) => set('altSuppliers', e.target.value)}
              />
              <div className="mt-0.5 text-[10px] text-slate-400">
                已填 {form.altSuppliers.split('\n').map((s) => s.trim()).filter(Boolean).length} 家备选；
                会同步到产品档案，主供应商没货时不用再翻聊天记录
              </div>
            </Field>
            <Field label="备注" full>
              <textarea
                rows={2}
                className="w-full rounded border border-slate-200 px-2 py-1 text-[12px]"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
              />
            </Field>
          </div>

          {/* 图片：本地文件 / 拖拽 / 粘贴截图 / 链接，四种方式都能加 */}
          <div
            className={cn(
              'mt-3 rounded-lg border-2 border-dashed p-2 transition',
              dragOver ? 'border-blue-400 bg-blue-50/50' : 'border-slate-200'
            )}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              void addFiles(e.dataTransfer.files)
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items
              if (!items) return
              const files: File[] = []
              for (const it of Array.from(items)) {
                if (it.kind === 'file' && it.type.startsWith('image/')) {
                  const f = it.getAsFile()
                  if (f) files.push(f)
                }
              }
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            tabIndex={0}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-medium text-slate-700">
                商品图片（{form.images.length} 张 · 不限数量）
              </span>
              <input
                ref={imgFileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addFiles(e.target.files)
                  if (imgFileRef.current) imgFileRef.current.value = ''
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => imgFileRef.current?.click()}
                disabled={imgUploading}
              >
                {imgUploading ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="mr-1 h-3.5 w-3.5" />
                )}
                {imgUploading ? '上传中…' : '上传本地图片'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void grabImages()} disabled={fetching}>
                {fetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="mr-1 h-3.5 w-3.5" />}
                从 1688 抓图
              </Button>
              <input
                className="h-7 w-64 rounded border border-slate-200 px-2 text-[11px]"
                placeholder="或粘贴图片链接后回车"
                value={imgUrl}
                onChange={(e) => setImgUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addImageUrl()
                }}
              />
              <Button size="sm" variant="ghost" onClick={addImageUrl}>
                添加链接
              </Button>
            </div>
            <div className="mt-1 text-[10px] text-slate-400">
              支持：本地文件（可多选）、把图片拖进这个框、直接 Ctrl+V 粘贴截图、粘贴 http 图片链接；
              上传后自动压缩到 1600px 并存在站内（换电脑/清缓存都不会丢）
            </div>
            {form.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.images.map((u, i) => (
                  <div key={`${u}-${i}`} className="group relative h-16 w-16 overflow-hidden rounded border border-slate-200">
                    <img src={api.proxyImageUrl(u)} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-0 top-0 hidden rounded-bl bg-black/60 px-1 text-[10px] text-white group-hover:block"
                      onClick={() => set('images', form.images.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              保存到资料库
            </Button>
            <span className="text-[11px] text-slate-400">同一链接再存一次会覆盖更新，不会重复</span>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="已录入商品"
        hint="导入/录入的资料会自动建进产品流水线；这里可以再手动推进一次，或直接去批量评估"
        right={
          <div className="flex flex-wrap items-center gap-2">
            {selected.length > 0 && (
              <Button size="sm" disabled={pushing} onClick={() => void pushToSystem(selected)}>
                {pushing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
                推进到产品评估（{selected.length}）
              </Button>
            )}
            {selected.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="text-rose-600"
                disabled={bulkDeleting}
                onClick={() => void removeSelected()}
              >
                {bulkDeleting ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                删除选中（{selected.length}）
              </Button>
            )}
          </div>
        }
      >
        {list.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-slate-100 pb-3">
            {[
              { key: 'all' as const, label: '全部', count: list.length, hint: '不筛选，看全部资料' },
              ...STAGE_ORDER.map((k) => ({
                key: k,
                label: STAGE_META[k].label,
                count: stageCounts[k],
                hint: STAGE_META[k].hint,
              })),
            ].map((c) => {
              const active = stage === c.key
              return (
                <button
                  key={c.key}
                  type="button"
                  title={c.hint}
                  onClick={() => setStage(c.key)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11.5px] transition',
                    active
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                    !active && c.count === 0 && 'text-slate-300'
                  )}
                >
                  {c.label}
                  <span className={cn('ml-1 tabular-nums', active ? 'text-white/70' : 'text-slate-400')}>
                    {c.count}
                  </span>
                </button>
              )
            })}
            <span className="ml-auto text-[11px] text-slate-400">
              {stage === 'all' ? `共 ${list.length} 条` : `${STAGE_META[stage].label}：${filtered.length} 条`}
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : list.length === 0 ? (
          <div className="py-10 text-center">
            <Database className="mx-auto h-9 w-9 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-600">资料库还是空的</p>
            <p className="mt-1 text-xs text-slate-400">点右上角「新增商品」，把链接、箱规、图片录进来</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-[12px]">
              <thead className="text-[11px] text-slate-400">
                <tr className="border-b border-slate-100">
                  <th className="w-8 py-2 pr-2 font-medium">
                    <Checkbox
                      checked={filtered.length > 0 && filtered.every((p) => selected.includes(p.id))}
                      onCheckedChange={(v) =>
                        setSelected((cur) =>
                          v
                            ? Array.from(new Set([...cur, ...filtered.map((p) => p.id)]))
                            : cur.filter((id) => !filtered.some((p) => p.id === id))
                        )
                      }
                      title="全选当前分类"
                    />
                  </th>
                  <th className="py-2 pr-2 font-medium">商品</th>
                  <th className="py-2 pr-2 font-medium">采购价</th>
                  <th className="py-2 pr-2 font-medium">尺寸</th>
                  <th className="py-2 pr-2 font-medium">箱规</th>
                  <th className="py-2 pr-2 font-medium">每箱</th>
                  <th className="py-2 pr-2 font-medium">毛重</th>
                  <th className="py-2 pr-2 font-medium">图片</th>
                  <th className="py-2 pr-2 font-medium">阶段</th>
                  <th className="py-2 pr-2 font-medium">系统</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  return (
                    <tr key={p.id} className="border-b border-slate-50 align-top">
                      <td className="py-2 pr-2">
                        <Checkbox
                          checked={selected.includes(p.id)}
                          onCheckedChange={(v) =>
                            setSelected((cur) => (v ? [...cur, p.id] : cur.filter((x) => x !== p.id)))
                          }
                        />
                      </td>
                      <td className="max-w-[280px] py-2 pr-2">
                        <div className="truncate font-medium text-slate-800" title={p.title}>
                          {p.title || '（未命名）'}
                        </div>
                        {p.sourceUrl && (
                          <a
                            href={p.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" /> 1688 链接
                          </a>
                        )}
                      </td>
                      <td className="py-2 pr-2">{p.priceCny != null ? `¥${p.priceCny}` : <span className="text-amber-600">缺</span>}</td>
                      <td className="py-2 pr-2 text-slate-600">{p.sizeCn || <span className="text-amber-600">缺</span>}</td>
                      <td className="py-2 pr-2 text-slate-600">
                        {p.cartonLCm && p.cartonWCm && p.cartonHCm
                          ? `${p.cartonLCm}x${p.cartonWCm}x${p.cartonHCm}`
                          : <span className="text-amber-600">缺</span>}
                      </td>
                      <td className="py-2 pr-2 text-slate-600">{p.pcsPerCarton ?? <span className="text-amber-600">缺</span>}</td>
                      <td className="py-2 pr-2 text-slate-600">{p.cartonGwKg ?? <span className="text-amber-600">缺</span>}</td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1">
                          {p.images.slice(0, 3).map((u, i) => (
                            <img key={`${p.id}-${i}`} src={api.proxyImageUrl(u)} alt="" className="h-8 w-8 rounded object-cover" />
                          ))}
                          <span className="text-[11px] text-slate-400">{p.images.length}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        {p.stage ? (
                          <span
                            className={cn(
                              'inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]',
                              STAGE_META[p.stage].badge
                            )}
                            title={
                              p.stage === 'need-specs' && p.missingFields?.length
                                ? `还缺：${p.missingFields.join('、')}`
                                : STAGE_META[p.stage].hint
                            }
                          >
                            {STAGE_META[p.stage].label}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {/* 已经进系统的显示编号，没进的显示按钮：导入即建档，这里只做兜底 */}
                        {p.productCode ? (
                          <button
                            className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-white"
                            onClick={() => navigate('/pipeline')}
                            title="看产品流水线"
                          >
                            {p.productCode}
                          </button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1.5 text-[10px] text-blue-600"
                            onClick={() => void pushToSystem([p.id])}
                          >
                            进入系统
                          </Button>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setForm(toForm(p))}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[11px] text-rose-600"
                            onClick={() => void remove(p)}
                            title="删除这条资料"
                          >
                            <Trash2 className="mr-0.5 h-3 w-3" /> 删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={full ? 'sm:col-span-2 lg:col-span-3' : ''}>
      <span className="mb-0.5 block text-[11px] text-slate-500">{label}</span>
      {children}
    </label>
  )
}

/**
 * 产品资料库 = 两件事合在一页：
 *   ① 资料条目：批量导入 / 编辑 / 推进到产品评估（导入时已自动建档进流水线）
 *   ② 产品信息卡：每个产品 14 个结构化字段（原来单独的「产品资料卡」页并进来了，不再重复入口）
 */
export default function MasterData() {
  const [tab, setTab] = useState<'entries' | 'cards'>('entries')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            { key: 'entries', label: '资料条目（批量导入）' },
            { key: 'cards', label: '产品信息卡' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? 'rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-[12px] font-semibold text-blue-700'
                : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-500 hover:border-slate-300'
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'entries' ? <MasterDataPanel /> : <ProductSpecCards />}
    </div>
  )
}
