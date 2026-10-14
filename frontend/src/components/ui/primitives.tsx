import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { LIMITS, lengthTone } from '@/constants/asi'
import { ListingQc, Verdict } from '@/types'

export function VerdictBadge({ verdict, score }: { verdict?: Verdict | null; score?: number }) {
  if (!verdict) return <Badge variant="secondary">未评估</Badge>
  const map: Record<Verdict, { label: string; cls: string }> = {
    GO: { label: 'GO 值得做', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    MAYBE: { label: 'MAYBE 待验证', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    NO: { label: 'NO 不建议', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  }
  const item = map[verdict]
  return (
    <Badge variant="outline" className={cn('gap-1 whitespace-nowrap', item.cls)}>
      {item.label}
      {typeof score === 'number' && score > 0 ? ` · ${score}` : ''}
    </Badge>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    sourced: { label: '待生成链接', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
    listed: { label: '已生成链接', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
    archived: { label: '已归档', cls: 'bg-slate-100 text-slate-400 border-slate-200' },
    trashed: { label: '回收站', cls: 'bg-rose-50 text-rose-600 border-rose-200' },
  }
  const item = map[status] ?? map.sourced
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap', item.cls)}>
      {item.label}
    </Badge>
  )
}

export function ScoreRing({ score }: { score: number }) {
  const color = score >= 75 ? 'text-emerald-500' : score >= 55 ? 'text-amber-500' : 'text-rose-500'
  const circumference = 2 * Math.PI * 24
  const offset = circumference - (Math.max(0, Math.min(100, score)) / 100) * circumference
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg className="h-full w-full -rotate-90" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r="24" fill="none" stroke="currentColor" strokeWidth="6" className="text-slate-200" />
        <circle
          cx="30"
          cy="30"
          r="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn('transition-all duration-500', color)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-2xl font-bold', color)}>{score}</span>
        <span className="text-[11px] text-slate-400">适配分</span>
      </div>
    </div>
  )
}

export function CharCounter({ value, max }: { value: string | number; max: number }) {
  const len = typeof value === 'number' ? value : (value ?? '').length
  const tone = lengthTone(len, max)
  const colorCls =
    tone === 'over'
      ? 'text-rose-500 font-semibold'
      : tone === 'warn'
      ? 'text-amber-500'
      : 'text-slate-400'
  return (
    <span className={cn('text-[11px]', colorCls)}>
      {len} / {max}
    </span>
  )
}

export function QcBadge({ qc }: { qc?: ListingQc }) {
  if (!qc) return null
  if (qc.ok) {
    return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">质检通过</Badge>
  }
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
      质检提示 · 已自动调整
    </Badge>
  )
}

export function ChipList({
  items,
  onRemove,
  onAdd,
  placeholder,
  variant = 'default',
}: {
  items: string[]
  onRemove?: (index: number) => void
  onAdd?: (value: string) => void
  placeholder?: string
  variant?: 'default' | 'blue'
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <span
          key={`${it}-${i}`}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
            variant === 'blue'
              ? 'border-blue-200 bg-blue-50 text-blue-700'
              : 'border-slate-200 bg-slate-50 text-slate-700'
          )}
        >
          {it}
          {onRemove && (
            <button
              type="button"
              className="ml-0.5 text-slate-400 hover:text-rose-500"
              onClick={() => onRemove(i)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {onAdd && (
        <input
          className="h-7 w-32 rounded-md border border-dashed border-slate-300 bg-transparent px-2 text-xs outline-none focus:border-blue-400"
          placeholder={placeholder ?? '添加后回车'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim()
              if (v) {
                onAdd(v)
                ;(e.target as HTMLInputElement).value = ''
              }
            }
          }}
        />
      )}
    </div>
  )
}

export function SectionCard({
  title,
  hint,
  right,
  children,
  className,
}: {
  title: string
  hint?: string
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

export { LIMITS }