import { isManagedImage } from '../services/image-source'
import { managedImagePath } from '../services/image-inline'
import { isSendableImageUrl, normalizeImageRefs } from '../services/image-gen'

/**
 * 2026-11-09 线上事故回归：重新生成单张图时，把站内相对地址
 * `/api/product-images/{pid}/{file}` 原样发给了方舟，服务商返回 400
 * `invalid url specified`，用户只看到「图像生成失败 (400)」。
 * 站内地址必须在发请求前读成 data URL（或至少不能被当作可直传地址）。
 */

describe('站内图片地址识别', () => {
  const rel = '/api/product-images/36d3301f-761d-491e-9bd8-8c03790007/5f044494f0a8d3ee0c2.jpg'
  const abs = `https://asi-workbench.onrender.com${rel}`

  it('相对地址与带域名的绝对地址都算站内图片', () => {
    expect(isManagedImage(rel)).toBe(true)
    expect(isManagedImage(abs)).toBe(true)
  })

  it('外链与 data URL 不算站内图片', () => {
    expect(isManagedImage('https://cbu01.alicdn.com/img/x.jpg')).toBe(false)
    expect(isManagedImage('data:image/png;base64,AAA')).toBe(false)
  })

  it('绝对地址能归一成同一条站内路径（DB 里按这个 key 取图）', () => {
    expect(managedImagePath(abs)).toBe(rel)
    expect(managedImagePath(rel)).toBe(rel)
    expect(managedImagePath('https://other.example/a.jpg')).toBeNull()
  })

  // 2026-11-13 线上事故回归：资料库自建产品的图片是 /api/product-images/public/{owner}/{file}，
  // 旧正则把 public 当成 owner、把 owner 当成文件名，DB 取不到 → 原样发给方舟 → 400
  it('public 公开路径能正确归一到 image_blobs 的 key', () => {
    expect(managedImagePath('/api/product-images/public/master/1794559867021-a941e654.jpg')).toBe(
      '/api/product-images/master/1794559867021-a941e654.jpg'
    )
    expect(managedImagePath('https://asi-workbench.onrender.com/api/product-images/public/master/abc.jpg')).toBe(
      '/api/product-images/master/abc.jpg'
    )
  })

  it('站内 public 图片能读出来变成 data URL（不会再被原样发给服务商）', async () => {
    const Jimp = (await import('jimp')).default
    const { db } = await import('../db')
    const { inlineImage } = await import('../services/image-inline')
    const buf = await new Jimp(4, 4, 0xffffffff).getBufferAsync(Jimp.MIME_JPEG)
    const key = 'master/public-test.jpg'
    db.prepare('INSERT INTO image_blobs (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(key, buf)
    const out = await inlineImage(`/api/product-images/public/${key}`)
    expect(out).toBeTruthy()
    expect(out?.startsWith('data:image/')).toBe(true)
  })
})

describe('发给图像服务商前的参考图清洗', () => {
  it('只有 data URL 和 http(s) 能直传', () => {
    expect(isSendableImageUrl('data:image/jpeg;base64,AAA')).toBe(true)
    expect(isSendableImageUrl('https://cbu01.alicdn.com/img/x.jpg')).toBe(true)
    expect(isSendableImageUrl('/api/product-images/p/x.jpg')).toBe(false)
    expect(isSendableImageUrl('')).toBe(false)
  })

  it('data URL / Buffer 原样保留', async () => {
    const dataUrl = 'data:image/jpeg;base64,AAA'
    const buffer = Buffer.from([1, 2, 3])
    const out = await normalizeImageRefs([{ url: dataUrl }, { buffer }])
    expect(out).toHaveLength(2)
    expect('url' in out[0] && out[0].url).toBe(dataUrl)
    expect('buffer' in out[1]).toBe(true)
  })

  it('读不出来的站内相对地址直接丢掉，不会把相对地址发给服务商', async () => {
    const out = await normalizeImageRefs([{ url: '/api/product-images/no-such-product/none.jpg' }])
    expect(out).toHaveLength(0)
  })
})
