# ASI Workbench — AI 助手工作规范

## 项目结构

- 本仓库根目录：`c:/Users/Administrator/Desktop/asi-workbench-repo`
  - `backend/` — Node.js + TypeScript 后端（tsx 运行）
  - `frontend/` — React 18 + TypeScript + Vite 前端
- 部署：GitHub 仓库（origin = `https://github.com/renyan11g-hash/-asi-workbench.git`，分支为 **main**）→ Render 自动部署到 **https://asi-workbench.onrender.com**
- 用户平时通过 Render 线上地址访问应用，**不是 localhost**。前端改动只有推送到 GitHub 后才会生效。
- 注意：`c:/Users/Administrator/Desktop/backend` 是一份独立旧副本，**不要**把改动写进那里；所有改动一律写进本仓库。

## 每次代码更新后的标准流程（硬性要求：每次修改完成后都必须执行 Render 部署，不得只改代码不部署）

1. **编译验证**（改动了哪些端就验证哪些端）：
   ```
   cd backend && npx tsc --noEmit
   cd frontend && npx tsc --noEmit
   ```
2. **提交并推送**（推送目标永远是 `origin main`，不是 master）：
   ```
   git add -A && git commit -m "<中文提交说明>" && git push origin main
   ```
3. **推送即触发 Render 自动部署**：push 成功 = 部署开始（推送目标只有 main 分支，push 到 main 就是执行部署）。
4. **等待部署完成后主动验证**（约等 5 分钟，不要留给用户自己检查）：
   - 探测服务在线：`curl -s -o NUL -w "%{http_code}" https://asi-workbench.onrender.com/api/settings` → 应为 200
   - 确认新 bundle 已上线：从首页 HTML 取 `index-*.js` 文件名（与上次对比应已变化），并在 bundle 内容中查找本次改动的特征串（**用 ASCII 标识符**如 `notes:`、`intro-suggestions`；不要用中文，GBK 终端匹配 UTF-8 会误报）
   - 涉及后端接口时，可用无效参数探测路由（返回 JSON 业务错误 = 路由已注册）
5. **告知用户**：部署与验证结果 + 提醒浏览器 **Ctrl+F5 强制刷新** asi-workbench.onrender.com

## 其他约定

- 提交信息用中文，格式 `feat:` / `fix:` + 简述
- 临时诊断脚本用完必须删除，不要提交进仓库
- SQLite（libsql）云库：线上数据保存在 Turso 云库（LIBSQL_URL），不随部署清空
- 前后端各持一份 `src/constants/asi.ts` 镜像与 `src/types.ts` 类型定义，修改时必须保持两边同步
