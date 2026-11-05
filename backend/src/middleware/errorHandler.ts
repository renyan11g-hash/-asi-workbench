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

    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
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
