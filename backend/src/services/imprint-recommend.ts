import { SourceInfo } from '../types'

/**
 * 印刷方式推荐模块：
 * 根据产品材质（1688 中文材质描述 / ASI 英文材质标签）推荐所有适合的印刷方式，
 * 并给出：为什么适合（材质适配原因）+ 该方式的优缺点 + 材质本身的优缺点。
 * 规则引擎本地即时出结果（不依赖 AI），AI 侧可在 listing 生成时引用同一知识库。
 */

export type ImprintMethodId =
  | 'Silkscreen'
  | 'Laser Engraved'
  | 'Embroidered'
  | 'Heat Transfer'
  | 'Sublimation'
  | 'Full Color'
  | 'Pad Print'
  | 'Debossed'
  | 'Embossed'
  | 'Engraved'
  | 'Etched'
  | 'Foil Stamped'
  | 'Hot Stamped'
  | 'Direct to Garment'
  | 'Emblem'
  | 'Printed'
  | 'Unimprinted'

export interface ImprintMethodProfile {
  id: ImprintMethodId
  /** 中文名 */
  nameZh: string
  /** 适合的材质关键词（小写英文 + 中文） */
  materials: string[]
  /** 为什么适合这类材质 */
  why: string
  pros: string[]
  cons: string[]
  /** 适合的产品形态提示 */
  bestFor: string
}

export const IMPRINT_METHOD_PROFILES: ImprintMethodProfile[] = [
  {
    id: 'Silkscreen',
    nameZh: '丝网印刷',
    materials: ['plastic', 'pp', 'pe', 'pvc', 'pet', 'nylon', 'polyester', 'canvas', 'cotton', 'paper', 'metal', 'glass', 'ceramic', 'wood', 'silicone', '橡胶', '塑料', '尼龙', '涤纶', '帆布', '棉', '纸', '金属', '玻璃', '陶瓷', '木质', '硅胶'],
    why: '平面上单色/多色 logo 的通用方案，对塑料、织物、金属、纸张等绝大多数材质都有良好附着力，成本低。',
    pros: ['单价最低，适合大批量', '1-2 色 logo 效果清晰', '油墨选择多（含环保油墨）'],
    cons: ['多色套色成本上升', '复杂渐变图案效果差', '曲面/异形面受限'],
    bestFor: '平面或近平面的袋类、瓶身、纸盒、织物',
  },
  {
    id: 'Laser Engraved',
    nameZh: '激光雕刻',
    materials: ['metal', 'stainless steel', 'aluminum', 'wood', 'leather', 'bamboo', '金属', '不锈钢', '铝', '木质', '皮革', '竹'],
    why: '在金属、木材、皮革表面永久性雕刻，耐磨永不掉色，档次感强。',
    pros: ['永久标记，不会磨损脱落', '无需油墨，环保', '精度高，适合细线条 logo'],
    cons: ['只能呈现材质本色（无彩色）', '仅适合硬质材料', '深色金属需先喷漆才有对比度'],
    bestFor: '金属笔、保温杯、木制品、皮革制品',
  },
  {
    id: 'Embroidered',
    nameZh: '刺绣',
    materials: ['cotton', 'polyester', 'canvas', 'nylon', 'fleece', 'towel', '棉', '涤纶', '帆布', '尼龙', '抓绒', '毛巾布'],
    why: '织物类产品的经典装饰方式，立体感强、耐洗涤，适合帽子/服装/包袋。',
    pros: ['立体高档，耐洗耐磨', '适合帽子、polo 衫、背包', '多色不额外加价（线色自由）'],
    cons: ['细节极小的文字/图案不清晰', '每件成本高于丝印', '薄软面料易起皱'],
    bestFor: '帽子、服装、毛毯、毛巾、帆布袋',
  },
  {
    id: 'Heat Transfer',
    nameZh: '热转印',
    materials: ['polyester', 'nylon', 'canvas', 'pvc', 'leather', '涤纶', '尼龙', '帆布', '皮革', 'pvc'],
    why: '可整版多色图案转印到织物/皮革，适合彩色复杂 logo，附着力好。',
    pros: ['支持全彩/渐变图案', '小批量也划算', '织物上手感柔软'],
    cons: ['大面积图案透气性差', '高温材质（如涂层）可能不适用', '摩擦久边缘可能起边'],
    bestFor: '涤纶袋、箱包、皮革标',
  },
  {
    id: 'Sublimation',
    nameZh: '热升华',
    materials: ['polyester', 'ceramic', 'metal with coating', '涤纶', '陶瓷', '涂层金属'],
    why: '仅适用于聚酯纤维或带涂层的硬质表面，图案渗入材质内部，永不褪色。',
    pros: ['全彩照片级效果', '不改变手感、不掉色', '整版印刷无起边'],
    cons: ['只对浅色涤纶/涂层表面有效', '纯棉不可用', '白色以外深色底效果差'],
    bestFor: '涤纶服装、马克杯、涂层金属板',
  },
  {
    id: 'Full Color',
    nameZh: '全彩印刷（UV/数码）',
    materials: ['plastic', 'metal', 'paper', 'wood', 'glass', 'acrylic', '塑料', '金属', '纸', '木质', '玻璃', '亚克力'],
    why: 'UV 数码直印，照片级全彩，几乎任何硬质平面都可用，打样快。',
    pros: ['照片级全彩，无套色限制', '打样快，小批量友好', '深浅色底均可'],
    cons: ['单件成本高于丝印', '大面积深色覆盖成本高', '曲面受限'],
    bestFor: '亚克力奖牌、纸盒、U 盘外壳、硬质礼品',
  },
  {
    id: 'Pad Print',
    nameZh: '移印',
    materials: ['plastic', 'pp', 'abs', 'metal', 'glass', 'ceramic', 'silicone', '塑料', 'pp', 'abs', '金属', '玻璃', '陶瓷', '硅胶'],
    why: '胶头可贴合曲面/凹凸面，小 logo 在异形件（笔、球、瓶盖）上最清晰。',
    pros: ['曲面/异形面印刷', '小 logo 精度高', '油墨附着牢'],
    cons: ['印刷面积小', '多色需多次移印', '不适合大面积图案'],
    bestFor: '圆珠笔、乒乓球、瓶盖、小电子件',
  },
  {
    id: 'Debossed',
    nameZh: '压凹（凹陷）',
    materials: ['leather', 'pu', 'paper', 'canvas', 'velvet', '皮革', 'pu', '纸', '帆布', '绒布'],
    why: '皮革/纸品压凹出立体凹陷 logo，低调高级，无需油墨。',
    pros: ['高档质感', '永不脱落', '无油墨更环保'],
    cons: ['无颜色（或需配合烫金）', '仅软质/厚质材料', '细节复杂图案不清晰'],
    bestFor: 'PU 皮革笔记本、纸盒、帆布袋',
  },
  {
    id: 'Embossed',
    nameZh: '压凸（凸起）',
    materials: ['leather', 'pu', 'paper', 'silicone', 'pvc', '皮革', 'pu', '纸', '硅胶', 'pvc'],
    why: '与压凹相反的立体凸起效果，常用于皮革标、PVC 软胶标。',
    pros: ['立体触感强', '品牌辨识度高', '无油墨'],
    cons: ['无颜色', '需要开模（费用较高）', '薄材料效果差'],
    bestFor: '皮革标牌、PVC 软胶、厚纸品',
  },
  {
    id: 'Engraved',
    nameZh: '机械雕刻',
    materials: ['metal', 'wood', 'acrylic', '金属', '木质', '亚克力'],
    why: '物理雕刻出凹槽标记，比激光更深，适合金属/木材厚件。',
    pros: ['标记深、耐用', '可填漆增色', '适合厚材料'],
    cons: ['速度慢、成本高', '薄/软材料不适用', '细节有限'],
    bestFor: '金属牌、木质奖杯、亚克力',
  },
  {
    id: 'Etched',
    nameZh: '蚀刻',
    materials: ['metal', 'stainless steel', '金属', '不锈钢'],
    why: '化学蚀刻在金属表面形成精细标记，耐腐蚀，适合高端金属礼品。',
    pros: ['极精细线条', '耐腐蚀耐磨', '手感平滑'],
    cons: ['仅金属', '环保处理成本高', '无颜色（可填漆）'],
    bestFor: '不锈钢杯、金属名片夹、刀叉',
  },
  {
    id: 'Foil Stamped',
    nameZh: '烫金',
    materials: ['paper', 'leather', 'pu', 'velvet', '纸', '皮革', 'pu', '绒布'],
    why: '金属箔烫压出金色/银色光泽 logo，纸品与皮革的高档首选。',
    pros: ['金属光泽、非常高档', '常用于礼盒/请柬', '可烫多色箔'],
    cons: ['仅单色平色', '大面积烫金成本高', '粗糙表面附着差'],
    bestFor: '礼盒、笔记本封面、贺卡',
  },
  {
    id: 'Hot Stamped',
    nameZh: '烫印',
    materials: ['plastic', 'pp', 'ps', 'paper', '塑料', 'pp', 'ps', '纸'],
    why: '塑料/纸品表面热压箔印，效果类似烫金，适合小面积 logo。',
    pros: ['光泽感强', '附着力好', '适合小 logo'],
    cons: ['单色', '需要开模/制版', '复杂图案受限'],
    bestFor: '塑料盖、化妆品包装、纸品',
  },
  {
    id: 'Direct to Garment',
    nameZh: '成衣直印（DTG）',
    materials: ['cotton', 'cotton blend', '棉', '棉混纺'],
    why: '喷墨直接印在棉质服装上，全彩无起边，小批量 T 恤首选。',
    pros: ['全彩照片级', '无起边、透气', '小批量友好'],
    cons: ['仅棉质/高棉混纺', '深色底需预处理', '单件成本较高'],
    bestFor: 'T 恤、卫衣、帆布袋（棉）',
  },
  {
    id: 'Emblem',
    nameZh: '徽章/布标',
    materials: ['polyester', 'canvas', 'cotton', 'nylon', '涤纶', '帆布', '棉', '尼龙'],
    why: '独立绣花章/金属章缝制或粘贴于产品，立体且可做复杂造型。',
    pros: ['立体精致', '可独立生产后缝/粘', '复杂造型可行'],
    cons: ['需开模或制版费', '增加单件成本', '轻薄面料不适合'],
    bestFor: '帽子、背包、制服',
  },
  {
    id: 'Printed',
    nameZh: '印刷（通用）',
    materials: ['paper', 'plastic', 'pp', 'pe', '纸', '塑料', 'pp', 'pe'],
    why: '泛指常规印刷工艺，纸品/塑料包装的通用选项。',
    pros: ['通用性强', '成本可控'],
    cons: ['具体工艺需确认', '效果依材质而定'],
    bestFor: '纸袋、说明书、包装',
  },
  {
    id: 'Unimprinted',
    nameZh: '无印刷（素品）',
    materials: [],
    why: '客户自行印刷或不需要 logo 时的选项，常作为兜底。',
    pros: ['零印刷成本', '交期最快'],
    cons: ['无品牌展示', '部分客户不接受'],
    bestFor: '任何产品（兜底选项）',
  },
]

export interface MaterialProfile {
  /** 材质英文名（ASI 标准） */
  name: string
  /** 中文名 */
  nameZh: string
  pros: string[]
  cons: string[]
}

/** 常见材质优缺点（用于「材质优缺点」独立板块） */
export const MATERIAL_PROFILES: MaterialProfile[] = [
  { name: 'Nylon', nameZh: '尼龙', pros: ['强度高、耐磨', '轻便防水', '弹性好'], cons: ['不耐高温', '长时间日晒易老化'] },
  { name: 'Polyester', nameZh: '涤纶', pros: ['抗皱免烫', '成本低', '色牢度好'], cons: ['透气性一般', '易静电'] },
  { name: 'Cotton', nameZh: '棉', pros: ['亲肤透气', '吸湿性好', '天然环保'], cons: ['易缩水起皱', '干的慢'] },
  { name: 'Canvas', nameZh: '帆布', pros: ['结实耐用', '承重好', '复古质感'], cons: ['较重', '防水性一般'] },
  { name: 'Stainless Steel', nameZh: '不锈钢', pros: ['防锈耐腐蚀', '坚固', '食品级安全'], cons: ['较重', '导热快（烫手）'] },
  { name: 'Aluminum', nameZh: '铝', pros: ['轻量', '易加工', '阳极氧化颜色多'], cons: ['强度低于钢', '易刮花'] },
  { name: 'ABS', nameZh: 'ABS 塑料', pros: ['坚韧抗冲击', '表面易电镀/喷涂', '成本低'], cons: ['不耐紫外线暴晒', '不耐高温'] },
  { name: 'PP', nameZh: 'PP 塑料', pros: ['食品级安全', '耐弯折（活页）', '耐化学'], cons: ['低温脆', '印刷附着需处理'] },
  { name: 'Silicone', nameZh: '硅胶', pros: ['耐高温低温', '柔软安全', '易清洗'], cons: ['易沾灰', '成本高于普通塑料'] },
  { name: 'Bamboo', nameZh: '竹', pros: ['天然环保', '质感好', '可再生'], cons: ['怕潮易霉', '色差大'] },
  { name: 'Glass', nameZh: '玻璃', pros: ['高档透明', '无味安全', '可回收'], cons: ['易碎', '运费高'] },
  { name: 'Ceramic', nameZh: '陶瓷', pros: ['质感高档', '保温好', '图案鲜艳'], cons: ['易碎', '重'] },
  { name: 'PU Leather', nameZh: 'PU 皮革', pros: ['外观似真皮', '防水易擦', '成本低'], cons: ['透气性差', '久用易剥落'] },
  { name: 'Paper', nameZh: '纸', pros: ['成本极低', '可回收环保', '印刷表现好'], cons: ['不防水', '强度有限'] },
  { name: 'Acrylic', nameZh: '亚克力', pros: ['高透明度', '易加工', '耐候'], cons: ['易刮花', '脆（边角）'] },
  { name: 'PVC', nameZh: 'PVC', pros: ['防水密封好', '柔软可定制', '成本低'], cons: ['环保性一般', '不耐高温'] },
  { name: 'PE', nameZh: 'PE 塑料', pros: ['柔韧', '防水', '食品级可用'], cons: ['印刷附着差', '刚性低'] },
  { name: 'Wood', nameZh: '木质', pros: ['天然质感', '可雕刻', '环保'], cons: ['怕潮变形', '色差大'] },
  { name: 'EVA', nameZh: 'EVA', pros: ['轻质缓冲', '防水', '柔软'], cons: ['不耐油', '高温易变形'] },
  { name: 'Tritan', nameZh: 'Tritan', pros: ['食品级不含 BPA', '高透明', '耐摔'], cons: ['价格高于普通塑料', '耐热有限'] },
]

// —— 中文材质 → 英文标签映射（复用 detectMaterials 的思路，独立轻量版）——
const CN_TO_EN: Array<[RegExp, string]> = [
  [/尼龙/i, 'Nylon'],
  [/涤纶|聚酯/i, 'Polyester'],
  [/纯棉|全棉|棉布/i, 'Cotton'],
  [/帆布/i, 'Canvas'],
  [/不锈钢/i, 'Stainless Steel'],
  [/铝合金|铝/i, 'Aluminum'],
  [/abs/i, 'ABS'],
  [/pp\b|聚丙烯/i, 'PP'],
  [/硅胶/i, 'Silicone'],
  [/竹/i, 'Bamboo'],
  [/玻璃/i, 'Glass'],
  [/陶瓷|瓷/i, 'Ceramic'],
  [/pu皮|pu皮革|pu革/i, 'PU Leather'],
  [/牛皮|真皮|皮革/i, 'Leather'],
  [/纸/i, 'Paper'],
  [/亚克力|有机玻璃/i, 'Acrylic'],
  [/pvc/i, 'PVC'],
  [/pe\b|聚乙烯/i, 'PE'],
  [/木质|实木|木/i, 'Wood'],
  [/eva/i, 'EVA'],
  [/tritan/i, 'Tritan'],
  [/塑料/i, 'Plastic'],
  [/金属/i, 'Metal'],
]

/** 从中文材质描述提取英文材质标签 */
export function extractMaterialTags(materialCn: string): string[] {
  const tags: string[] = []
  for (const [re, en] of CN_TO_EN) {
    if (re.test(materialCn) && !tags.includes(en)) tags.push(en)
  }
  return tags
}

export interface ImprintRecommendation {
  method: ImprintMethodId
  nameZh: string
  /** 为什么适合该产品材质 */
  why: string
  pros: string[]
  cons: string[]
  bestFor: string
  /** 匹配到的材质 */
  matchedMaterials: string[]
}

export interface ImprintRecommendationResult {
  /** 推荐的印刷方式（按匹配度排序） */
  recommendations: ImprintRecommendation[]
  /** 涉及材质的优缺点（独立板块） */
  materialProfiles: MaterialProfile[]
  /** 提取到的材质标签 */
  materialTags: string[]
  /** 汇总说明（给 AI prompt / 前端展示） */
  summary: string
}

/**
 * 基于产品材质推荐所有适合的印刷方式（规则引擎，本地即时）。
 * @param materialCn 1688 中文材质描述（如 "尼龙+PE"）
 * @param materialEn 可选：已有 ASI 英文材质标签
 */
export function recommendImprintMethods(
  source: Pick<SourceInfo, 'materialCn' | 'sourceTitle' | 'description'>,
  materialEn?: string[]
): ImprintRecommendationResult {
  const haystack = [source.materialCn, source.sourceTitle, source.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const materialTags = (materialEn?.length ? materialEn : extractMaterialTags(source.materialCn)).map(
    (m) => m.toLowerCase()
  )

  const recommendations: ImprintRecommendation[] = []
  for (const profile of IMPRINT_METHOD_PROFILES) {
    if (profile.id === 'Unimprinted') continue // 兜底不主动推荐
    const matched = profile.materials.filter((m) => {
      const mm = m.toLowerCase()
      return materialTags.some((t) => t.includes(mm) || mm.includes(t)) || haystack.includes(mm)
    })
    if (matched.length) {
      recommendations.push({
        method: profile.id,
        nameZh: profile.nameZh,
        why: profile.why,
        pros: profile.pros,
        cons: profile.cons,
        bestFor: profile.bestFor,
        matchedMaterials: matched,
      })
    }
  }

  // 材质优缺点（独立板块）
  const materialProfiles = MATERIAL_PROFILES.filter((mp) => {
    const name = mp.name.toLowerCase()
    return materialTags.some((t) => t.includes(name) || name.includes(t))
  })

  const summary = recommendations.length
    ? `根据材质（${materialTags.join(', ') || '未识别'}）推荐 ${recommendations.length} 种印刷方式：${recommendations
        .map((r) => r.method)
        .join(' / ')}。`
    : '未识别到明确材质，建议默认 Silkscreen（丝印）+ Full Color（全彩）兜底。'

  return { recommendations, materialProfiles, materialTags, summary }
}
