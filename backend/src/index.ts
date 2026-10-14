import { createApp } from './app'
import { env } from './config/env'
import { logger } from './config/logger'
import { startFxAutoRefresh, stopFxAutoRefresh } from './services/fx'

const startServer = async () => {
  try {
    const app = createApp()

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
