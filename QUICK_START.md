# 快速部署指南（Render）

## 一键部署到Render（推荐）

### 步骤1：推送到GitHub

```bash
# 如果还没有Git仓库
git init
git add .
git commit -m "Initial commit"

# 创建GitHub仓库后
git remote add origin https://github.com/你的用户名/asi-workbench.git
git branch -M main
git push -u origin main
```

### 步骤2：在Render上部署

1. 访问 https://render.com/
2. 用GitHub账号注册并登录
3. 点击 "New +" → "Web Service"
4. 选择你的 `asi-workbench` 仓库
5. 填写配置：

**Build Command:**
```
cd backend && npm install && npm run build && cd ../frontend && npm install && npm run build
```

**Start Command:**
```
cd backend && npm start
```

**Environment Variables:**
- `NODE_ENV` = `production`
- `PORT` = `3000`
- `DATA_DIR` = `/tmp/data`
- `CORS_ORIGIN` = `*`

6. 点击 "Create Web Service"

### 步骤3：等待部署完成

- 部署约需3-5分钟
- 完成后点击URL访问你的应用

---

## ⚠️ 重要提示

### 数据持久化问题

**免费层数据会丢失！**

由于使用SQLite数据库存储在 `/tmp` 目录：
- 应用休眠（15分钟无活动）后数据会丢失
- Render重启后数据会丢失

**临时解决方案：**
1. 定期使用应用的"导出CSV"功能备份数据
2. 重要产品信息及时导出保存

**永久解决方案：**
1. 升级到Render Starter计划（$7/月）添加持久化磁盘
2. 或迁移到PostgreSQL数据库（推荐生产环境）

### 应用休眠

免费层15分钟无活动会休眠，首次访问需等待约30秒唤醒。

可以使用 https://uptimerobot.com 免费监控服务定期ping应用防止休眠。

---

## 配置AI功能

部署后，访问应用并在"设置"页面配置AI API Key：

**推荐：DeepSeek（便宜且好用）**
1. 访问 https://platform.deepseek.com/
2. 注册并获取API Key
3. 在应用设置中粘贴API Key

**备选：OpenAI**
1. 访问 https://platform.openai.com/
2. 注册并获取API Key
3. 在应用设置中粘贴API Key

---

## 本地运行

如果想在本地开发：

```bash
# 后端
cd backend
npm install
npm run dev

# 前端（新终端）
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173

---

## 需要帮助？

查看完整部署文档：[DEPLOYMENT.md](./DEPLOYMENT.md)
