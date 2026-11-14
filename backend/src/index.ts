import { createApp } from './app'
import { env } from './config/env'
import { logger } from './config/logger'
import { startFxAutoRefresh, stopFxAutoRefresh } from './services/fx'
import { healPreLibrary } from './services/library'

const startServer = async () => {
  try {
    const app = createApp()

    // 启动自愈：已在预产品库却缺 GLS 号的产品补号（历史「保存即审核通过」遗留的 PIP 号）
    try {
      const healed = healPreLibrary()
      if (healed.numbered.length) logger.info({ numbered: healed.numbered }, '补发 GLS 编号')
    } catch (err) {
      logger.warn({ err }, '补发 GLS 编号失败（不影响启动）')
    }

    // 启动时自动拉取实时汇率，并每小时定时刷新（价格计算自动使用最新汇率）
    startFxAutoRefresh()

    app.listen(env.PORT, '0.0.0.0', () => {
      // Only show minimal startup info in development
      if (env.NODE_ENV === 'development') {
        console.log(`Server running on http://localhost:${env.PORT}${env.API_PREFIX}`)
      }
    })
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server')
    process.exit(1)
  }
}

// Handle graceful shutdown silently
process.on('SIGTERM', async () => {
  stopFxAutoRefresh()
  process.exit(0)
})

process.on('SIGINT', async () => {
  stopFxAutoRefresh()
  process.exit(0)
})

startServer()
