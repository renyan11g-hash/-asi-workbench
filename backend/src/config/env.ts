import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  API_PREFIX: z.string().default('/api'),

  CORS_ORIGIN: z.string().refine(
    (val) => val === '*' || z.string().url().safeParse(val).success,
    { message: 'CORS_ORIGIN must be a valid URL or "*" for all origins' }
  ).default('*'),
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('100'),

  // 访问保护（HTTP Basic Auth）：两项都配置才启用；留空 = 不鉴权（本地开发默认关闭）
  BASIC_AUTH_USER: z.string().default(''),
  BASIC_AUTH_PASS: z.string().default(''),

  // 机器调用令牌：外部定时任务（GitHub Actions）用 x-sync-token 访问，留空则禁用该通道
  SYNC_TOKEN: z.string().default(''),
})

const parseEnv = () => {
  try {
    return envSchema.parse(process.env)
  } catch (error) {
    console.error('❌ Invalid environment variables:', error)
    process.exit(1)
  }
}

export const env = parseEnv()
