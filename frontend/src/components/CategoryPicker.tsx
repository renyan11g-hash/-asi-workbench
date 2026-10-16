import { useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { GLS_CATEGORIES } from '@/constants/gls-categories'

/**
 * GLS 类目选择器（数据来自金山文档「Categories」表，1620 项）。
 * 带关键词过滤，最多可选 max 个；已选项显示为可删除的标签。
 */
export function CategoryPicker({
  value,
  max,
  onChange,
  searchPlaceholder = '输入英文关键词过滤，如 bottle / bag / pen',
}: {
  value: string[]
  max: number
  onChange: (next: string[]) => void
  searchPlaceholder?: string
}) {
  const [q, setQ] = useState('')
  const selected = value.filter(Boolean)
  const full = selected.length >= max

  const kw = q.trim().toLowerCase()
  const options = (kw
    ? GLS_CATEGORIES.filter((c) => c.toLowerCase().includes(kw))
    : GLS_CATEGORIES
  )
    .filter((c) => !selected.includes(c))
    .slice(0, 120)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          className="h-9 w-44 shrink-0 text-sm"
          value={q}
          disabled={full}
          onChange={(e) => setQ(e.target.value)}
          placeholder={searchPlaceholder}
        />
        <select
          className="h-9 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm"
          value=""
          disabled={full}
          onChange={(e) => {
            const v = e.target.value
            if (!v) return
            const next = Array.from(new Set([...selected, v])).slice(0, max)
            onChange(next)
            setQ('')
          }}
        >
          <option value="">
            {full
              ? `已选满 ${max} 个（点 × 可移除）`
              : `＋ 从类目表中选择（匹配 ${options.length} 项）…`}
          </option>
          {options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map((c, i) => (
            <span
              key={`${c}-${i}`}
              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700"
            >
              {c}
              <button
                type="button"
                className="ml-0.5 text-slate-400 hover:text-rose-500"
                onClick={() => onChange(selected.filter((_, idx) => idx !== i))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
