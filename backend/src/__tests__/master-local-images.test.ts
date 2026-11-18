/**
 * 表格「图片」列里的本地路径提取。
 *
 * 背景：用户在 Excel 图片列填的是自己电脑上的路径（C:\Users\...\风扇1.jpg）。
 * 服务器读不到客户端磁盘，所以导入时只能把路径存下来，
 * 之后由「导入图片文件夹」按文件名配对回填。这里只测「挑哪些、丢哪些」。
 */

import { extractLocalImagePaths } from '../modules/master-products'

describe('extractLocalImagePaths', () => {
  it('保留 Windows 本机路径（含反斜杠与中文目录）', () => {
    const raw = 'C:\\Users\\Administrator\\Desktop\\产品图\\风扇1.jpg'
    expect(extractLocalImagePaths(raw)).toEqual([raw])
  })

  it('保留 file:// 协议地址', () => {
    const raw = 'file:///C:/Users/x/a.jpg'
    expect(extractLocalImagePaths(raw)).toEqual([raw])
  })

  it('丢掉公网 http(s) 地址（这类本来就能直接用）', () => {
    const raw = ['https://cbu01.alicdn.com/img/a.jpg', 'http://img.example.com/b.png'].join('\n')
    expect(extractLocalImagePaths(raw)).toEqual([])
  })

  it('丢掉 WPS 嵌入单元格图片（由 DISPIMG 另一条通道处理）', () => {
    expect(extractLocalImagePaths('=DISPIMG("ID_83A620734F2044BB849902D3D5809847",1)')).toEqual([])
  })

  it('混写时只留本地路径，并去掉包裹的引号', () => {
    const raw = [
      'https://x.com/a.jpg',
      '"C:\\图\\b.jpg"',
      'C:\\图\\c.jpg',
      '=DISPIMG("ID_x",1)',
    ].join('\r\n')
    expect(extractLocalImagePaths(raw)).toEqual(['C:\\图\\b.jpg', 'C:\\图\\c.jpg'])
  })

  it('同一格用逗号/分号分隔多张也认', () => {
    expect(extractLocalImagePaths('D:\\a.jpg，E:\\b.jpg；F:\\c.jpg')).toEqual([
      'D:\\a.jpg',
      'E:\\b.jpg',
      'F:\\c.jpg',
    ])
  })

  it('空值返回空数组', () => {
    expect(extractLocalImagePaths('')).toEqual([])
    expect(extractLocalImagePaths('   \n  ')).toEqual([])
  })

  it('最多保留 60 条，避免把整列塞进库', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `C:\\图\\p${i}.jpg`).join('\n')
    expect(extractLocalImagePaths(raw)).toHaveLength(60)
  })
})
