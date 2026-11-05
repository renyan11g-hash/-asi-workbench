/**
 * 提取 WPS/Excel「嵌入单元格的图片」。
 *
 * 用户表格里那一列「商品主图」显示的其实是照片，单元格值却是
 *   =DISPIMG("ID_83A620734F2044BB849902D3D5809847",1)
 * 图片二进制藏在 xlsx 内部的 xl/media/ 里，靠 xl/cellimages.xml + rels 才能对上号。
 * ExcelJS 的 getImages() 读不到这种（它不是标准 drawing），所以自己解 zip。
 *
 * 输出：ID_xxx → data:image/jpeg;base64,...（缩到 720px、质量 72，约 40~70KB）
 * 这样不依赖 1688 抓图（海外 IP 基本被反爬拦），导入即带图。
 */

import JSZip from 'jszip'
import Jimp from 'jimp'

const MAX_EDGE = 720
const QUALITY = 72

export async function extractWpsCellImages(buf: Buffer): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    return out
  }

  const cellImages = zip.file('xl/cellimages.xml')
  if (!cellImages) return out

  try {
    const xml = await cellImages.async('string')
    const relsFile = zip.file('xl/_rels/cellimages.xml.rels')
    const relsXml = relsFile ? await relsFile.async('string') : ''

    // rId → media/imageN.jpeg
    const rels = new Map<string, string>()
    for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) {
      rels.set(m[1], m[2])
    }

    // 每个 <etc:cellImage> 里有 name="ID_xxx" 和 r:embed="rIdN"
    const blocks = xml.split('<etc:cellImage>').slice(1)
    for (const block of blocks) {
      const name = block.match(/name="(ID_[^"]+)"/)?.[1]
      const rid = block.match(/r:embed="([^"]+)"/)?.[1]
      if (!name || !rid) continue
      const target = rels.get(rid)
      if (!target) continue
      const path = `xl/${target.replace(/^\.?\//, '')}`
      const file = zip.file(path)
      if (!file) continue
      const raw = await file.async('nodebuffer')

      let img: Jimp
      try {
        img = await Jimp.read(raw)
      } catch {
        continue
      }
      if (img.bitmap.width > MAX_EDGE || img.bitmap.height > MAX_EDGE) {
        img.scaleToFit(MAX_EDGE, MAX_EDGE)
      }
      img.quality(QUALITY)
      const jpg = await img.getBufferAsync(Jimp.MIME_JPEG)
      out.set(name, `data:image/jpeg;base64,${jpg.toString('base64')}`)
    }
  } catch {
    /* 结构对不上就当没有，不影响导入其它列 */
  }
  return out
}

/** 从单元格文本里取 DISPIMG 的图片 ID */
export function dispImgIds(text: string): string[] {
  return [...String(text ?? '').matchAll(/DISPIMG\(\s*"(ID_[^"]+)"\s*,\s*\d+\s*\)/gi)].map((m) => m[1])
}
