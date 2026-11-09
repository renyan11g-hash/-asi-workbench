import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * 页面级错误边界。
 *
 * 2026-11-09：线上偶发数据库断连导致某个接口 500，首屏渲染直接抛异常，
 * React 把整棵树卸载掉 → 用户看到的是纯白屏，只能等它「自己好了」。
 * 现在任何页面渲染出错都停在可操作的兜底页：重试本页 / 强制刷新 / 换菜单继续用，
 * 不再是白屏，也不再需要用户猜是不是服务挂了。
 */

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] 页面渲染出错：', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto mt-10 max-w-xl rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-rose-600">这个页面没能显示出来</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          页面渲染时遇到异常（常见原因：网络抖动、接口临时返回错误）。数据没有丢，
          点「重试本页」一般就能恢复；还不行就强制刷新（Ctrl+Shift+R，Mac 用 Cmd+Shift+R），
          或者直接从左边菜单换到别的页面继续操作。
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
          {error.message}
        </pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            重试本页
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            强制刷新
          </Button>
        </div>
      </div>
    )
  }
}
