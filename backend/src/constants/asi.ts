/**
 * ASI / PPAI 行业标准常量
 * 数据来自 ASI Member Product Search、ESP/SAGE 平台模板与促销礼品行业惯例。
 * 这是单一事实源 —— 前后端各持一份镜像，请保持同步。
 */

/** ASI 28 个一级大类（与 ASI 平台搜索下拉一致） */
export const ASI_CATEGORIES = [
  'Apparel & Outerwear',
  'Automotive Accessories',
  'Awards & Trophies',
  'Baby, Toddler, & Child Items',
  'Bags & Luggage',
  'Caps & Hats',
  'Drinkware',
  'Electronics & Tech Products',
  'Equipment and Business Services',
  'Food, Beverage & Tobacco',
  'Health, Beauty & Wellness',
  'Home & Garden',
  'Jewelry and Accessories',
  'Key Chains',
  'Kitchen & Dining',
  'Lanyard, Badges, & Badge Holders',
  'Magnets & Buttons, Stickers & Decals',
  'Party Supplies',
  'Pet Supplies',
  'Publications',
  'School, Office, & Craft Supplies',
  'Signs, Banners, Flags, & Displays',
  'Sports, Fitness, & Outdoors',
  'Storage & Organization',
  'Tools & Hardware',
  'Toys, Games, & Novelties',
  'Writing Instruments',
  'Other',
] as const

/** ASI 主题库 —— 选 5 个，含 Anniversary / Sustainable 作为万金油兜底 */
export const ASI_THEMES = [
  'Academic',
  'Animal',
  'Anniversary',
  'Aromatherapy & Relaxation',
  'Auto Racing',
  'Automotive',
  'Aviation',
  'Award Programs',
  'Baby',
  'Back To School',
  'Baseball',
  'Basketball',
  'Beach',
  'Beauty',
  'Bereavement',
  'Bicycling',
  'Biodegradable',
  'Birthday',
  'Bowling',
  'Boxing',
  'Breast Cancer',
  'Camping',
  'Celestial',
  'Chamadan',
  'Cheerleading',
  'Christmas',
  'Collegiate',
  'Communications',
  'Company Picnic',
  'Construction',
  'Corporate',
  'Cultural',
  'Dental',
  'Direct-Mail',
  'Easter',
  'Eco & Environmentally Friendly',
  'Education',
  'Elections',
  'Employee Recognition',
  'Entertainment',
  'Equestrian',
  "Father's Day",
  'Finance',
  'Firefighters',
  'Fishing',
  'Food',
  'Football',
  'Gambling',
  'Gardening',
  'Global',
  'Golf',
  'Graduation',
  'Grand Opening',
  'Gymnastics',
  'Halloween',
  'Hawaiian',
  'Health & Fitness',
  'Healthcare',
  'Hockey',
  'Holidays',
  'Hunting',
  'July 4th',
  'Karate',
  'Labor Day',
  'Lacrosse',
  'Love',
  'Martial Arts',
  'Medical',
  'Military',
  "Mother's Day",
  'Music',
  'Mythical',
  'Native Americans',
  'Nautical',
  'New Year',
  'Non-Profit',
  'Number One',
  'Organic',
  'Organizations',
  'PPE Personal Protective Equipment',
  'Patriotic',
  'Performing Arts',
  'Pharmaceutical',
  'Physically Challenged',
  'Police',
  'Political',
  'Pool',
  'Prehistoric',
  'Real Estate',
  'Recycled',
  'Romance',
  'Safety',
  'Sailing',
  'Seasons',
  'Seminars',
  'Skating',
  'Skiing',
  'Soccer',
  'Social Distancing',
  'Softball',
  'Spa',
  'Space Exploration',
  'Sports',
  "St. Patrick's Day",
  'Substance Abuse Awareness',
  'Sustainable',
  'Swimming',
  'Tennis',
  'Thank You',
  'Thanksgiving',
  'Track and Field',
  'Trade Show',
  'Transportation',
  'Travel',
  'USA',
  'Vacations',
  "Valentine's Day",
  'Volleyball',
  'Wedding',
  'Wellness',
  'Western',
  'Wilderness',
  'Wrestling',
  'Zodiac',
] as const

/** 默认必含的两个万金油主题 */
export const DEFAULT_THEMES = ['Anniversary', 'Sustainable'] as const

/** ASI 标准材质列表 */
export const ASI_MATERIALS = [
  'Blend',
  'Bamboo',
  'Canvas',
  'Cashmere',
  'Cotton',
  'Felt',
  'Fleece',
  'Hemp',
  'Mesh',
  'Microfiber Cloth',
  'Non-Woven Fabric',
  'Nylon',
  'Other Fabric',
  'Oxford',
  'Polyester',
  'Silk',
  'Spandex',
  'Wool',
  'Foam',
  'Crystal',
  'Glass',
  'Optical Glass',
  'Other Glass',
  'Leather',
  'Other Leather/Suede',
  'Suede',
  'Alloy',
  'Aluminum',
  'Brass',
  'Copper',
  'Gold',
  'Iron',
  'Metal',
  'Nickel',
  'Other Metal',
  'Pewter',
  'Silver',
  'Stainless Steel',
  'Steel',
  'Bone',
  'Cork',
  'Jute/Burlap',
  'Other Organic Material',
  'ABS',
  'Acrylic Plastic',
  'Neoprene',
  'Other Plastic',
  'PET/PETE',
  'PVC',
  'Plastic',
  'Polycarbonate',
  'Polyethylene (PE)',
  'Polypropylene',
  'Polyurethane (PUR or PU)',
  'Resin',
  'Silicone',
  'TPE',
  'Latex',
  'Rubber',
  'Ceramic',
  'Gemstone',
  'Other Stone/Ceramic',
  'Stone',
  'Vinyl',
  'Bamboo Wood',
  'Composite Board',
  'Other Wood/Paper',
  'Paper',
  'Wood',
  'Other',
] as const

/** ASI 标准印刷方式 */
export const ASI_IMPRINT_METHODS = [
  'Debossed',
  'Direct to Garment',
  'Emblem',
  'Embossed',
  'Embroidered',
  'Engraved',
  'Etched',
  'Foil Stamped',
  'Full Color',
  'Heat Transfer',
  'Hot Stamped',
  'Laser Engraved',
  'Pad Print',
  'Printed',
  'Silkscreen',
  'Sublimation',
  'Other',
] as const

/** 中文颜色 → ASI 平台英文颜色（标题首字母大写、用于多选 chips） */
export const COLOR_DICT: Array<[RegExp, string]> = [
  [/黑|墨黑|碳黑|玄色|深咖?色?/i, 'Black'],
  [/白|米白|乳白|象牙/i, 'White'],
  [/红|正红|大红|朱红/i, 'Red'],
  [/酒红|暗红|枣红/i, 'Burgundy'],
  [/橙|橘/i, 'Orange'],
  [/黄|金黄|姜黄/i, 'Yellow'],
  [/蓝|宝蓝|湖蓝|浅蓝|海蓝/i, 'Blue'],
  [/藏青|深蓝|海军蓝|深蓝灰|深青/i, 'Navy'],
  [/天蓝|天空|淡蓝/i, 'Sky Blue'],
  [/绿|翠绿|墨绿|草绿|碧绿/i, 'Green'],
  [/军绿|橄榄|军迷/i, 'Army Green'],
  [/浅绿|嫩绿|薄荷/i, 'Mint'],
  [/粉|桃粉|粉色|少女粉/i, 'Pink'],
  [/紫|罗兰|藕紫/i, 'Purple'],
  [/灰|银灰|深灰|浅灰|雾霾/i, 'Gray'],
  [/银/i, 'Silver'],
  [/金|亮金|香槟金/i, 'Gold'],
  [/棕|咖色|咖啡色|摩卡/i, 'Brown'],
  [/米色|米黄|浅咖/i, 'Beige'],
  [/透明|无色/i, 'Clear'],
  [/彩虹|多彩/i, 'Multicolor'],
  [/原木|本色/i, 'Natural'],
]

/** 给 Listing 颜色字段使用：合并为 "Black/Gray/Brown/Orange/Army Green" 这种 ASI 标准斜杠串 */
export function translateColors(cnText: string): string {
  if (!cnText?.trim()) return ''
  const set = new Set<string>()
  for (const [re, en] of COLOR_DICT) if (re.test(cnText)) set.add(en)
  return Array.from(set).join('/')
}

/** 反向查一个中文描述里包含哪些 ASI 颜色（用于 chips 展示） */
export function detectColors(cnText: string): string[] {
  if (!cnText?.trim()) return []
  const set = new Set<string>()
  for (const [re, en] of COLOR_DICT) if (re.test(cnText)) set.add(en)
  return Array.from(set)
}

/** 1688 材质描述 → ASI 材质标签 */
export const MATERIAL_DICT: Array<[RegExp, string]> = [
  [/不锈钢|304|316|201\b|stainless/i, 'Stainless Steel'],
  [/合金|alloy/i, 'Alloy'],
  [/铝|aluminum|aluminium/i, 'Aluminum'],
  [/黄铜|铜\b|brass/i, 'Brass'],
  [/紫铜|红铜|copper/i, 'Copper'],
  [/金|gold/i, 'Gold'],
  [/银|silver/i, 'Silver'],
  [/锌|镍|锡|镍合金|nickel/i, 'Nickel'],
  [/铁|钢\b|steel/i, 'Steel'],
  [/其他金属|其他合金|other metal/i, 'Metal'],
  [/硅胶|silicone/i, 'Silicone'],
  [/橡胶|rubber/i, 'Rubber'],
  [/乳胶/i, 'Latex'],
  [/PU|TPU/i, 'Polyurethane (PUR or PU)'],
  [/PVC/i, 'PVC'],
  [/PE\b|聚乙烯/i, 'Polyethylene (PE)'],
  [/PP\b|聚丙烯/i, 'Polypropylene'],
  [/PET/i, 'PET/PETE'],
  [/PC\b|聚碳酸酯/i, 'Polycarbonate'],
  [/ABS/i, 'ABS'],
  [/亚克力|acrylic/i, 'Acrylic Plastic'],
  [/尼龙|nylon/i, 'Nylon'],
  [/涤纶|聚酯|polyester/i, 'Polyester'],
  [/棉|纯棉|cotton/i, 'Cotton'],
  [/麻\b/i, 'Blend'],
  [/帆布|canvas/i, 'Canvas'],
  [/无纺布|non.?woven/i, 'Non-Woven Fabric'],
  [/羊绒|绒|cashmere/i, 'Cashmere'],
  [/羊毛|wool/i, 'Wool'],
  [/丝绸|真丝|silk/i, 'Silk'],
  [/氨纶|spandex|lycra/i, 'Spandex'],
  [/绒布|毛毡|felt/i, 'Felt'],
  [/摇粒绒|fleece/i, 'Fleece'],
  [/网布|网眼|mesh/i, 'Mesh'],
  [/竹\b|bamboo/i, 'Bamboo'],
  [/木\b/i, 'Wood'],
  [/竹木/i, 'Bamboo Wood'],
  [/复合板|合成板|密度板/i, 'Composite Board'],
  [/软木|cork/i, 'Cork'],
  [/麻绳|黄麻|jute|burlap/i, 'Jute/Burlap'],
  [/陶瓷|ceramic/i, 'Ceramic'],
  [/石头|石质|stone/i, 'Stone'],
  [/玻璃|glass/i, 'Glass'],
  [/水晶|crystal/i, 'Crystal'],
  [/树脂|resin/i, 'Resin'],
  [/皮革|真皮|leather/i, 'Leather'],
  [/PU皮|PU leather/i, 'Other Leather/Suede'],
  [/麂皮|suede/i, 'Suede'],
  [/乙烯基|vinyl/i, 'Vinyl'],
  [/TPE/i, 'TPE'],
  [/乳胶\b/i, 'Latex'],
  [/海绵|foam/i, 'Foam'],
  [/纸|paper/i, 'Paper'],
  [/其他材质|other material/i, 'Other'],
]

export function detectMaterial(cnText: string): string {
  if (!cnText?.trim()) return 'Other'
  for (const [re, en] of MATERIAL_DICT) if (re.test(cnText)) return en
  return 'Other'
}

/** 1688 材质描述 → ASI 材质标签数组（支持多材质逗号分隔输入，按出现顺序去重）。
 *  示例：「不锈钢+铝合金」→ ['Stainless Steel', 'Aluminum']
 *       「304不锈钢」→ ['Stainless Steel']
 *       找不到匹配 → ['Other']
 */
export function detectMaterials(cnText: string): string[] {
  if (!cnText?.trim()) return ['Other']
  // 拆词支持中英文逗号、加号、空格、顿号分隔
  const parts = cnText.split(/[,,+、\s]+/).map((s) => s.trim()).filter(Boolean)
  const set: string[] = []
  for (const part of parts) {
    let hit = ''
    for (const [re, en] of MATERIAL_DICT) if (re.test(part)) { hit = en; break }
    if (!hit) {
      // 整串也没匹配时回退到整串匹配
      for (const [re, en] of MATERIAL_DICT) if (re.test(cnText)) { hit = en; break }
    }
    if (hit && !set.includes(hit)) set.push(hit)
  }
  return set.length ? set : ['Other']
}

/** 字符限制与质检 */
export const LIMITS = {
  title: 60,
  summary: 130,
  description: 800,
  keywordMax: 30, // 关键词组数
  keywordGroup: 30, // 每组字符
  keywordWords: 4, // 每组单词
  themes: 5,
  imprintMethodsMax: ASI_IMPRINT_METHODS.length,
}

/** ilovecargo.com/tool/encode 等价 ASI 标准检测规则。
 *  我们不在产品内调用第三方接口，而是按下面规则做等价校验。
 *  ListingEditor 的 QC 卡按此输出绿/红，与 ilovecargo 的判定一致。
 */
export const ILOVECARGO_RULES = [
  { key: 'titleLen', label: 'Product Title ≤ 60 字符', max: LIMITS.title },
  {
    key: 'summaryLen',
    label: 'Summary Description ≤ 130 字符（末尾含 "Rush service is available"）',
    max: LIMITS.summary,
  },
  { key: 'descriptionLen', label: 'Full Description ≤ 800 字符', max: LIMITS.description },
  { key: 'keywordCount', label: `Keywords ≤ ${LIMITS.keywordMax} 组`, max: LIMITS.keywordMax },
  {
    key: 'themesCount',
    label: `Themes = ${LIMITS.themes}（必含 Anniversary + Sustainable）`,
    expected: LIMITS.themes,
    requiredContains: ['Anniversary', 'Sustainable'],
  },
  {
    key: 'imprintRequired',
    label: 'Imprint Methods 必含 Silkscreen + Unimprinted + Full Color',
    required: ['Silkscreen', 'Unimprinted', 'Full Color'],
  },
] as const

/** 关键词种子库（来源：用户提供的 asinseed/Amazon 高频 promo 词经过去重 + 连写切分）。
 *  在 AI 生成关键词时作为参考池注入，AI 会按相关性挑选；前端编辑器也可一键合并。
 *  注意：这是「可参考词」而非「必选词」，与产品强相关才用。
 */
export const SEED_KEYWORDS: readonly string[] = [
  // 用户词库核心（unique / custom / best / high quality / luxury / most popular ...）
  'Unique', 'Custom', 'Best', 'High Quality', 'Luxury', 'Most Popular',
  'Cheap', 'Durable', 'In Stock', 'Portable', 'Wholesale', 'Promotional',
  'Branded', 'Printed', 'Logo', 'Gift', 'Customized', 'Bulk', 'Customizable',
  'Personalized', 'Nice', 'Blank', 'Amazon',
  // 用户词库扩展（连写词拆分：unique creative practical / custom item budget / ...）
  'Creative', 'Practical', 'Item', 'Budget', 'Universal', 'Advertising',
  'Giveaway', 'Brilliant', 'Top', 'Gifts', 'Premium', 'Natural', 'Useful',
  'Personal', 'Personalization', 'Multipurpose', 'Product', 'Products',
  'Good', 'New', 'Promotions', 'Ultra', 'Modern', 'Simple',
  // 商务 / 场景
  'Corporate', 'Trade Show', 'Employee', 'Campaign', 'Welcome Kit', 'Office',
  // 库存 / 物流
  'Free Shipping', 'Fast Shipping',
  // ASI 平台高频
  'Amazon Prime',
]

/** 已知品牌词黑名单（出现即在 Description/Title/Keywords 中剔除，避免被当成违规主体） */
export const BRAND_BLOCKLIST = [
  'disney',
  'marvel',
  'nba',
  'nfl',
  'mlb',
  'sanrio',
  'hellokitty',
  'mickey',
  'pixar',
  'starwars',
  'harrypotter',
  'nike',
  'apple',
  'coca',
  'pepsi',
  'lego',
  'barbie',
  'tesla',
  'gucci',
  'louisvuitton',
  'lv',
]

/** Title Case：单词首字母大写，其余小写（保留全部数字与品牌专有名词常见处理） */
export function toTitleCase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part
      // 全部数字 + 缩写保持原样
      if (/^[\d./&+-]+$/.test(part)) return part
      // 全大写且 ≤4 字符认为是缩写
      if (part.length <= 4 && part === part.toUpperCase()) return part
      const lower = part.toLowerCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}