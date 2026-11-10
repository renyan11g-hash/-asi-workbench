import { ASI_IMPRINT_METHODS } from '../constants/asi'
import { SourceInfo } from '../types'

/**
 * 印刷方式推荐（材质驱动规则引擎，不依赖 AI）
 *
 * 设计原则：
 *  1. 只输出 ASI ESP 上真实存在的那 17 个 Imprint Method（见 constants/asi.ts 的
 *     ASI_IMPRINT_METHODS），外加平台 QC 强制要求的 Unimprinted。绝不自造工艺名，
 *     否则上传 ESP 时会因为枚举值不合法被拒。
 *  2. 材质 → 工艺用**明确的适配矩阵**（材质族 × 工艺 → 分数），不再用子串匹配。
 *     旧实现用 haystack.includes('pe') 这类判断，会把 "paper" 命中成 PE 塑料，
 *     导致几乎所有产品都被推荐十几种工艺。
 *  3. 必须能解释清楚：每种推荐都带「为什么适合这款材质」+ 该工艺的优缺点 + 条件限制。
 *  4. 颜色是硬约束：热升华只能做浅色涤纶/涂层，深色底会发灰——这种情况直接剔除，
 *     而不是推荐完让业务员踩坑。
 */

/** ASI 平台允许的工艺名（17 个，含兜底 Other） */
export type ASIImprintMethod = (typeof ASI_IMPRINT_METHODS)[number]

/** 内部额外使用的兜底项：平台 QC 要求必含，但不在下拉枚举里 */
export type ImprintMethodId = ASIImprintMethod | 'Unimprinted'

/** 同分时的展示优先级：越靠前越常见、越该优先看 */
const PRIORITY_ORDER: ImprintMethodId[] = [
  'Silkscreen',
  'Pad Print',
  'Heat Transfer',
  'Full Color',
  'Embroidered',
  'Laser Engraved',
  'Debossed',
  'Embossed',
  'Foil Stamped',
  'Etched',
  'Engraved',
  'Hot Stamped',
  'Sublimation',
  'Direct to Garment',
  'Emblem',
  'Printed',
  'Other',
  'Unimprinted',
]

/** 全部可选工艺 = 展示优先级 + 平台枚举兜底（枚举将来新增也不会漏） */
const ALL_METHODS: ImprintMethodId[] = Array.from(
  new Set<ImprintMethodId>([...PRIORITY_ORDER, ...ASI_IMPRINT_METHODS, 'Unimprinted'])
)

/** 平台强制必含的三项（与 ILOVECARGO_RULES.imprintRequired 保持一致） */
export const REQUIRED_IMPRINT_METHODS: ImprintMethodId[] = ['Silkscreen', 'Unimprinted', 'Full Color']

/** 材质族：决定用哪一套适配矩阵 */
type MaterialFamily =
  | 'fabric'
  | 'leather'
  | 'soft-plastic'
  | 'rigid-plastic'
  | 'metal'
  | 'glass'
  | 'ceramic'
  | 'wood'
  | 'paper'
  | 'silicone'

const FAMILY_LABEL: Record<MaterialFamily, string> = {
  fabric: '织物',
  leather: '皮革',
  'soft-plastic': '软胶/薄膜',
  'rigid-plastic': '硬塑',
  metal: '金属',
  glass: '玻璃',
  ceramic: '陶瓷',
  wood: '木/竹',
  paper: '纸品',
  silicone: '硅胶',
}

/** 适配分数：3 = 首选，2 = 适合，1 = 有条件（必须带 caveat） */
type Suitability = 1 | 2 | 3

interface Cell {
  score: Suitability
  /** 条件/风险提示：score 为 1 时必填，让业务员知道前提 */
  caveat?: string
}

/**
 * 材质族 × 工艺 适配矩阵。
 * 没列出的组合 = 不适用（0 分，不会出现在推荐里）。
 * 打分依据：工艺与基材的表面能/耐温/是否需开模/是否需涂层等物理限制。
 */
const MATRIX: Record<MaterialFamily, Partial<Record<ImprintMethodId, Cell>>> = {
  fabric: {
    Silkscreen: { score: 3 },
    'Heat Transfer': { score: 3 },
    Embroidered: { score: 3 },
    Emblem: { score: 2 },
    'Full Color': { score: 2, caveat: '织物上的全彩靠数码转印实现，大面积会有胶感' },
    Sublimation: { score: 2, caveat: '仅浅色涤纶/牛津布可用；深色底会发灰' },
    'Direct to Garment': { score: 2, caveat: '仅棉或高棉混纺可直喷' },
    Printed: { score: 1, caveat: '泛称工艺，报价前需确认实际方式' },
    Debossed: { score: 1, caveat: '需较厚织物（帆布），薄料压穿风险' },
  },
  leather: {
    Debossed: { score: 3 },
    Embossed: { score: 3 },
    'Foil Stamped': { score: 3 },
    'Hot Stamped': { score: 2 },
    'Laser Engraved': { score: 2 },
    Silkscreen: { score: 1, caveat: '皮革表面能低，需先做电晕/底涂，附着力一般' },
    'Pad Print': { score: 1, caveat: '仅小面积 logo 可行' },
    'Heat Transfer': { score: 1, caveat: 'PU 皮耐温有限，需低温转印膜' },
  },
  'soft-plastic': {
    Silkscreen: { score: 2 },
    'Pad Print': { score: 2 },
    'Heat Transfer': { score: 2 },
    Embossed: { score: 2 },
    Debossed: { score: 2 },
    Printed: { score: 1, caveat: 'PE/PVC 表面能低，需电晕处理后才印得牢' },
    'Full Color': { score: 1, caveat: '软胶 UV 需专用底涂，折弯处易裂' },
  },
  'rigid-plastic': {
    Silkscreen: { score: 3 },
    'Pad Print': { score: 3 },
    'Full Color': { score: 3 },
    'Hot Stamped': { score: 2 },
    'Laser Engraved': { score: 1, caveat: '亚克力可激光出磨砂白；ABS/PP 需先喷漆才有对比度' },
    Printed: { score: 2 },
    Embossed: { score: 1, caveat: '需开模具，起订量大才划算' },
    Debossed: { score: 1, caveat: '需开模具，起订量大才划算' },
  },
  metal: {
    'Laser Engraved': { score: 3 },
    Etched: { score: 3, caveat: '不锈钢/铝效果最好，需化学蚀刻产线' },
    Engraved: { score: 2 },
    Silkscreen: { score: 2 },
    'Pad Print': { score: 2 },
    'Full Color': { score: 2, caveat: '金属 UV 需底涂，折边处易掉墨' },
    'Foil Stamped': { score: 2 },
    Sublimation: { score: 1, caveat: '仅带涂层的金属片可用' },
    'Heat Transfer': { score: 1, caveat: '仅带涂层的金属可用' },
  },
  glass: {
    'Laser Engraved': { score: 3 },
    Etched: { score: 2 },
    Silkscreen: { score: 2, caveat: '需高温陶瓷油墨 + 烧结，成本高于塑料' },
    'Pad Print': { score: 1, caveat: '仅小面积平面，附着力中等' },
    'Full Color': { score: 1, caveat: '需 UV 附着力促进剂，洗碗机寿命有限' },
  },
  ceramic: {
    Sublimation: { score: 3, caveat: '需涂层杯；深色杯要用专用涂层' },
    Silkscreen: { score: 3, caveat: '需高温烧结，色数多则成本上升' },
    'Laser Engraved': { score: 2 },
    'Full Color': { score: 2 },
    'Pad Print': { score: 2 },
  },
  wood: {
    'Laser Engraved': { score: 3 },
    Engraved: { score: 2 },
    Silkscreen: { score: 2, caveat: '木纹不平整，细线条易断' },
    'Full Color': { score: 2 },
    'Pad Print': { score: 1, caveat: '仅小面积、且需打磨平整' },
    'Foil Stamped': { score: 1, caveat: '需表面平整，否则烫不实' },
  },
  paper: {
    Printed: { score: 3 },
    'Full Color': { score: 3 },
    'Foil Stamped': { score: 3 },
    Debossed: { score: 3 },
    Embossed: { score: 3 },
    'Hot Stamped': { score: 2 },
    Silkscreen: { score: 1, caveat: '纸品丝印不常见，通常用胶印替代' },
  },
  silicone: {
    'Pad Print': { score: 3 },
    Embossed: { score: 3, caveat: '模具成型时直接做出立体 logo' },
    Debossed: { score: 3 },
    Silkscreen: { score: 2, caveat: '需硅胶专用油墨并烘烤固化' },
    'Laser Engraved': { score: 1, caveat: '会发白且边缘发黏，慎用' },
  },
}

// ———————————————————— 材质知识库 ————————————————————

export interface MaterialProfile {
  /** 材质英文名（ASI 标准） */
  name: string
  /** 中文名 */
  nameZh: string
  /** 所属材质族 */
  family: MaterialFamily
  pros: string[]
  cons: string[]
}

/** 常见材质优缺点（用于「材质分析」板块 + 材质族判定） */
export const MATERIAL_PROFILES: MaterialProfile[] = [
  { name: 'Cotton', nameZh: '棉', family: 'fabric', pros: ['亲肤透气', '吸湿性好', '天然环保'], cons: ['易缩水起皱', '干得慢'] },
  { name: 'Polyester', nameZh: '涤纶', family: 'fabric', pros: ['抗皱免烫', '成本低', '色牢度好'], cons: ['透气性一般', '易静电'] },
  { name: 'Nylon', nameZh: '尼龙', family: 'fabric', pros: ['强度高、耐磨', '轻便防水', '弹性好'], cons: ['不耐高温', '长时间日晒易老化'] },
  { name: 'Oxford', nameZh: '牛津布', family: 'fabric', pros: ['耐磨抗撕裂', '挺括有型', '防水涂层易加工'], cons: ['透气性差', '涂层老化后会开裂'] },
  { name: 'Canvas', nameZh: '帆布', family: 'fabric', pros: ['结实耐用', '承重好', '复古质感'], cons: ['较重', '防水性一般'] },
  { name: 'Microfiber', nameZh: '超纤', family: 'fabric', pros: ['手感接近真皮', '耐磨', '易清洁'], cons: ['透气性差', '成本高于普通化纤'] },
  { name: 'Nonwoven', nameZh: '无纺布', family: 'fabric', pros: ['成本极低', '可回收', '大批量友好'], cons: ['强度低', '不耐久用'] },
  { name: 'Mesh', nameZh: '网布', family: 'fabric', pros: ['透气', '轻盈'], cons: ['承重差', '印刷易断墨'] },
  { name: 'Fleece', nameZh: '抓绒', family: 'fabric', pros: ['保暖', '柔软'], cons: ['易起球', '不适合精细图案'] },
  { name: 'Leather', nameZh: '真皮', family: 'leather', pros: ['档次高', '越用越有质感'], cons: ['价格高', '有天然色差'] },
  { name: 'PU Leather', nameZh: 'PU 皮革', family: 'leather', pros: ['外观似真皮', '防水易擦', '成本低'], cons: ['透气性差', '久用易剥落'] },
  { name: 'Stainless Steel', nameZh: '不锈钢', family: 'metal', pros: ['防锈耐腐蚀', '坚固', '食品级安全'], cons: ['较重', '导热快（烫手）'] },
  { name: 'Aluminum', nameZh: '铝', family: 'metal', pros: ['轻量', '易加工', '阳极氧化颜色多'], cons: ['强度低于钢', '易刮花'] },
  { name: 'Metal', nameZh: '金属', family: 'metal', pros: ['质感强', '耐用'], cons: ['较重', '运费高'] },
  { name: 'ABS', nameZh: 'ABS 塑料', family: 'rigid-plastic', pros: ['坚韧抗冲击', '表面易电镀/喷涂', '成本低'], cons: ['不耐紫外线暴晒', '不耐高温'] },
  { name: 'PP', nameZh: 'PP 塑料', family: 'rigid-plastic', pros: ['食品级安全', '耐弯折（活页）', '耐化学'], cons: ['低温脆', '印刷附着需处理'] },
  { name: 'PS', nameZh: 'PS 塑料', family: 'rigid-plastic', pros: ['透明性好', '刚性好', '成本低'], cons: ['脆、易裂'] },
  { name: 'Acrylic', nameZh: '亚克力', family: 'rigid-plastic', pros: ['高透明度', '易加工', '耐候'], cons: ['易刮花', '边角脆'] },
  { name: 'Tritan', nameZh: 'Tritan', family: 'rigid-plastic', pros: ['食品级不含 BPA', '高透明', '耐摔'], cons: ['价格高于普通塑料', '耐热有限'] },
  { name: 'PVC', nameZh: 'PVC', family: 'soft-plastic', pros: ['防水密封好', '柔软可定制', '成本低'], cons: ['环保性一般', '不耐高温'] },
  { name: 'PE', nameZh: 'PE 塑料', family: 'soft-plastic', pros: ['柔韧', '防水', '食品级可用'], cons: ['印刷附着差', '刚性低'] },
  { name: 'EVA', nameZh: 'EVA', family: 'soft-plastic', pros: ['轻质缓冲', '防水', '柔软'], cons: ['不耐油', '高温易变形'] },
  { name: 'Silicone', nameZh: '硅胶', family: 'silicone', pros: ['耐高温低温', '柔软安全', '易清洗'], cons: ['易沾灰', '成本高于普通塑料'] },
  { name: 'Glass', nameZh: '玻璃', family: 'glass', pros: ['高档透明', '无味安全', '可回收'], cons: ['易碎', '运费高'] },
  { name: 'Ceramic', nameZh: '陶瓷', family: 'ceramic', pros: ['质感高档', '保温好', '图案鲜艳'], cons: ['易碎', '重'] },
  { name: 'Bamboo', nameZh: '竹', family: 'wood', pros: ['天然环保', '质感好', '可再生'], cons: ['怕潮易霉', '色差大'] },
  { name: 'Wood', nameZh: '木质', family: 'wood', pros: ['天然质感', '可雕刻', '环保'], cons: ['怕潮变形', '色差大'] },
  { name: 'Paper', nameZh: '纸', family: 'paper', pros: ['成本极低', '可回收环保', '印刷表现好'], cons: ['不防水', '强度有限'] },
]

/** 中文材质 → ASI 英文材质标签（尽量具体，避免「塑料」这类泛词抢占） */
const CN_TO_EN: Array<[RegExp, string]> = [
  [/牛津布|牛津纺/i, 'Oxford'],
  [/超纤|microfiber/i, 'Microfiber'],
  [/无纺布|不织布|nonwoven/i, 'Nonwoven'],
  [/网布|网眼布/i, 'Mesh'],
  [/摇粒绒|抓绒|珊瑚绒|fleece/i, 'Fleece'],
  [/不锈钢|304|316/i, 'Stainless Steel'],
  [/铝合金|阳极氧化|铝合?金?|aluminum/i, 'Aluminum'],
  [/纯棉|全棉|棉布|100%棉|^棉/i, 'Cotton'],
  [/涤纶|聚酯|polyester/i, 'Polyester'],
  [/锦纶|尼龙|nylon/i, 'Nylon'],
  [/帆布|canvas/i, 'Canvas'],
  [/abs/i, 'ABS'],
  [/tritan/i, 'Tritan'],
  [/亚克力|有机玻璃|acrylic/i, 'Acrylic'],
  [/聚丙烯|pp\s*料|\bpp\b/i, 'PP'],
  [/聚苯乙烯|\bps\b/i, 'PS'],
  [/硅胶|silicone/i, 'Silicone'],
  [/pvc/i, 'PVC'],
  [/聚乙烯|\bpe\b/i, 'PE'],
  [/eva/i, 'EVA'],
  [/pu皮|pu革|pu皮革/i, 'PU Leather'],
  [/牛皮|真皮|头层皮|二层皮|皮革/i, 'Leather'],
  [/陶瓷|瓷/i, 'Ceramic'],
  [/玻璃/i, 'Glass'],
  [/竹/i, 'Bamboo'],
  [/木质|实木|原木|木制/i, 'Wood'],
  [/纸/i, 'Paper'],
  [/金属|五金|钛|铜/i, 'Metal'],
  [/塑料/i, 'Rigid Plastic Placeholder'],
]

/** 从任意文本提取材质标签（材质字段优先，标题兜底） */
export function extractMaterialTags(text: string): string[] {
  if (!text) return []
  const tags: string[] = []
  for (const [re, en] of CN_TO_EN) {
    if (re.test(text) && !tags.includes(en)) tags.push(en)
  }
  /*
   * 英文 ASI 材质名兜底：业务员在文案里直接写 Oxford / Stainless Steel 时也要认出来。
   * 以前只认中文别名（牛津布），所以材质栏写 Oxford 会显示"未识别到材质"——
   * 这是排版上最容易被踩到的坑：文案里本来就是英文。
   */
  for (const prof of MATERIAL_PROFILES) {
    const escaped = prof.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i")
    if (re.test(text) && !tags.includes(prof.name)) tags.push(prof.name)
  }

  // 泛词兜底：只有没识别出任何具体材质时，才把「塑料」当成硬塑
  if (tags.includes('Rigid Plastic Placeholder')) {
    const concrete = tags.filter((t) => t !== 'Rigid Plastic Placeholder')
    if (concrete.length) return concrete
    return ['ABS']
  }
  // PU 皮革被 /皮革/ 顺带命中真皮时，去掉泛化的 Leather（除非文本里确实有真皮字样）
  if (tags.includes('PU Leather') && tags.includes('Leather') && !/真皮|牛皮|头层皮|二层皮/.test(text)) {
    return tags.filter((t) => t !== 'Leather')
  }
  return tags
}

// ———————————————————— 工艺知识（优缺点 / 适用形态） ————————————————————

interface MethodMeta {
  nameZh: string
  /** 工艺本身为什么适合这类材质（通用说明，具体材质会在输出时补上） */
  why: string
  pros: string[]
  cons: string[]
  bestFor: string
}

const METHOD_META: Record<ImprintMethodId, MethodMeta> = {
  Silkscreen: {
    nameZh: '丝网印刷',
    why: '单色/专色平面 logo 的性价比之王，对塑料、织物、金属、纸张的附着力都稳定，单价最低。',
    pros: ['单价最低，适合大批量', '专色还原准确（可对 Pantone）', '油墨体系成熟，含环保油墨'],
    cons: ['多色需多次套印，颜色越多越贵', '渐变/照片级图案做不了', '曲面和异形面受限'],
    bestFor: '平面或近平面的袋类、瓶身、纸盒、织物',
  },
  Unimprinted: {
    nameZh: '无印刷（素品）',
    why: '客户自印或做福利品时的选项，平台 QC 强制要求必含。',
    pros: ['零印刷成本', '交期最快', '适合客户自行品牌化'],
    cons: ['无品牌展示', '大部分企业客户不接受'],
    bestFor: '任何产品的兜底选项',
  },
  'Full Color': {
    nameZh: '全彩印刷（数码/UV）',
    why: '照片级全彩一次成型，不需要套色，深浅底都能做，是最通用的彩色方案。',
    pros: ['照片级全彩，无套色限制', '打样快，小批量友好', '深浅色底都能覆盖'],
    cons: ['单件成本高于丝印', '大面积深色覆盖成本高', '曲面受限'],
    bestFor: '亚克力奖牌、纸盒、U 盘外壳、硬质礼品',
  },
  Embroidered: {
    nameZh: '刺绣',
    why: '织物类的经典装饰，线迹立体、耐洗涤，帽子/服装/包袋的标配。',
    pros: ['立体高档，耐洗耐磨', '多色线不加价', '自带质感，客户感知价值高'],
    cons: ['细节极小的文字不清晰', '单件成本高于丝印', '薄软面料易起皱'],
    bestFor: '帽子、服装、毛毯、毛巾、帆布袋',
  },
  'Heat Transfer': {
    nameZh: '热转印',
    why: '把预先印好的图案热压到织物/皮革上，可以整版多色，小批量也划算。',
    pros: ['支持全彩/渐变', '小批量划算', '织物上手感柔软'],
    cons: ['大面积图案透气性差', '高温涂层材质可能不适用', '长期摩擦边缘易起边'],
    bestFor: '涤纶袋、箱包、皮革标、运动服',
  },
  'Laser Engraved': {
    nameZh: '激光雕刻',
    why: '激光直接在表面烧蚀出永久标记，不掉色不磨损，金属/木/皮革上的档次感最强。',
    pros: ['永久标记，不会脱落', '无需油墨，环保', '精度高，适合细线条 logo'],
    cons: ['只能呈现材质本色，无彩色', '仅适合硬质材料', '深色材料需先喷漆才有对比度'],
    bestFor: '金属笔、保温杯、木制品、亚克力',
  },
  'Pad Print': {
    nameZh: '移印',
    why: '硅胶胶头能贴合曲面和凹凸面，是小面积 logo 在异形件上最清晰的方案。',
    pros: ['曲面/异形面可印', '小 logo 精度高', '油墨附着牢'],
    cons: ['印刷面积小', '多色需多次移印', '不适合大面积图案'],
    bestFor: '圆珠笔、瓶盖、小电子件、硅胶制品',
  },
  Debossed: {
    nameZh: '压凹',
    why: '用模具把 logo 压进材料，形成凹陷的立体效果，皮革/纸品的高级做法。',
    pros: ['高档低调，触感明显', '永不脱落', '无油墨更环保'],
    cons: ['无颜色（或需配合烫金）', '需开模，量大才划算', '细节复杂图案不清晰'],
    bestFor: 'PU 皮革笔记本、纸盒、厚帆布',
  },
  Embossed: {
    nameZh: '压凸',
    why: '与压凹相反，把 logo 顶起来形成凸起，皮革标/软胶标的常见做法。',
    pros: ['立体触感强', '品牌辨识度高', '无油墨'],
    cons: ['无颜色', '需开模，费用较高', '薄材料效果差'],
    bestFor: '皮革标牌、PVC 软胶、厚纸品',
  },
  Engraved: {
    nameZh: '机械雕刻',
    why: '用刀具物理铣削出凹槽，比激光更深更粗犷，适合金属/木材厚件。',
    pros: ['标记深、极耐用', '可填漆增色', '适合厚材料'],
    cons: ['速度慢、成本高', '薄/软材料不适用', '细节表现有限'],
    bestFor: '金属牌、木质奖杯、厚亚克力',
  },
  Etched: {
    nameZh: '蚀刻',
    why: '化学蚀刻在金属表面形成极精细的标记，耐腐蚀，高端金属礼品的做法。',
    pros: ['线条极精细', '耐腐蚀耐磨', '手感平滑无毛刺'],
    cons: ['仅限金属', '环保处理成本高', '无颜色（可填漆）'],
    bestFor: '不锈钢杯、金属名片夹、刀叉',
  },
  'Foil Stamped': {
    nameZh: '烫金',
    why: '用金属箔热压出金/银光泽，纸品和皮革的高档首选。',
    pros: ['金属光泽，非常高档', '常用于礼盒/请柬', '可烫多色箔'],
    cons: ['单色平色，无渐变', '大面积烫金成本高', '粗糙表面附着差'],
    bestFor: '礼盒、笔记本封面、贺卡',
  },
  'Hot Stamped': {
    nameZh: '烫印',
    why: '在塑料/纸品表面热压箔印，效果类似烫金，适合小面积 logo。',
    pros: ['光泽感强', '附着力好', '适合小 logo'],
    cons: ['单色', '需开模/制版', '复杂图案受限'],
    bestFor: '塑料盖、化妆品包装、纸品',
  },
  'Direct to Garment': {
    nameZh: '成衣直印（DTG）',
    why: '喷墨直接喷在棉质服装上，全彩、无胶感、透气，小批量 T 恤首选。',
    pros: ['全彩照片级', '无起边、透气', '小批量友好'],
    cons: ['仅棉/高棉混纺', '深色底需预处理增白', '单件成本较高'],
    bestFor: 'T 恤、卫衣、棉帆布袋',
  },
  Emblem: {
    nameZh: '徽章/布标',
    why: '独立制作的绣花章/金属章，缝或贴到产品上，立体且造型自由。',
    pros: ['立体精致', '可独立生产后缝/粘', '复杂造型可行'],
    cons: ['需开模或制版费', '增加单件成本', '轻薄面料不适合'],
    bestFor: '帽子、背包、制服',
  },
  Printed: {
    nameZh: '印刷（通用）',
    why: '泛称工艺，纸品/包装的常规选项，实际执行通常是胶印或数码印。',
    pros: ['通用性强', '成本可控', '适合纸品大面积图案'],
    cons: ['具体工艺需与工厂确认', '效果依材质而定'],
    bestFor: '纸袋、说明书、包装盒',
  },
  Sublimation: {
    nameZh: '热升华',
    why: '高温让颜料气化渗入材质内部，图案和材料融为一体，永不褪色、无手感。',
    pros: ['全彩照片级', '不改变手感、不掉色', '整版印刷无起边'],
    cons: ['仅浅色涤纶或带涂层表面', '纯棉不可用', '深色底效果差（会发灰）'],
    bestFor: '涤纶服装、涂层马克杯、涂层金属片',
  },
  Other: {
    nameZh: '其他（Other）',
    why: '当上面的标准工艺都不匹配时，在 ESP 里选 Other，再在 Additional Imprint Type 里补充真实工艺名。',
    pros: ['不受枚举限制', '可写特殊工艺'],
    cons: ['需要人工补充工艺说明', '部分客户系统不识别'],
    bestFor: '特殊工艺或非常规材质',
  },
}

// ———————————————————— 推荐主逻辑 ————————————————————

export interface ImprintRecommendation {
  /** 英文工艺名（写入 ASI 的枚举值） */
  method: ImprintMethodId
  nameZh: string
  /** 适配分：3 首选 / 2 适合 / 1 有条件 */
  score: number
  /** 分组：required 平台必含 / primary 首选 / suitable 适合 / conditional 有条件 */
  tier: 'required' | 'primary' | 'suitable' | 'conditional'
  /** 为什么适合这款材质 */
  why: string
  pros: string[]
  cons: string[]
  bestFor: string
  /** 条件/风险提示（有条件推荐时必填） */
  caveat?: string
  /** 命中的材质标签 */
  matchedMaterials: string[]
  /** 是否平台强制必含 */
  required?: boolean
}

export interface ImprintExclusion {
  method: ImprintMethodId
  nameZh: string
  /** 为什么这款材质不适合（写给业务员看，也直接喂给 AI） */
  reason: string
}

export interface ImprintRecommendationResult {
  recommendations: ImprintRecommendation[]
  /** 明确排除的工艺 + 原因（避免业务员误选，也给 AI 划红线） */
  excluded: ImprintExclusion[]
  materialProfiles: MaterialProfile[]
  materialTags: string[]
  /** 识别到的材质族（中文标签） */
  families: string[]
  /** 一句话汇总 */
  summary: string
  /** 是否识别到了材质（false 表示走了兜底逻辑） */
  materialDetected: boolean
}

/**
 * 深色判断：深色底会限制热升华、影响丝印打底。
 * 中文（1688 颜色字段）和英文（listing 的 colors 字段）都要认，否则线上用英文颜色时规则会失效。
 */
const DARK_RE =
  /黑|藏青|藏蓝|深蓝|墨绿|深灰|炭灰|咖啡|棕|酒红|深红|深紫|枪灰|深色|black|navy|dark|charcoal|brown|burgundy|maroon|forest green|deep|espresso|graphite/i
const LIGHT_RE =
  /白|米白|象牙|浅|本白|自然色|透明|银白|浅色|white|ivory|light|clear|transparent|silver|natural|cream/i

function isDarkBody(source: { colorsCn?: string; sourceTitle?: string }): boolean {
  const text = [source.colorsCn, source.sourceTitle].filter(Boolean).join(' ')
  if (!text) return false
  if (LIGHT_RE.test(text) && !DARK_RE.test(text)) return false
  return DARK_RE.test(text)
}

/** 把材质标签归到材质族 */
function familiesOf(tags: string[]): MaterialFamily[] {
  const out: MaterialFamily[] = []
  for (const t of tags) {
    const hit = MATERIAL_PROFILES.find((m) => m.name.toLowerCase() === t.toLowerCase())
    if (hit && !out.includes(hit.family)) out.push(hit.family)
  }
  // 认不出的标签（如用户直接传 ASI 材质名但不在表里）→ 不臆测
  return out
}

/** 推荐引擎的输入：材质字段 + 标题（材质兜底）+ 颜色（深色会限制热升华） */
export type ImprintRecoInput = Pick<SourceInfo, 'materialCn' | 'sourceTitle' | 'description'> & {
  colorsCn?: string
}

/**
 * 基于产品材质推荐印刷方式（本地规则引擎，即时出结果）。
 * @param source 1688 商品信息（材质/颜色/标题）
 * @param materialEn 可选：已有 ASI 英文材质标签（优先于中文解析）
 */
export function recommendImprintMethods(
  source: ImprintRecoInput,
  materialEn?: string[]
): ImprintRecommendationResult {
  // 材质来源：显式传入的英文标签 > 材质字段 > 标题（描述太杂，不参与）
  const scanText = [source.materialCn, source.sourceTitle].filter(Boolean).join(' ')
  const materialTags = (materialEn?.length ? materialEn : extractMaterialTags(scanText)).filter(Boolean)
  const families = familiesOf(materialTags)
  const materialDetected = families.length > 0

  const dark = isDarkBody(source)
  const hasCotton = materialTags.some((t) => /cotton/i.test(t))
  const hasPolyester = materialTags.some((t) => /polyester|oxford|microfiber/i.test(t))

  const cnNames = materialTags
    .map((t) => MATERIAL_PROFILES.find((m) => m.name.toLowerCase() === t.toLowerCase())?.nameZh ?? t)
    .filter(Boolean)

  // 1) 按材质族取矩阵里的最高分
  const scored = new Map<ImprintMethodId, { cell: Cell; families: MaterialFamily[] }>()
  for (const fam of families) {
    const row = MATRIX[fam]
    for (const method of ALL_METHODS) {
      const cell = row[method]
      if (!cell) continue
      const prev = scored.get(method)
      if (!prev || cell.score > prev.cell.score) {
        scored.set(method, { cell, families: [fam] })
      } else if (prev && cell.score === prev.cell.score && !prev.families.includes(fam)) {
        prev.families.push(fam)
      }
    }
  }

  // 2) 颜色 / 成分等硬约束在这里统一裁决
  const excluded: ImprintExclusion[] = []
  const dropWith = (method: ImprintMethodId, reason: string) => {
    if (scored.delete(method)) {
      excluded.push({ method, nameZh: METHOD_META[method].nameZh, reason })
    }
  }
  if (scored.has('Direct to Garment') && !hasCotton) {
    dropWith('Direct to Garment', '成衣直印只能上棉或高棉混纺，本款不含棉')
  }
  if (scored.has('Sublimation')) {
    const onFabric = families.includes('fabric')
    const onCoated = families.some((f) => f === 'ceramic' || f === 'metal' || f === 'rigid-plastic')
    if (onFabric && !hasPolyester) dropWith('Sublimation', '热升华只吃涤纶，本款材质不含涤纶')
    else if (onFabric && dark) dropWith('Sublimation', '热升华必须浅色底，本款是深色，印上去会发灰')
    else if (!onFabric && !onCoated) dropWith('Sublimation', '热升华需要涤纶或带涂层的表面，本款都不满足')
  }

  // 3) 组装推荐项
  const recommendations: ImprintRecommendation[] = []
  for (const method of ALL_METHODS) {
    const hit = scored.get(method)
    if (!hit) continue
    const meta = METHOD_META[method]
    const famText = hit.families.map((f) => FAMILY_LABEL[f]).join('/')
    let caveat = hit.cell.caveat
    if (method === 'Sublimation' && !dark && families.includes('fabric')) {
      caveat = '仅浅色涤纶/牛津布可用；本款看起来是浅色，可行，但打样前要确认涤纶含量'
    }
    recommendations.push({
      method,
      nameZh: meta.nameZh,
      score: hit.cell.score,
      tier: hit.cell.score === 3 ? 'primary' : hit.cell.score === 2 ? 'suitable' : 'conditional',
      why: `${meta.why}（适用基材：${famText}${cnNames.length ? `；本款材质：${cnNames.join('、')}` : ''}）`,
      pros: meta.pros,
      cons: meta.cons,
      bestFor: meta.bestFor,
      ...(caveat ? { caveat } : {}),
      matchedMaterials: hit.families
        .flatMap((f) => materialTags.filter((t) => MATERIAL_PROFILES.find((m) => m.name === t)?.family === f))
        .filter((v, i, arr) => arr.indexOf(v) === i),
    })
  }

  // 4) 排序：分数降序 → 同分按 ALL_METHODS 的固定顺序，保证结果稳定可复现
  recommendations.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return ALL_METHODS.indexOf(a.method) - ALL_METHODS.indexOf(b.method)
  })

  // 5) 平台必含三项：无论材质分是多少都要有（ESP 上传硬性要求）
  for (const req of REQUIRED_IMPRINT_METHODS) {
    if (recommendations.some((r) => r.method === req)) continue
    const meta = METHOD_META[req]
    recommendations.push({
      method: req,
      nameZh: meta.nameZh,
      score: 0,
      tier: 'required',
      why: `${meta.why}（平台要求：Imprint Methods 必须包含 ${REQUIRED_IMPRINT_METHODS.join(' / ')}）`,
      pros: meta.pros,
      cons: meta.cons,
      bestFor: meta.bestFor,
      caveat: '这款材质未必是最优工艺，但 ASI 平台强制要求必含，保留即可，客户实际多不会选它',
      matchedMaterials: [],
      required: true,
    })
  }

  // 6) 什么都没识别出来 → 给安全兜底 + Other
  if (!recommendations.some((r) => !r.required)) {
    const fallback: ImprintMethodId[] = ['Silkscreen', 'Pad Print', 'Heat Transfer', 'Printed']
    for (const method of fallback) {
      // 必含项已经在列表里了，别重复推一条（否则同一个工艺会出现两次）
      if (recommendations.some((r) => r.method === method)) continue
      const meta = METHOD_META[method]
      recommendations.push({
        method,
        nameZh: meta.nameZh,
        score: 1,
        tier: 'conditional',
        why: `${meta.why}（未识别到明确材质，按常见促销礼品经验兜底）`,
        pros: meta.pros,
        cons: meta.cons,
        bestFor: meta.bestFor,
        caveat: '材质未识别，务必向工厂确认该工艺是否可上这款产品',
        matchedMaterials: [],
      })
    }
    const other = METHOD_META.Other
    recommendations.push({
      method: 'Other',
      nameZh: other.nameZh,
      score: 1,
      tier: 'conditional',
      why: other.why,
      pros: other.pros,
      cons: other.cons,
      bestFor: other.bestFor,
      caveat: '如上面都不合适，选 Other 后在 Additional Imprint Type 补充真实工艺',
      matchedMaterials: [],
    })
  }

  // 7) 材质分析板块
  const materialProfiles = MATERIAL_PROFILES.filter((mp) =>
    materialTags.some((t) => t.toLowerCase() === mp.name.toLowerCase())
  )

  // 7.5) 补齐「没进推荐」的工艺及其原因，避免业务员以为漏了
  if (materialDetected) {
    const famText = families.map((f) => FAMILY_LABEL[f]).join('/')
    for (const m of ASI_IMPRINT_METHODS) {
      const id = m as ImprintMethodId
      if (id === 'Other') continue
      if (recommendations.some((r) => r.method === id)) continue
      if (excluded.some((e) => e.method === id)) continue
      excluded.push({
        method: id,
        nameZh: METHOD_META[id].nameZh,
        reason: `${famText}类材质通常不用${METHOD_META[id].nameZh}`,
      })
    }
  }

  // 8) 一句话汇总
  const usable = recommendations.filter((r) => !r.required)
  const primary = usable.filter((r) => r.tier === 'primary').map((r) => r.nameZh)
  const suitable = usable.filter((r) => r.tier === 'suitable').map((r) => r.nameZh)
  const summary = materialDetected
    ? `材质：${cnNames.join('、') || materialTags.join('、')}（${families.map((f) => FAMILY_LABEL[f]).join('/')}）｜` +
      `首选：${primary.join('、') || '无'}` +
      `${suitable.length ? `｜适合：${suitable.join('、')}` : ''}` +
      `｜必含：Silkscreen / Unimprinted / Full Color（平台规则${dark ? '；本款为深色，热升华不可用' : ''}）`
    : '未识别到明确材质，已给出常见工艺兜底并附 Other 选项；建议先在材质栏补全后再算一次'

  return {
    recommendations,
    excluded,
    materialProfiles,
    materialTags,
    families: families.map((f) => FAMILY_LABEL[f]),
    summary,
    materialDetected,
  }
}

/**
 * 把推荐结果压成一段「给 AI 看的材质约束」。
 * 关键作用：印刷方式的判断不再让模型自由发挥，而是把规则引擎的结论当事实喂进去，
 * 模型只负责在合规集合里挑选，不能自己加工艺。
 */
export function formatImprintConstraint(
  source: ImprintRecoInput,
  materialEn?: string[]
): string {
  const r = recommendImprintMethods(source, materialEn)
  if (!r.materialDetected) {
    return `MATERIAL CONSTRAINT — this product's material could NOT be identified from the 1688 data.
Compatible methods (safe fallback): Silkscreen, Heat Transfer, Pad Print, Printed.
Always include the platform-required trio: Silkscreen / Unimprinted / Full Color.
Do NOT guess exotic methods (Laser Engraved, Etched, Debossed, Sublimation, DTG) without knowing the material.`
  }

  const byTier = (tier: ImprintRecommendation['tier']) =>
    r.recommendations
      .filter((x) => x.tier === tier)
      .map((x) => x.method)
  const conditional = r.recommendations
    .filter((x) => x.tier === 'conditional')
    .map((x) => `${x.method}（${x.caveat ?? '有前提'}）`)

  return `MATERIAL CONSTRAINT — this product's material is ${r.materialTags.join(' + ')} (${r.families.join('/')}).
The engine already decided which imprints physically work on this material. Treat it as FACT, do not re-derive it:
- PRIMARY (prefer these): ${byTier('primary').join(', ') || 'none'}
- SUITABLE (may add): ${byTier('suitable').join(', ') || 'none'}
- CONDITIONAL (only if the stated condition is met): ${conditional.join('; ') || 'none'}
- ALWAYS REQUIRED by the platform: ${REQUIRED_IMPRINT_METHODS.join(' / ')}
- NEVER use these on this product: ${r.excluded.map((e) => `${e.method}（${e.reason}）`).join('; ') || 'none'}
Pick 3-6 extras in total, prioritizing PRIMARY then SUITABLE. Never output a method from the NEVER list.`
}
