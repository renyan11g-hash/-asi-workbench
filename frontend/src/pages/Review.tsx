/**
 * 审核队列已下线（2026-11 起选品不再放网页上）。
 * 路由与侧边栏入口已移除；这个文件保留为空壳，只为了防止旧书签直接崩，
 * 后续可以从仓库里删掉。
 */
export default function Review() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
      审核队列已下线。选品不再在网页上做，评分请看「产品库」里每条的 AI 评估结论。
    </div>
  )
}
