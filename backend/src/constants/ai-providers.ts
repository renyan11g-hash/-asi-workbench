/**
 * 预设 AI 供应商列表（OpenAI 兼容接口）。
 * 用户在设置页选择供应商后，前端自动填 baseUrl 并给出推荐模型；
 * 只需再填对应平台的 API Key 即可。价格仅供参考（可能变动）。
 */
export interface AiProviderPreset {
  id: string
  name: string
  baseUrl: string
  models: string[]
  /** 官网（获取 API Key） */
  keyUrl: string
  /** 是否需要科学上网（境外服务） */
  needsProxy: boolean
  /** 支持图片输入（选品识图需要） */
  supportsVision: boolean
  /** 大致价格说明（每百万 token，美元） */
  priceNote: string
  /** 备注（优缺点） */
  note: string
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsProxy: false,
    supportsVision: false,
    priceNote: '输入 $0.27 / 输出 $1.10（缓存命中更低）',
    note: '国内直连、便宜；但不支持图片识别，中文质量好。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM（bigmodel）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5-flash', 'glm-4.5-air', 'glm-4.5v', 'glm-4-plus'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    needsProxy: false,
    supportsVision: true,
    priceNote: 'glm-4.5-flash 免费；glm-4.5v 约 $0.6/$1.8',
    note: '国内直连；glm-4.5-flash 完全免费，glm-4.5v 支持图片识别（推荐选品识图用）。',
  },
  {
    id: 'qwen',
    name: '阿里通义千问（DashScope 兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-vl-plus', 'qwen-max'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    needsProxy: false,
    supportsVision: true,
    priceNote: 'qwen-turbo 约 $0.04/$0.12；qwen-vl-plus 约 $0.28/$0.85',
    note: '国内直连、新用户有免费额度；qwen-vl-plus 支持图片。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    needsProxy: false,
    supportsVision: false,
    priceNote: '8k 约 $1.7/$5.4（按量）',
    note: '国内直连；长文本能力强，价格中等。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow（聚合）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'Qwen/Qwen2.5-7B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-VL-7B-Instruct',
      'THUDM/glm-4-9b-chat',
    ],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    needsProxy: false,
    supportsVision: true,
    priceNote: '7B 级模型免费或极低；DeepSeek-V3 约 $0.27/$1.1',
    note: '国内直连；一个 Key 聚合多家开源模型，小模型免费，性价比高。',
  },
  {
    id: 'openai',
    name: 'OpenAI（GPT）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    needsProxy: true,
    supportsVision: true,
    priceNote: 'gpt-4o-mini 约 $0.15/$0.6',
    note: '需科学上网；gpt-4o-mini 便宜且支持图片，综合质量最好。',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
    needsProxy: true,
    supportsVision: true,
    priceNote: 'gemini-2.0-flash 免费额度大；付费约 $0.1/$0.4',
    note: '需科学上网；免费额度多、支持图片，性价比极高（推荐）。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter（海外聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'google/gemini-2.0-flash-001',
      'deepseek/deepseek-chat',
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    needsProxy: true,
    supportsVision: true,
    priceNote: '按所选模型定价，部分免费模型 $0',
    note: '需科学上网；一个 Key 用所有主流模型，有免费模型可选。',
  },
  {
    id: 'groq',
    name: 'Groq（超快推理）',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys',
    needsProxy: true,
    supportsVision: false,
    priceNote: '免费额度充足；8B 约 $0.05/$0.08',
    note: '需科学上网；速度极快、免费额度大，纯文本任务性价比高。',
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    keyUrl: '',
    needsProxy: false,
    supportsVision: true,
    priceNote: '—',
    note: '任何兼容 OpenAI /v1/chat/completions 的服务均可接入。',
  },
]
