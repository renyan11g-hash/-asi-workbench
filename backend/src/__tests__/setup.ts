import os from 'os'
import path from 'path'

/**
 * 测试环境（setupFiles，先于任何业务模块 import 执行）：
 * 把数据库目录指到系统临时目录 —— db.ts 在 import 时会建表，
 * 如果指向仓库内的 data/，跑一次测试就会在项目里留下一个真实数据库文件。
 *
 * 注意：这里不能写 beforeAll/afterAll，setupFiles 阶段测试框架还没装好。
 */
process.env.DATA_DIR = path.join(os.tmpdir(), `asi-workbench-test-${process.pid}`)
