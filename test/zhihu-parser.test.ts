import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => ({
  h: (await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')).h,
}))

import { buildZhihuMessages, createZhihuZse96, extractZhihuLinks, fetchZhihuPost } from '../src/parsers/zhihu'

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

describe('extractZhihuLinks', () => {
  it('extracts question, answer, and article links', () => {
    expect(extractZhihuLinks('https://www.zhihu.com/question/67423622 https://www.zhihu.com/question/67423622/answer/123456789 https://zhuanlan.zhihu.com/p/123456')).toEqual([
      'https://www.zhihu.com/question/67423622',
      'https://www.zhihu.com/question/67423622/answer/123456789',
      'https://zhuanlan.zhihu.com/p/123456',
    ])
  })

  it('extracts links from escaped card payloads', () => {
    const card = '<json data="{&quot;url&quot;:&quot;https:\\/\\/www.zhihu.com\\/question\\/67423622\\/answer\\/123456789&quot;}"/>'
    expect(extractZhihuLinks(card)).toEqual([
      'https://www.zhihu.com/question/67423622/answer/123456789',
    ])
  })
})

describe('createZhihuZse96', () => {
  it('matches the reference signer vector', () => {
    expect(createZhihuZse96('https://www.zhihu.com/api/v4/questions/67423622')).toBe(
      '2.0_bw8rs/Qvnxh3cHhoYw8Q9zT3dxVk2HASUMPIxxuR2Webcc8W=Pn6iebqbq5Y1sI/',
    )
  })
})

describe('buildZhihuMessages', () => {
  it('builds text and image messages', () => {
    const messages = buildZhihuMessages({
      id: '1',
      url: 'https://www.zhihu.com/question/1',
      title: '问题',
      desc: '回答',
      type: 'answer',
      authorName: '作者',
      likedCount: 1,
      commentCount: 2,
      collectCount: 3,
      viewCount: 4,
      imageUrls: ['https://example.com/1.jpg'],
      videoUrls: [],
    }, config)

    expect(messages).toHaveLength(2)
    expect(messages[0].toString()).toContain('知乎回答：问题')
    expect(messages[0].toString()).toContain('作者：作者\n\n回答\n\n赞同/喜欢：1')
    expect(messages[1].toString()).toContain('img')
  })
})

describe('fetchZhihuPost', () => {
  it('maps answer API responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '123456789',
        content: '<p>回答正文</p><img src="https://example.com/1.jpg">',
        question: { id: '67423622', title: '问题' },
        author: { name: '作者', url_token: 'author' },
        reaction: { statistics: { like_count: 1, comment_count: 2, favorites: 3 } },
        visited_count: 4,
      }),
    } as Response)

    const post = await fetchZhihuPost('https://www.zhihu.com/question/67423622/answer/123456789', config)
    expect(post.type).toBe('answer')
    expect(post.desc).toContain('回答正文')
    expect(post.imageUrls).toEqual(['https://example.com/1.jpg'])
    expect(fetchMock.mock.calls[0]?.[0]?.toString()).toContain('/api/v4/answers/123456789')

    fetchMock.mockRestore()
  })
})
