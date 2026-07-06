import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => ({
  h: (await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')).h,
}))

import { buildWeiboMessages, extractWeiboLinks, fetchWeiboPost } from '../src/parsers/weibo'

const config = {
  userAgent: 'test',
  timeout: 1,
  showVideo: true,
  showImages: true,
  maxImages: 9,
  maxDescLength: 160,
  descTruncateSuffix: '...(已截断)',
  showLink: true,
  showAuthor: true,
  showStats: true,
}

describe('extractWeiboLinks', () => {
  it('extracts direct status links', () => {
    expect(extractWeiboLinks('看看 https://weibo.com/7207262816/P5kWdcfDe 不错')).toEqual([
      'https://weibo.com/7207262816/P5kWdcfDe',
    ])
  })

  it('extracts mobile status links', () => {
    expect(extractWeiboLinks('https://m.weibo.cn/status/5234367615996775')).toEqual([
      'https://m.weibo.cn/status/5234367615996775',
    ])
  })

  it('extracts links from escaped card payloads', () => {
    const card = '<json data="{&quot;url&quot;:&quot;https:\\/\\/weibo.com\\/7207262816\\/P5kWdcfDe&quot;}"/>'
    expect(extractWeiboLinks(card)).toEqual([
      'https://weibo.com/7207262816/P5kWdcfDe',
    ])
  })
})

describe('buildWeiboMessages', () => {
  it('builds text and media messages', () => {
    const messages = buildWeiboMessages({
      id: '1',
      url: 'https://weibo.com/1/1',
      title: '正文',
      desc: '正文',
      authorName: '作者',
      likedCount: 1,
      repostCount: 2,
      commentCount: 3,
      imageUrls: ['https://example.com/1.jpg'],
      videoUrls: ['https://example.com/1.mp4'],
    }, config)

    expect(messages).toHaveLength(3)
    expect(messages[0].toString()).toContain('微博：正文')
    expect(messages[1].toString()).toContain('img')
    expect(messages[2].toString()).toContain('video')
  })
})

describe('fetchWeiboPost', () => {
  it('maps status API responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        idstr: 'P5kWdcfDe',
        text_raw: '微博正文 http://t.cn/abc',
        user: { idstr: '7207262816', screen_name: '作者' },
        attitudes_count: 1,
        reposts_count: 2,
        comments_count: 3,
        pic_infos: {
          a: { original: { url: 'https://example.com/1.jpg' } },
        },
        page_info: {
          media_info: { stream_url_hd: 'https://example.com/1.mp4' },
        },
      }),
    } as Response)

    const post = await fetchWeiboPost('https://weibo.com/7207262816/P5kWdcfDe', config)
    expect(post.authorName).toBe('作者')
    expect(post.imageUrls).toEqual(['https://example.com/1.jpg'])
    expect(post.videoUrls).toEqual(['https://example.com/1.mp4'])
    expect(fetchMock.mock.calls[0]?.[0]?.toString()).toContain('/ajax/statuses/show')

    fetchMock.mockRestore()
  })
})
