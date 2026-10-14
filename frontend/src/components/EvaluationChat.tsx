import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageSquare, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/lib/api'
import { Evaluation } from '@/types'

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: string
}

interface Props {
  productId: string
  evaluation: Evaluation | null
  chatFn: (
    id: string,
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  ) => Promise<unknown>
  onEvaluationUpdated?: (e: Evaluation) => void
  /** 自定义类名 */
  className?: string
  /** 隐藏标题（嵌入到外层 SectionCard 时使用） */
  bareTitle?: boolean
}

const STORAGE_PREFIX = 'asi-eval-chat:'

function loadHistory(id: string): ChatTurn[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function saveHistory(id: string, turns: ChatTurn[]) {
  if (typeof window === 'undefined') return
  try {
    if (turns.length === 0) {
      localStorage.removeItem(STORAGE_PREFIX + id)
    } else {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(turns))
    }
  } catch {
    /* noop */
  }
}

export default function EvaluationChat({
  productId,
  evaluation,
  chatFn,
  onEvaluationUpdated,
  className,
  bareTitle,
}: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>(() => loadHistory(productId))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    saveHistory(productId, turns)
  }, [productId, turns])

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [turns, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!evaluation) {
      toast.error('请先完成选品评估，再开启对话')
      return
    }
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      at: new Date().toISOString(),
    }
    const next = [...turns, userTurn]
    setTurns(next)
    setInput('')
    setBusy(true)
    try {
      const messages = next.map((t) => ({ role: t.role, content: t.content }))
      const product = (await chatFn(productId, messages)) as {
        evaluation?: Evaluation
      }
      const replyText = product?.evaluation?.summary
        ? `已根据您的输入更新评估（当前 ${product.evaluation.score} 分 · ${product.evaluation.verdict}）。${product.evaluation.summary}`
        : '已根据您的输入更新评估。请查看上方分数与建议。'
      const aiTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: replyText,
        at: new Date().toISOString(),
      }
      setTurns((cur) => [...cur, aiTurn])
      if (product?.evaluation) onEvaluationUpdated?.(product.evaluation)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const clear = () => {
    setTurns([])
    saveHistory(productId, [])
  }

  return (
    <div className={className}>
      {!bareTitle && (
        <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <MessageSquare className="h-3.5 w-3.5 text-blue-600" /> 继续讨论 / 让 AI 重新评估
        </div>
      )}
      <p className="mb-3 text-[11px] text-slate-500">
        您可以补充：供应商已确认可做的颜色、印花方式、出样时长、合规资质、目标客户反馈等。
        AI 会按对话历史更新评分与建议。
      </p>
      <div
        ref={listRef}
        className="max-h-64 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/60 p-3 text-sm"
      >
        {turns.length === 0 && (
          <p className="text-center text-xs text-slate-400">
            还没有对话。输入补充信息，让 AI 重新评估这个产品。
          </p>
        )}
        <ul className="space-y-2">
          {turns.map((t) => (
            <li
              key={t.id}
              className={
                t.role === 'user'
                  ? 'flex justify-end'
                  : 'flex justify-start'
              }
            >
              <div
                className={
                  t.role === 'user'
                    ? 'max-w-[85%] rounded-lg bg-blue-600 px-3 py-2 text-white'
                    : 'max-w-[85%] rounded-lg bg-white px-3 py-2 text-slate-800 shadow-sm ring-1 ring-slate-200'
                }
              >
                <div className="whitespace-pre-wrap leading-relaxed">{t.content}</div>
                <div
                  className={
                    t.role === 'user'
                      ? 'mt-1 text-right text-[10px] text-blue-100'
                      : 'mt-1 text-right text-[10px] text-slate-400'
                  }
                >
                  {new Date(t.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </li>
          ))}
          {busy && (
            <li className="flex justify-start">
              <div className="rounded-lg bg-white px-3 py-2 text-slate-500 shadow-sm ring-1 ring-slate-200">
                <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                AI 正在根据您的输入重新评估…
              </div>
            </li>
          )}
        </ul>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <Textarea
          className="min-h-[60px] flex-1 text-sm"
          placeholder="如：供应商已确认可以加做海军蓝、灰色；印花方式 4 色丝印 + 激光雕刻；FDA 检测报告下周出…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            size="sm"
            className="h-9"
            disabled={busy || !input.trim()}
            onClick={send}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            发送
          </Button>
          {turns.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-slate-500"
              onClick={clear}
            >
              <Trash2 className="mr-1 h-3 w-3" /> 清空
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">按 Ctrl/⌘ + Enter 发送</p>
    </div>
  )
}
