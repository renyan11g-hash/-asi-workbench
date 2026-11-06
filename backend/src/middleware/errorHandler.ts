import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { createLogger } from '../config/logger'

const logger = createLogger('ErrorHandler')

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message)
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

/** zod 的英文报错对业务员没有意义，转成能看懂的一句话 */
const ZOD_FIELD_LABELS: Record<string, string> = {
  title: '产品名称',
  priceCny: '采购价',
  moq: 'MOQ',
  sizeCn: '产品尺寸',
  materialCn: '材质',
  colorsCn: '颜色',
  description: '描述',
  images: '产品图片',
  weightG: '单件重量',
  cartonLCm: '箱规（长）',
  cartonWCm: '箱规（宽）',
  cartonHCm: '箱规（高）',
  pcsPerCarton: '每箱数量',
  cartonGwKg: '箱毛重',
}

function zodReason(err: ZodError): string {
  const first = err.errors[0]
  if (!first) return '资料格式不对'
  // 路径可能是 source.priceCny / input.images.0：从后往前找认识的字段名
  const path = first.path.map(String)
  const key = [...path].reverse().find(p => ZOD_FIELD_LABELS[p]) ?? path[0] ?? ''
  const label = ZOD_FIELD_LABELS[key] ?? key
  switch (first.code) {
    case 'too_big':
      return `${label}超出长度/数量上限`
    case 'too_small':
      return `${label}填写不完整`
    case 'invalid_type':
      return `${label}的类型不对（数字栏不要填文字）`
    case 'invalid_enum_value':
      return `${label}不是可选项`
    case 'invalid_string':
      return `${label}格式不对`
    default:
      return `${label}没通过校验：${first.message}`
  }
}

export const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction) => {
  // Zod validation errors
  if (err instanceof ZodError) {
    logger.warn(
      {
        method: req.method,
        url: req.url,
        errors: err.errors,
      },
      'Validation error'
    )

    const detail = zodReason(err)
    const field = err.errors[0]?.path.join('.') ?? ''
    return res.status(400).json({
      status: 'error',
      // 前端直接把 message 弹出来，所以这里必须是能看懂的中文
      message: `资料格式不对：${detail}${field ? `（${field}）` : ''}`,
      errors: err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    })
  }

  // Application errors
  if (err instanceof AppError) {
    logger.warn(
      {
        method: req.method,
        url: req.url,
        statusCode: err.statusCode,
      },
      err.message
    )

    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    })
  }

  // 带 status 的底层错误（body-parser 的 413 请求体过大、400 解析失败等）：
  // 不能一律当 500，否则用户只看到 "Internal server error"，根本不知道是文件太大
  const rawStatus =
    (err as unknown as { status?: number }).status ??
    (err as unknown as { statusCode?: number }).statusCode
  if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500) {
    logger.warn({ method: req.method, url: req.url, status: rawStatus }, err.message)
    return res.status(rawStatus).json({
      status: 'error',
      message:
        rawStatus === 413
          ? '上传内容太大（上限约 35MB）。请把资料库拆成几个文件分批导入，或改用 CSV 格式'
          : err.message,
    })
  }

  // Unknown errors
  logger.error(
    {
      err,
      method: req.method,
      url: req.url,
    },
    'Unhandled error'
  )

  return res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  })
}
