# ASI Workbench 部署指南

## 项目概述

这是一个全栈应用，用于从1688选品并生成符合ASI规范的英文产品Listing。

- **后端：** Express + TypeScript + SQLite
- **前端：** React + TypeScript + Vite + Tailwind CSS
- **AI集成：** DeepSeek/OpenAI

## 部署方案选择

### 推荐方案：Render（免费层）

Render是一个现代化的云平台，提供免费层支持，适合部署全栈应用。

**优点：**
- 免费层支持（后端+前端）
- 自动HTTPS
- 自动部署（Git集成）
- 简单的配置文件

**限制：**
- 免费层应用15分钟无活动会休眠
- SQLite数据在重启后会丢失（重要限制）
- 构建时间有限制

### 备选方案

1. **Vercel + Railway**
   - Vercel部署前端（免费）
   - Railway部署后端（免费层）

2. **Netlify + Render**
   - Netlify部署前端（免费）
   - Render部署后端（免费层）

3. **自建服务器**
   - 需要自己的服务器
   - 可以使用PostgreSQL替代SQLite
   - 数据持久化

---

## Render 部署步骤

### 1. 准备工作

#### 1.1 安装依赖

```bash
# 安装后端依赖
cd backend
npm install

# 安装前端依赖
cd ../frontend
npm install
```

#### 1.2 本地测试

```bash
# 启动后端（终端1）
cd backend
npm run dev

# 启动前端（终端2）
cd frontend
npm run dev
```

访问 http://localhost:5173 测试应用是否正常运行。

#### 1.2 配置AI API Key

应用需要AI API Key才能生成Listing。在应用的设置页面配置：
- DeepSeek API Key（推荐）：https://platform.deepseek.com/
- OpenAI API Key：https://platform.openai.com/

### 2. 推送代码到GitHub

#### 2.1 初始化Git仓库（如果还没有）

```bash
git init
git add .
git commit -m "Initial commit"
```

#### 2.2 创建GitHub仓库

1. 访问 https://github.com/new
2. 创建新仓库（建议命名为 `asi-workbench`）
3. 按照GitHub提示推送代码：

```bash
git remote add origin https://github.com/your-username/asi-workbench.git
git branch -M main
git push -u origin main
```

### 3. 在Render上部署

#### 3.1 注册Render账号

1. 访问 https://render.com/
2. 使用GitHub账号注册
3. 授权Render访问你的GitHub仓库

#### 3.2 创建Web Service

1. 点击 "New +"
2. 选择 "Web Service"
3. 选择GitHub仓库 `asi-workbench`
4. 配置如下：

**Build & Deploy:**
- **Branch:** `main`
- **Runtime:** `Node`
- **Build Command:**
  ```bash
  cd backend && npm install && npm run build && cd ../frontend && npm install && npm run build
  ```
- **Start Command:**
  ```bash
  cd backend && npm start
  ```

**Environment:**
- **Name:** `asi-workbench`
- **Region:** 选择离你最近的区域
- **Plan:** Free

**Environment Variables:**
添加以下环境变量：

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DATA_DIR` | `/tmp/data` |
| `CORS_ORIGIN` | `*` |

#### 3.3 部署

点击 "Create Web Service" 开始部署。

部署完成后，Render会提供一个URL，例如：
```
https://asi-workbench.onrender.com
```

### 4. 重要注意事项

#### 4.1 数据持久化问题

**重要：** Render免费层使用 `/tmp` 目录存储SQLite数据库，应用休眠或重启后数据会丢失。

**解决方案：**

1. **使用Render Disk（付费）**
   - 升级到Starter计划（$7/月）
   - 添加持久化磁盘
   - 修改 `DATA_DIR` 环境变量指向磁盘路径

2. **导出备份数据**
   - 定期导出CSV备份产品数据
   - 使用应用的"导出CSV"功能

3. **迁移到外部数据库（推荐用于生产）**
   - 使用PostgreSQL/MySQL
   - 修改数据库连接代码
   - 配置外部数据库服务

#### 4.2 应用休眠

Render免费层15分钟无活动会休眠，首次访问需要等待约30秒唤醒。

**解决方案：**
- 使用Uptime监控服务（如UptimeRobot）定期ping应用
- 升级到付费计划

#### 4.3 AI API Key

**安全建议：**
- 不要在代码中硬编码API Key
- 在Render的Environment Variables中配置
- 在应用的设置页面配置API Key（已加密存储）

---

## 本地开发

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
# 克隆仓库
git clone https://github.com/your-username/asi-workbench.git
cd asi-workbench

# 安装后端依赖
cd backend
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，添加你的配置

# 安装前端依赖
cd ../frontend
npm install
```

### 运行

```bash
# 终端1：启动后端
cd backend
npm run dev

# 终端2：启动前端
cd frontend
npm run dev
```

访问 http://localhost:5173

---

## 故障排查

### 问题1：部署失败

**检查：**
- Render构建日志查看错误信息
- 确保所有依赖都正确安装
- 检查TypeScript编译错误

### 问题2：前端无法连接后端

**检查：**
- 确认后端健康检查通过
- 检查CORS配置
- 查看浏览器控制台错误

### 问题3：AI功能不工作

**检查：**
- 确认在设置页面配置了API Key
- 检查API Key是否有效
- 查看Render日志中的错误

### 问题4：数据丢失

**原因：** SQLite数据库存储在 `/tmp` 目录，重启后清空

**解决：**
- 定期导出CSV备份
- 升级到Render付费计划并添加持久化磁盘
- 迁移到外部数据库

---

## 进阶配置

### 使用外部数据库（PostgreSQL）

1. 在Render创建PostgreSQL实例
2. 获取数据库连接字符串
3. 修改后端代码使用 `pg` 库代替 `node:sqlite`
4. 更新环境变量 `DATABASE_URL`

### 自定义域名

1. 在Render的Web Service设置中添加自定义域名
2. 配置DNS（CNAME记录指向 `your-app.onrender.com`）
3. 自动HTTPS证书

### 监控和日志

- Render Dashboard查看实时日志
- 设置错误告警
- 使用Sentry等错误追踪服务

---

## 生产环境建议

1. **数据库：** 使用PostgreSQL/MySQL代替SQLite
2. **备份：** 配置自动数据库备份
3. **监控：** 设置应用监控和告警
4. **安全：** 启用速率限制、CSRF保护
5. **性能：** 启用CDN、缓存策略
6. **日志：** 集中日志管理（如LogRocket）

---

## 支持

如有问题，请：
1. 查看Render文档：https://render.com/docs
2. 查看项目GitHub Issues
3. 联系开发团队

---

## 许可证

MIT License
