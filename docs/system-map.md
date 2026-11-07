# ASI Workbench 系统地图（文件 / 提示词 / 规则 都在哪）

> 更新于 2026-11-06。用来回答两个问题：① 网站的系统文件放在哪；② 各种 AI 提示词和你定的规则写在哪一行。

## 1. 代码在哪

| 位置 | 地址 |
|---|---|
| 本机仓库 | `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\asi-workbench` |
| GitHub | `https://github.com/renyan11g-hash/-asi-workbench`（分支 `main`） |
| 线上 | `https://asi-workbench.onrender.com`（push 到 main 自动部署，约 3–5 分钟） |
| 数据库 | Turso 云库（`LIBSQL_URL` + `LIBSQL_AUTH_TOKEN`，配在 Render 环境变量里，不随部署清空） |

注意：`C:\Users\Administrator\Desktop\backend` 是很早以前的独立副本，**已废弃**，改那里不会生效。

技术栈：后端 Express + TypeScript（tsx 运行），前端 React 18 + Vite + Tailwind，数据库 libsql/Turso。
一个服务同时跑 API 和前端静态文件（见 `render.yaml`）。

## 2. 目录结构（只列有用的）

```
asi-workbench/
├─ backend/                     后端
│  └─ src/
│     ├─ app.ts                 路由挂载、鉴权、CORS、静态文件
│     ├─ db.ts                  建表 + 老表补列（所有表结构定义）
│     ├─ types.ts               Evaluation / Listing / SourceInfo / Settings 等类型
│     ├─ constants/
│     │  ├─ asi.ts              ★ 枚举与规则常量：ASI 类目、主题、材质、17 种印刷方式、
│     │  │                         颜色中英词典、材质词典、字数限制、ilovecargo 规则、种子关键词、品牌黑名单
│     │  └─ gls-categories.ts   GLS 全量类目表（1600+ 行）
│     ├─ services/
│     │  ├─ prompts.ts          ★ 所有 AI 提示词（评估/英文链接/看图找类似/对话/字段重生成/选品）
│     │  ├─ workbench.ts        评估与生成的编排层（evaluateSource / generateListing / applyQc …）
│     │  ├─ imprint-recommend.ts ★ 印刷方式材质矩阵 + formatImprintConstraint（注入 4 个提示词）
│     │  ├─ pricing.ts          ★ 报价计算：计费重、体积重、8 档阶梯、汇率
│     │  ├─ eval-score.ts       ★ 评分 v3 权重与封顶规则（服务端合成，不信 AI 自报）
│     │  ├─ scoring.ts          评分 v2（按市场 list 价反算毛利，另一套，页面上单独显示）
│     │  ├─ market-probe.ts     海外市场探针（4imprint RSS）
│     │  ├─ image-prompts.ts    ★ 出图的 AI 提示词（主图/尺寸图/介绍图、介绍文案建议、中→英指令翻译）
│     │  ├─ image-gen.ts        调用方舟 Seedream / OpenAI 生图
│     │  ├─ image-post.ts       ★ 1200×1200 画布、白底、产品缩放不扩画布
│     │  ├─ image-inline.ts     1688 图片防盗链 → 服务端下载转 data URL
│     │  ├─ cell-images.ts      解析 WPS `DISPIMG` 嵌入单元格图片
│     │  ├─ batch-jobs.ts       批量任务数据模型 + 粘贴文本解析
│     │  ├─ ai.ts               AI 调用与错误分类
│     │  └─ task-manager.ts     长任务（生图/批量图解析）
│     ├─ modules/               各业务接口（*Router）
│     │  ├─ products.ts         单品：抓取/评估/生成链接/入库/生图/导出
│     │  ├─ batch.ts            ★ 批量：六阶段流水线
│     │  ├─ listing-reviews.ts  英文链接待审核库
│     │  ├─ master-products.ts  产品资料库（含 Excel 导入导出）
│     │  ├─ settings.ts         AI/成本/报价参数读写
│     │  └─ dashboard/orders/customers/…（订单运营中心等）
│     └─ middleware/            鉴权、错误处理、日志
└─ frontend/src/
   ├─ pages/                    每个菜单一个页面
   │  ├─ Sourcing.tsx           产品信息预填
   │  ├─ SourcingSuggest.tsx    选品预估
   │  ├─ Batch.tsx              批量处理（六阶段 + 暂停/继续）
   │  ├─ MasterData.tsx         产品资料库
   │  ├─ Evaluations.tsx        评估库
   │  ├─ ListingEditor.tsx      英文链接生成（最核心，2600+ 行）
   │  ├─ ListingReviews.tsx     英文链接待审核
   │  ├─ Library.tsx            产品库
   │  └─ SettingsPage.tsx       设置
   ├─ lib/api.ts                所有后端接口的前端封装
   ├─ types.ts                  与后端对齐的类型（必须同步改）
   └─ components/AppLayout.tsx  侧边栏导航
```

前后端各有一份 `constants/asi.ts` 与 `types.ts`，**改一边必须改另一边**。

## 3. AI 提示词清单（都在 `backend/src/services/prompts.ts`）

| 行号 | 函数 | 用途 |
|---|---|---|
| 16 | `pickRelevantCategories` | 按产品相关性筛选 GLS 类目（注入允许值，防编造） |
| 136 | `buildEvaluatePrompt` | ★ 选品评估：差异化/定制/物流/竞争/合规打分 + 建议 |
| 246 | `formatEvaluationAdvice` | ★ 把评估结论与建议转成英文提示块（新增） |
| 318 | `buildListingPrompt` | ★ 生成英文链接：标题/卖点/描述/30 组关键词/类目/主题/材质/印刷 |
| 461 | `buildChatEvaluationPrompt` | 对话式调整评估（补信息后重新打分） |
| 537 | `buildListingQuestionsPrompt` | 生成前问业务员的差异化问题 |
| 585 | `buildFindSimilarPrompt` | 看图找类似（Amazon/ASI 同款与搜索词） |
| 646 | `buildCatalogKeywordsPrompt` | ASI 目录关键词 |
| 687 | `buildAssistantPrompt` | 工作台 AI 助手（对话） |
| 752 | `buildFieldsRegeneratePrompt` | 单个字段重新生成（可带业务员指令） |
| 817 | `buildSourcingPrompt` | 选品方向推荐（1688 搜索词） |
| 865 | `buildSourcingResearchPrompt` | 选品调研 |

出图提示词在 `backend/src/services/image-prompts.ts`：
`buildImagePromptSet`(64)、`buildIntroSuggestions`(139)、`translateImageEditInstruction`(171)。

## 4. 你定的规则写在哪

| 规则 | 文件 | 位置 |
|---|---|---|
| 17 种印刷方式枚举 + Unimprinted | `constants/asi.ts` | `ASI_IMPRINT_METHODS`(245) |
| 必含 Silkscreen / Unimprinted / Full Color | `services/imprint-recommend.ts` | `REQUIRED_IMPRINT_METHODS`(53) |
| 材质 × 工艺矩阵（热升华只吃浅色涤纶、成衣直印只吃棉、PU≠真皮） | `services/imprint-recommend.ts` | `MATERIAL_PROFILES`(201)、`recommendImprintMethods`(506) |
| 印刷约束注入提示词（4 个提示词共用） | `services/imprint-recommend.ts` | `formatImprintConstraint`(693) |
| 评分 v3 权重 差异化28/定制22/物流18/竞争17/合规15 + 档位 ≥85/≥75/≥60/≥45 | `services/eval-score.ts` | `SCORE_WEIGHTS`(32)、`composeScore`(71)、`scoreBand`(109) |
| 报价：计费重向上取 0.5、体积重除数、空运/海运费率、倍率、8 档阶梯 | `services/pricing.ts` | `buildPriceGrid`(97) |
| 报价参数默认值（空运50元/kg、海运20、除数5000、倍率1.4/1.25、杂费5%、样品300…） | `types.ts` + `modules/settings.ts` + 设置页 | `Settings`(279) |
| 出图：固定 1200×1200、白底、产品缩入留边、不扩画布 | `services/image-post.ts` | `CANVAS_SIZE`(14)、`fitToCanvas`(154) |
| 生图模型（方舟 doubao-seedream-4-0，1K 出图） | 设置页 → `imageModel`/`imageSize`，调用见 `services/image-gen.ts`(265) | |
| GLS/ASI 类目、主题、材质允许值 | `constants/asi.ts`(8/40/171) + `constants/gls-categories.ts` | |
| 标题≤60、卖点≤130 且以 "Rush service is available" 结尾、描述≤800、关键词 30 组 | `constants/asi.ts` `LIMITS`(394) + 提示词 + `workbench.applyQc`(624) | |
| 品牌黑名单（不得出现 Disney/Nike…） | `constants/asi.ts` | `BRAND_BLOCKLIST`(455) |
| ilovecargo 等价 QC 规则 | `constants/asi.ts` | `ILOVECARGO_RULES`(409)、`workbench.buildIlovecargoReport`(763) |
| 海外市场探针（4imprint RSS，相关性过滤、密度口径） | `services/market-probe.ts` | `probeOverseasMarket`(369) |
| 颜色中英对照（标题/卖点里不许出现颜色词） | `constants/asi.ts` | `COLOR_DICT`(266) |

运行时可改的参数（API Key、汇率、运费、倍率、出图尺寸等）存在数据库 `settings` 表，界面上是「设置」页。

## 5. 数据表（`backend/src/db.ts`）

`products`（产品库）、`drafts`（评估库）、`master_products`（产品资料库）、`batch_jobs` / `batch_item_evals` / `batch_item_images`（批量）、`listing_reviews`（英文链接待审核）、`sourcing_history`（抓取历史）、`server_errors`（500 现场留档）、订单中心的 `customers/inquiries/orders/...`。

## 7. 统一产品档案（2026-11-07 结构调整）

以前一个产品要在「选品预估 → 产品信息预填 → 评估库 → 生成链接 → 待审核 → 产品库」之间手动接力，
而且各模块各存一份（`drafts` 一份、`batch_jobs` 一份、`products` 一份、`listing_reviews` 一份）。
现在收敛成**一个产品一条档案**：

| 环节 | 落在哪 | 说明 |
|---|---|---|
| 产品编号 | `products.code`（`RPA0001`） | 录入时发一次，全流程同一个编号；老数据启动时自动回填 |
| 资料 + 评估 + 英文文案 | 同一条 `products` 行 | 不再新建第二份数据 |
| 待审核 | `products.status='pending_review'` | 「英文链接待审核」页直接读状态，不是另一个库 |
| 正式产品 | `products.status='listed'` | 在链接生成页核对后「保存修改」即原地转正式；也可在待审核页批量通过 |
| 驳回 | `products.status='archived'` + `review_note` | 资料/评估/图片全保留，可「退回待生成」重做 |
| 批量出文案 | `modules/batch.ts` `POST /batch/from-products` | 从档案载入（`item.recordId`），只跑生成链接，不重新粘链接/补资料 |

新增文件：

- `backend/src/modules/flow.ts` —— 流水线接口：`/flow/overview`（漏斗计数）、`/flow/products`（每条进度+下一步）、
  `/flow/reviews`（待审核）、`/flow/reviews/approve|reject|reopen`、`/flow/thumb/:id`（原始图缩略图）
- `frontend/src/pages/Pipeline.tsx` —— 产品流水线页（每步进度、下一步直达、勾选批量出文案）
- `products.code` / `products.listing_title` 两列（`db.ts` `ensureColumn`，`products.ts` 回填与写入）

状态口径（`flow.ts` `nextStepOf`）：
`sourced` 且缺关键字段→补资料；`sourced` 有资料无评估→评估；`sourced` 已评估无文案→生成文案；
`pending_review`→审核；`listed`→完成；`archived`→驳回。

## 6. 改动后的发布流程
1. `cd backend && npx tsc --noEmit`；`cd frontend && npx tsc -b --force`
2. `git push origin main`（本机 github.com 不通，用工作区根目录的 `push-asi-api.ps1` 走 API 推送）
3. 等 3–5 分钟，`GET /api/version` 的 `commit` 变了就是新版
4. 浏览器 **Ctrl+F5** 强刷

## 8. 批量生产系统 V1（2026-11-07 新增）

一句话：在「已有产品档案」上做批量 —— 先把资料整理成 14 个标准字段，再一批 5~10 个各自生成 Listing，
进待审核库、人工过了才写回产品。生成过程永远不覆盖产品库里现有的 Listing。

后端：

- `backend/src/services/spec-fields.ts` —— 14 字段定义、Unknown 归一、清洗、指纹、提示词片段（纯函数，可单测）
- `backend/src/services/product-specs.ts` —— 调模型提取（只抄不编）+ `product_specs` 表读写
- `backend/src/modules/product-specs.ts` —— `/api/product-specs/cards`（信息卡列表）、`/:id`（详情）、
  `/:id/extract`（单条重提取）、`PATCH /:id`（人工改）
- `backend/src/services/listing-qc.ts` —— 程序规则质检（长度/结尾句/关键词数量与重复/无依据的参数材质认证），纯函数
- `backend/src/services/listing-qc-ai.ts` —— AI 复检（语法/美国英语/编造说法），只在用户点「AI 复检」时才调
- `backend/src/services/production-jobs.ts` —— `production_jobs` 队列：逐条独立、暂停/继续/取消/重试、重启识别、clientKey 防重复
- `backend/src/modules/production.ts` —— `/api/production/candidates`、`/jobs`（建+跑）、`/jobs/:id`（进度）、
  `/jobs/:id/run|pause|cancel|retry-failed`、`/jobs/:id/items/:idx/retry`、`/ai-logs`
- `backend/src/services/ai-log.ts` —— `ai_call_logs` 台账（任务/模型/耗时/token/错误）
- `backend/src/services/ai.ts` —— `modelFor()` 模型分工（`aiModelExtract`/`aiModelQc` 留空即沿用 `aiModel`）

待审核库的两种模式（`listing-reviews.ts`）：

- `mode='inline'` 旧流程：生成即写产品档案（`pending_review`），审核只改状态
- `mode='staged'` 批量生产：生成结果只存 `listing_reviews`，**通过时才写 `products.listing`**；
  驳回/删除都不动产品。同一产品只保留一份未审草稿，重生成自动替换旧的

前端：`ProductSpecs.tsx`（`/specs` 产品资料卡）、`Production.tsx`（`/production` 批量生产中心）、
`ReviewCenter.tsx`（`/review-center` Listing 审核中心）。

新增表：`product_specs`、`production_jobs`、`ai_call_logs`；`listing_reviews` 加
`job_id / item_idx / mode / qc / prev_listing / edited_at`（全部可空或带默认值，旧数据不受影响）。
