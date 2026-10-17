import { useState } from 'react'
import { ImageOff } from 'lucide-react'

/**
 * 产品缩略图：取选品评估时上传的第一张图片（base64 dataURL 或 https URL）。
 * - 加载失败或无图时显示占位图标
 * - clickable=true 时点击可在新标签页查看原图
 */
export default function ProductThumb({
  images,
  size = 40,
  clickable = true,
  className = '',
}: {
  images?: string[] | null
  /** 边长（px） */
  size?: number
  /** 是否允许点击查看原图（表格行内的展开按钮里需设为 false，避免 a 嵌套在 button 内） */
  clickable?: boolean
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const src = images?.[0]

  if (!src || failed) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-100 text-slate-300 ${className}`}
        aria-hidden
      >
        <ImageOff style={{ width: Math.max(12, size * 0.45), height: Math.max(12, size * 0.45) }} />
      </div>
    )
  }

  const img = (
    <img
      src={src}
      alt=""
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md border border-slate-200 bg-white object-cover ${className}`}
    />
  )

  if (!clickable) return img
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      title="查看原图"
      onClick={(e) => e.stopPropagation()}
      className="block shrink-0"
    >
      {img}
    </a>
  )
}
