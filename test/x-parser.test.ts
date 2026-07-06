import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => ({
  h: (await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')).h,
}))

import { buildXMessages, buildXPost, extractXLinks, fetchXPost } from '../src/parsers/x'

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

describe('extractXLinks', () => {
  it('extracts x.com and twitter.com links', () => {
    expect(extractXLinks('https://x.com/openai/status/1800000000000000000 https://twitter.com/openai/status/1800000000000000001')).toEqual([
      'https://x.com/openai/status/1800000000000000000',
      'https://twitter.com/openai/status/1800000000000000001',
    ])
  })

  it('extracts links from escaped card payloads', () => {
    const card = '<json data="{&quot;url&quot;:&quot;https:\\/\\/x.com\\/openai\\/status\\/1800000000000000000&quot;}"/>'
    expect(extractXLinks(card)).toEqual([
      'https://x.com/openai/status/1800000000000000000',
    ])
  })
})

describe('buildXPost and buildXMessages', () => {
  it('separates tweet text sections with blank lines', () => {
    const messages = buildXMessages({
      id: '1',
      url: 'https://x.com/openai/status/1',
      title: '标题',
      desc: '正文',
      authorName: 'OpenAI',
      authorId: 'openai',
      likedCount: 1,
      repostCount: 2,
      commentCount: 3,
      quoteCount: 4,
      imageUrls: [],
      videoUrls: [],
    }, config)

    expect(messages[0].toString()).toContain('作者：OpenAI (@openai)\n\n正文\n\n点赞：1')
  })

  it('maps tweet result media and stats', () => {
    const post = buildXPost({
      result: {
        core: { user_results: { result: { core: { name: 'OpenAI', screen_name: 'openai' } } } },
        views: { count: '42' },
        rest_id: '1800000000000000000',
        legacy: {
          full_text: 'hello https://t.co/x',
          display_text_range: [0, 5],
          favorite_count: 1,
          retweet_count: 2,
          quote_count: 3,
          reply_count: 4,
          bookmark_count: 5,
          extended_entities: {
            media: [
              { type: 'photo', media_url_https: 'https://example.com/1.jpg' },
              { type: 'video', media_url_https: 'https://example.com/c.jpg', video_info: { variants: [
                { content_type: 'video/mp4', bitrate: 1, url: 'https://example.com/low.mp4' },
                { content_type: 'video/mp4', bitrate: 2, url: 'https://example.com/high.mp4' },
              ] } },
            ],
          },
        },
      },
    })

    expect(post.desc).toBe('hello')
    expect(post.imageUrls).toEqual(['https://example.com/1.jpg:orig'])
    expect(post.videoUrls).toEqual(['https://example.com/high.mp4'])

    const messages = buildXMessages(post, config)
    expect(messages).toHaveLength(3)
    expect(messages[0].toString()).toContain('X：hello')
  })
})

describe('fetchXPost', () => {
  it('maps easycomment tweet responses', async () => {
    const tweetResults = {
      result: {
        core: { user_results: { result: { core: { name: 'OpenAI', screen_name: 'openai' } } } },
        views: { count: '42' },
        rest_id: '1800000000000000000',
        legacy: {
          full_text: 'hello',
          display_text_range: [0, 5],
          favorite_count: 1,
          retweet_count: 2,
          quote_count: 3,
          reply_count: 4,
          bookmark_count: 5,
        },
      },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        code: 100000,
        data: {
          data: {
            threaded_conversation_with_injections_v2: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: [{
                  content: {
                    __typename: 'TimelineTimelineItem',
                    itemContent: {
                      __typename: 'TimelineTweet',
                      tweet_results: tweetResults,
                    },
                  },
                }],
              }],
            },
          },
        },
      }),
    } as Response)

    const post = await fetchXPost('https://x.com/openai/status/1800000000000000000', config)
    expect(post.authorId).toBe('openai')
    expect(post.desc).toBe('hello')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://easycomment.ai/api/twitter/v1/free/get-tweet-detail')

    fetchMock.mockRestore()
  })

  it('falls back to syndication tweet responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'forbidden',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_str: '1800000000000000000',
          text: 'hello https://t.co/x',
          favorite_count: 1,
          conversation_count: 2,
          entities: {
            urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com' }],
          },
          user: { name: 'OpenAI', screen_name: 'openai' },
          mediaDetails: [{ type: 'photo', media_url_https: 'https://example.com/1.jpg' }],
        }),
      } as Response)

    const post = await fetchXPost('https://x.com/openai/status/1800000000000000000', config)
    expect(post.desc).toBe('hello https://example.com')
    expect(post.authorId).toBe('openai')
    expect(post.imageUrls).toEqual(['https://example.com/1.jpg:orig'])
    expect(fetchMock.mock.calls[1]?.[0]?.toString()).toContain('cdn.syndication.twimg.com/tweet-result')

    fetchMock.mockRestore()
  })
})
