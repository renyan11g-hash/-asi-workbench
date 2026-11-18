/**
 * 批量补图：文件夹 → 产品资料 配对确认。
 *
 * 用户的习惯是「一个文件夹 = 一款产品，文件夹名就是产品名」，文件夹里的图叫
 * IMG_0001.jpg 之类，所以按文件名配对根本对不上，必须按文件夹名猜产品名，
 * 再让人工确认一遍——猜错了可以下拉改，不确认不会写库。
 */

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, getErrorMessage } from '@/lib/api'
import { chunkImages, fileToDataUrl, type ImageFolderGroup } from '@/lib/files'
import type { MasterProduct } from '@/types'

/** 每条产品最多存 8 张图（库里存的规则，别绕过） */
const MAX_IMAGES = 8
const SKIP = '__skip__'

/** 归一：去空格、去括号和标点，方便「选品一{饭盒}」和「饭盒带折叠餐具」做模糊比对 */
function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\-_/\\()（）【】[\]{}·,，.。:：;；'"“”‘’]/g, '')
}

/** 汉字二元组重合度，用来给中文长标题打分 */
function grams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 文件夹名 ↔ 产品标题 的相似度（0-100） */
export function scoreFolderTitle(folder: string, title: string): number {
  const a = norm(folder)
  const b = norm(title)
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.includes(a) || a.includes(b)) return 80
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.size) return 0
  let hit = 0
  for (const g of ga) if (gb.has(g)) hit += 1
  return Math.round((hit / ga.size) * 70)
}

function bestMatch(folder: string, products: MasterProduct[]): MasterProduct | null {
  let best: MasterProduct | null = null
  let bestScore = 0
  for (const p of products) {
    const s = scoreFolderTitle(folder, p.title)
    if (s > bestScore) {
      bestScore = s
      best = p
    }
  }
  // 分数太低就别瞎猜，留空让人工选
  return bestScore >= 45 ? best : null
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  groups: ImageFolderGroup[]
  products: MasterProduct[]
  /** 全部写完后调用（刷新列表用） */
  onDone: () => void | Promise<void>
}

export function ImageFolderPairDialog({ open, onOpenChange, groups, products, onDone }: Props) {
  const [pairs, setPairs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  // 打开时按文件夹名猜一遍产品（只做建议，不写库）
  useEffect(() => {
    if (!open) return
    const next: Record<string, string> = {}
    for (const g of groups) next[g.folder] = bestMatch(g.folder, products)?.id ?? SKIP
    setPairs(next)
  }, [open, groups, products])

  const totalImages = useMemo(() => groups.reduce((n, g) => n + g.files.length, 0), [groups])
  const chosen = useMemo(() => groups.filter((g) => (pairs[g.folder] ?? SKIP) !== SKIP), [groups, pairs])
  const chosenImages = useMemo(() => chosen.reduce((n, g) => n + g.files.length, 0), [chosen])
  const usedIds = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of chosen) {
      const id = pairs[g.folder]
      m.set(id, (m.get(id) ?? 0) + 1)
    }
    return m
  }, [chosen, pairs])

  const apply = async () => {
    if (!chosen.length) {
      toast.error('还没有选任何产品：每个文件夹都要选一个「配到哪条资料」')
      return
    }
    setBusy(true)
    setProgress({ done: 0, total: chosenImages })
    let done = 0
    let saved = 0
    let full = 0
    const failed: string[] = []
    try {
      for (const g of chosen) {
        const id = pairs[g.folder]
        const target = products.find((p) => p.id === id)
        if (!target) continue
        const existing = target.images ?? []
        const room = Math.max(0, MAX_IMAGES - existing.length)
        const picked = g.files.slice(0, room)
        if (!picked.length) {
          full += 1
          continue
        }
        const urls: string[] = []
        for (const batch of chunkImages(picked, 3)) {
          try {
            const data = await Promise.all(batch.map((f) => fileToDataUrl(f)))
            const r = await api.uploadMasterImages(data)
            urls.push(...r.urls)
          } catch (err) {
            failed.push(g.folder)
            toast.error(`${g.folder} 上传失败：${getErrorMessage(err)}`)
          }
          done += batch.length
          setProgress({ done, total: chosenImages })
        }
        if (!urls.length) continue
        await api.updateMasterProduct(id, { images: [...existing, ...urls] })
        saved += urls.length
      }
      if (saved) toast.success(`已补 ${saved} 张图，覆盖 ${chosen.length - full} 条资料`)
      if (full) toast.warning(`${full} 个文件夹没导入：对应资料已经有 8 张图了`)
      if (failed.length) toast.warning(`有 ${failed.length} 个文件夹上传失败，可重试`)
      if (saved) {
        await onDone()
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (busy ? null : onOpenChange(v))}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>按文件夹配对补图</DialogTitle>
          <DialogDescription>
            共 {groups.length} 个文件夹、{totalImages} 张图。每个文件夹默认按名字猜了一款产品，
            <b>猜错可以下拉改</b>；确认后才会写进资料库（每条最多 {MAX_IMAGES} 张）。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-auto rounded border border-slate-200">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">文件夹</th>
                <th className="px-3 py-2 font-medium">图片</th>
                <th className="px-3 py-2 font-medium">配到这条资料</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const value = pairs[g.folder] ?? SKIP
                const target = products.find((p) => p.id === value)
                const room = target ? Math.max(0, MAX_IMAGES - (target.images?.length ?? 0)) : null
                const dup = value !== SKIP && (usedIds.get(value) ?? 0) > 1
                return (
                  <tr key={g.folder} className="border-t border-slate-100 align-top">
                    <td className="max-w-[220px] px-3 py-2">
                      <div className="truncate font-medium text-slate-700" title={g.folder}>
                        {g.folder}
                      </div>
                      {dup && <div className="text-[11px] text-amber-600">同一个产品被选了多次</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                      {g.files.length} 张
                      {room !== null && room === 0 && (
                        <div className="text-[11px] text-rose-600">已满 8 张</div>
                      )}
                      {room !== null && room > 0 && room < g.files.length && (
                        <div className="text-[11px] text-amber-600">只收前 {room} 张</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={value}
                        onValueChange={(v) => setPairs((prev) => ({ ...prev, [g.folder]: v }))}
                        disabled={busy}
                      >
                        <SelectTrigger className="h-8 w-full text-[12px]">
                          <SelectValue placeholder="选一条资料" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[280px]">
                          <SelectItem value={SKIP}>不导入</SelectItem>
                          {products.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              <span className="truncate">{p.title || '（无标题）'}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="items-center gap-3">
          {busy && (
            <span className="mr-auto text-[12px] text-slate-500">
              上传中 {progress.done}/{progress.total} 张…
            </span>
          )}
          {!busy && chosen.length > 0 && (
            <span className="mr-auto text-[12px] text-slate-500">
              将导入 {chosen.length} 个文件夹 / {chosenImages} 张图
            </span>
          )}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={busy || !chosen.length} onClick={() => void apply()}>
            {busy ? '上传中…' : '确认导入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
