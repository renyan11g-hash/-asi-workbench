/**
 * 异步任务管理器：AI 生成类长任务改为后台执行 + 前端轮询。
 * 解决 Render 免费层 100 秒代理超时导致的 502。
 */

export type TaskStatus = 'pending' | 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  type: string
  status: TaskStatus
  /** 任务完成后的结果数据（如 listing） */
  result?: unknown
  /** 失败时的错误信息 */
  error?: string
  hint?: string
  /** 进度描述（如「已完成 2/5 张」），长任务可选更新 */
  progress?: string
  createdAt: number
  updatedAt: number
}

const tasks = new Map<string, TaskRecord>()
const MAX_TASKS = 500
const TASK_TTL_MS = 30 * 60 * 1000 // 30 分钟后清理

function cleanup() {
  const now = Date.now()
  for (const [id, t] of tasks) {
    if (now - t.updatedAt > TASK_TTL_MS) tasks.delete(id)
  }
  // 超量兜底：删除最早的
  if (tasks.size > MAX_TASKS) {
    const sorted = [...tasks.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [id] of sorted.slice(0, tasks.size - MAX_TASKS)) tasks.delete(id)
  }
}

export function createTask(type: string): TaskRecord {
  cleanup()
  const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  const rec: TaskRecord = { id, type, status: 'pending', createdAt: now, updatedAt: now }
  tasks.set(id, rec)
  return rec
}

export function getTask(id: string): TaskRecord | undefined {
  return tasks.get(id)
}

export function updateTask(id: string, patch: Partial<TaskRecord>): void {
  const t = tasks.get(id)
  if (!t) return
  Object.assign(t, patch, { updatedAt: Date.now() })
}

/**
 * 在后台执行任务：立即返回，不阻塞 HTTP 响应。
 * 失败自动重试（最多 2 次），适配 429/5xx/网络抖动。
 */
export function runTask<T>(
  task: TaskRecord,
  fn: () => Promise<T>,
  retries = 2,
  retryDelayMs = 3000
): void {
  updateTask(task.id, { status: 'running' })
  const attempt = async (n: number): Promise<void> => {
    try {
      const result = await fn()
      updateTask(task.id, { status: 'done', result })
    } catch (err) {
      const isRetryable =
        err instanceof Error &&
        /timeout|network|fetch failed|ECONN|429|rate|5\d\d|JSON/i.test(
          `${err.name} ${err.message}`
        )
      if (n < retries && isRetryable) {
        setTimeout(() => void attempt(n + 1), retryDelayMs * n)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const hint = (err as { hint?: string })?.hint
      updateTask(task.id, { status: 'error', error: message, hint })
    }
  }
  void attempt(0)
}
