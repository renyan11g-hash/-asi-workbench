# ASI Workbench — AI 助手工作规范

## 项目结构

- 本仓库根目录：`c:/Users/Administrator/Desktop/asi-workbench-repo`
  - `backend/` — Node.js + TypeScript 后端（tsx 运行）
  - `frontend/` — React 18 + TypeScript + Vite 前端
- 部署：GitHub 仓库（origin = `https://github.com/renyan11g-hash/-asi-workbench.git`，分支为 **main**）→ Render 自动部署到 **https://asi-workbench.onrender.com**
- 用户平时通过 Render 线上地址访问应用，**不是 localhost**。前端改动只有推送到 GitHub 后才会生效。
- 注意：`c:/Users/Administrator/Desktop/backend` 是一份独立旧副本，**不要**把改动写进那里；所有改动一律写进本仓库。

## 每次代码更新后的标准流程（必须自动执行，无需用户催促）

1. **编译验证**（改动了哪些端就验证哪些端）：
   ```
   cd backend && npx tsc --noEmit
   cd frontend && npx tsc --noEmit
   ```
2. **提交并推送**（推送目标永远是 `origin main`，不是 master）：
   ```
   git add -A && git commit -m "<中文提交说明>" && git push origin main
   ```
3. **推送成功后**，用 `git status -sb` 确认本地与远程同步，然后告知用户：
   - 等待 Render 自动部署（通常 2-5 分钟）
   - 部署完成后在浏览器 **Ctrl+F5 强制刷新** asi-workbench.onrender.com

## 其他约定

- 提交信息用中文，格式 `feat:` / `fix:` + 简述
- 临时诊断脚本用完必须删除，不要提交进仓库
- SQLite（libsql）云库：线上数据保存在 Turso 云库（LIBSQL_URL），不随部署清空
- 前后端各持一份 `src/constants/asi.ts` 镜像与 `src/types.ts` 类型定义，修改时必须保持两边同步
