/**
 * GLS 类目中文翻译辅助（关键词映射式，非逐条人工翻译）。
 * 1620 个英文类目无法逐条维护，这里按高频词根匹配给出中文释义，
 * 供下拉框展示「英文（中文）」使用；未命中的类目只显示英文原文。
 */

/** 词根 → 中文（按数组顺序匹配，先命中先得；一条类目最多拼接 2 个释义） */
const CATEGORY_ZH_RULES: Array<[RegExp, string]> = [
  // ── 服饰 / 穿戴 ──
  [/apron/i, '围裙'],
  [/t-?shirt|tee/i, 'T恤'],
  [/polo/i, 'Polo衫'],
  [/shirt/i, '衬衫'],
  [/sweatshirt|hoodie|fleece/i, '卫衣/抓绒'],
  [/jacket|coat|windbreaker/i, '外套'],
  [/vest/i, '背心'],
  [/uniform/i, '制服'],
  [/robe|bathrobe/i, '浴袍'],
  [/pajama|sleepwear/i, '睡衣'],
  [/sock/i, '袜子'],
  [/glove/i, '手套'],
  [/scarf|bandana|neckwear|tie(?!r)/i, '围巾/领饰'],
  [/hat|cap(?!tured)|beanie|visor|headwear|bucket/i, '帽子'],
  [/headband|earband/i, '头带'],
  [/band/i, '腕带'],
  [/mask(?!ing)/i, '口罩'],
  [/eyewear|sunglass|glass(?!es)|safety glass/i, '眼镜/护目'],
  [/earplug|earbud|headphone/i, '耳塞/耳机'],
  [/shoe|slipper|sandal|boot|insole/i, '鞋靴'],
  [/umbrella|poncho|rain/i, '雨具'],
  [/apron/i, '围裙'],

  // ── 袋 / 箱包 ──
  [/tote/i, '托特袋'],
  [/backpack/i, '双肩包'],
  [/duffel|duffle/i, '旅行袋'],
  [/drawstring/i, '束口袋'],
  [/lunch(?!box)|cooler(?!s)/i, '保温袋'],
  [/grocery|shopping/i, '购物袋'],
  [/laptop|computer bag|sleeve/i, '电脑包'],
  [/briefcase|attache|portfolio/i, '公文包'],
  [/wallet|billfold/i, '钱包'],
  [/card holder|cardholder/i, '卡包'],
  [/pouch/i, '小袋'],
  [/backpack|bag|sack|tote|totebag/i, '包袋'],
  [/luggage|suitcase|trolley/i, '行李箱'],
  [/cosmetic|toiletry|makeup/i, '化妆包'],

  // ── 文具 / 办公 ──
  [/pen(?!cil)|ballpoint|rollerball|gel pen/i, '笔'],
  [/pencil/i, '铅笔'],
  [/marker|highlighter/i, '记号笔'],
  [/crayon/i, '蜡笔'],
  [/notebook|notepad|journal|memo|pad(?!dle)/i, '笔记本'],
  [/planner|calendar|agenda|diary/i, '计划本'],
  [/sticker|decals?/i, '贴纸'],
  [/ruler/i, '尺子'],
  [/eraser/i, '橡皮'],
  [/sharpener/i, '卷笔刀'],
  [/scissors/i, '剪刀'],
  [/stapler/i, '订书机'],
  [/clipboard/i, '板夹'],
  [/folder|binder|document/i, '文件夹'],
  [/envelope/i, '信封'],
  [/calculator/i, '计算器'],
  [/magnet/i, '磁贴'],
  [/bookmark/i, '书签'],
  [/stamp/i, '印章'],
  [/lanyard/i, '挂绳'],
  [/badge|id holder|name badge/i, '胸卡'],
  [/key ?tag|key ?chain|key ?ring|key ?fob|key ?holder/i, '钥匙扣'],
  [/tape(?!ry)/i, '胶带'],
  [/whiteboard|dry erase|write on/i, '白板'],
  [/desk|organizer/i, '桌面收纳'],
  [/book ?mark/i, '书签'],
  [/address book/i, '通讯录'],
  [/album/i, '相册'],

  // ── 杯具 / 餐厨 ──
  [/mug/i, '马克杯'],
  [/tumbler|insulated|vacuum|thermos/i, '保温杯'],
  [/bottle|flask|canteen|hydration/i, '水瓶'],
  [/cup(?!board)/i, '杯子'],
  [/coaster/i, '杯垫'],
  [/straw/i, '吸管'],
  [/cutlery|flatware|spork|utensil/i, '餐具'],
  [/chopstick/i, '筷子'],
  [/plate(?!s$)/i, '餐盘'],
  [/bowl/i, '碗'],
  [/lunch box|food container|bento/i, '饭盒'],
  [/apron/i, '围裙'],
  [/kitchen|barbecue|grill|bbq/i, '厨房/烧烤'],
  [/cutting board|chopping/i, '砧板'],
  [/opener|corkscrew/i, '开瓶器'],
  [/coffee|espresso|french press/i, '咖啡'],
  [/tea ?(pot|kettle|ball|infuser)/i, '茶具'],
  [/wine(?! glass)/i, '红酒'],
  [/ice ?cube|ice tray/i, '冰格'],
  [/apron/i, '围裙'],

  // ── 电子 / 科技 ──
  [/cable|cord|charger|charging/i, '充电/数据线'],
  [/power ?bank|charger/i, '充电宝'],
  [/wireless charg/i, '无线充'],
  [/adapter|plug/i, '转接头'],
  [/usb|flash drive|memory/i, 'U盘/存储'],
  [/speaker/i, '音箱'],
  [/mouse/i, '鼠标'],
  [/keyboard/i, '键盘'],
  [/hub|docking/i, '扩展坞'],
  [/webcam|camera/i, '摄像头'],
  [/screen|monitor|display/i, '屏幕'],
  [/phone stand|tablet stand|holder/i, '支架'],
  [/stylus|pen tablet/i, '触控笔'],
  [/smart ?watch|fitness track/i, '智能穿戴'],
  [/earbuds|headset/i, '耳机'],
  [/fan(?!cy)/i, '风扇'],
  [/light|lamp|lantern|flashlight|torch/i, '灯具/照明'],
  [/battery/i, '电池'],
  [/cable|tech|electronic|gadget/i, '数码配件'],

  // ── 户外 / 运动 / 旅行 ──
  [/ball(?!oon)/i, '球类'],
  [/golf/i, '高尔夫'],
  [/yoga|mat(?!tress)/i, '瑜伽垫'],
  [/fitness|exercise|gym|sport/i, '健身运动'],
  [/bicycle|bike|cycling/i, '骑行'],
  [/swim|beach(?!ball)/i, '游泳/沙滩'],
  [/camping|tent|outdoor|hiking/i, '露营户外'],
  [/fishing/i, '钓鱼'],
  [/coolers?/i, '保温箱'],
  [/blanket|throw/i, '毯子'],
  [/towel/i, '毛巾'],
  [/mat(?!tress)/i, '垫子'],
  [/cushion|pillow/i, '靠垫'],
  [/travel|luggage tag|passport/i, '旅行'],
  [/poncho|rain/i, '雨衣'],
  [/sun ?shade|canopy|parasol/i, '遮阳'],
  [/koozie|can holder|bottle holder/i, '杯套'],

  // ── 家居 / 生活 ──
  [/candle/i, '蜡烛'],
  [/diffuser|aroma|essential/i, '香薰'],
  [/vase/i, '花瓶'],
  [/mirror/i, '镜子'],
  [/clock(?!work)/i, '时钟'],
  [/watch(?!band)/i, '手表'],
  [/umbrella/i, '雨伞'],
  [/basket|bin(?!oculars)/i, '收纳篮'],
  [/hanger/i, '衣架'],
  [/laundry/i, '洗衣'],
  [/clean(?!er$)|brush|squeegee/i, '清洁'],
  [/doormat|floor mat/i, '门垫'],
  [/magnet/i, '磁铁'],
  [/picture frame|photo frame/i, '相框'],
  [/ornament/i, '装饰挂件'],
  [/pet|dog|cat(?!alog)/i, '宠物'],
  [/tool(?!box)/i, '工具'],
  [/flashlight|torch/i, '手电'],
  [/measuring tape|tape measure/i, '卷尺'],
  [/level(?!s$)/i, '水平尺'],
  [/screwdriver/i, '螺丝刀'],
  [/hammer/i, '锤子'],
  [/first ?aid|emergency|survival/i, '急救/应急'],
  [/smoke|carbon|detector|alarm/i, '报警器'],
  [/lock(?!smith)/i, '锁具'],
  [/umbrella stand/i, '伞架'],

  // ── 美容 / 健康 / 医疗 ──
  [/cosmetic|beauty|nail|lip ?stick|mirror/i, '美妆'],
  [/comb|hair ?brush|mirror/i, '梳妆'],
  [/shaver|razor|trimmer/i, '剃须'],
  [/tooth|dental|floss/i, '口腔'],
  [/soap|lotion|sanitizer|tissue|wipe/i, '洗护'],
  [/pill|medicine|tablet box/i, '药盒'],
  [/thermometer|bp monitor|stethoscope/i, '体温/血压'],
  [/massage|spa(?!ce)/i, '按摩'],
  [/hot ?cold pack|ice pack/i, '冷热敷'],
  [/bandage|gauze/i, '包扎'],
  [/pillow|neck support/i, '颈枕'],

  // ── 玩具 / 礼品 / 嗜好 ──
  [/toy|doll|plush|figurine/i, '玩具'],
  [/puzzle/i, '拼图'],
  [/game(?!s$)|dice|poker|chess|card deck|playing card/i, '游戏'],
  [/yo-?yo/i, '悠悠球'],
  [/kite/i, '风筝'],
  [/balloon/i, '气球'],
  [/bubble/i, '泡泡'],
  [/model|die ?cast/i, '模型'],
  [/musical|instrument/i, '乐器'],
  [/puzzle|brain teaser/i, '益智'],
  [/party|birthday|celebration/i, '派对'],
  [/holiday|christmas|halloween|easter/i, '节日'],
  [/gift ?(box|bag|wrap|card)/i, '礼品包装'],
  [/award|trophy|medal|certificate|plaque/i, '奖杯/表彰'],
  [/ribbon|bow/i, '丝带'],
  [/confetti|streamer/i, '彩带'],

  // ── 汽车 / 交通 ──
  [/auto|car|vehicle|truck/i, '汽车'],
  [/tire|wheel(?!chair)/i, '车轮'],
  [/license plate/i, '车牌'],
  [/parking/i, '停车'],
  [/roadside|jumper|cable/i, '车载应急'],

  // ── 商务 / 促销 ──
  [/banner|flag(?!ship)|sign(?!ature)|banner/i, '旗帜/标识'],
  [/display|booth|banner stand/i, '展示'],
  [/brochure|flyer|catalog/i, '宣传册'],
  [/business card/i, '名片'],
  [/certificate/i, '证书'],
  [/menu(?!al)/i, '菜单'],
  [/ticket|coupon|voucher/i, '票券'],
  [/coin(?!s$)|challenge coin/i, '纪念币'],
  [/bank|money|coin purse/i, '钱币'],
  [/piggy bank|coin bank/i, '存钱罐'],
  [/clip(?!board|per)/i, '夹子'],
  [/rubber band/i, '橡皮筋'],
  [/twist tie/i, '扎带'],
  [/litter bag|waste|trash/i, '垃圾袋'],
  [/pet waste/i, '宠物袋'],
  [/shopping cart|trolley/i, '购物车'],
  [/apron/i, '围裙'],
]

/** 单数/复数与常见后缀归一化，用于提高词根命中率 */
function normalizeCategory(cat: string): string {
  return cat
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 给 GLS 英文类目生成中文释义（最多拼接 2 个，用「/」分隔）。
 * 未命中返回空字符串。
 */
export function glsCategoryZh(cat: string): string {
  if (!cat) return ''
  const norm = normalizeCategory(cat)
  const hits: string[] = []
  for (const [re, zh] of CATEGORY_ZH_RULES) {
    if (re.test(norm) && !hits.includes(zh)) {
      hits.push(zh)
      if (hits.length >= 2) break
    }
  }
  return hits.join('/')
}

/** 下拉框选项文案：有翻译显示「英文（中文）」，否则只显示英文 */
export function glsCategoryLabel(cat: string): string {
  const zh = glsCategoryZh(cat)
  return zh ? `${cat}（${zh}）` : cat
}
