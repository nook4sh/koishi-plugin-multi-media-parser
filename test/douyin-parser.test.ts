import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => ({
  h: (await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')).h,
}))

import { buildDouyinMessages, extractDouyinLinks, extractRouterDataPost } from '../src/parsers/douyin'

const config = {
  userAgent: 'test',
  timeout: 1,
  showVideo: true,
  showImages: true,
  maxImages: 9,
  maxDescLength: 160,
  descTruncateSuffix: '...(已截断)',
  showAuthor: true,
  showLink: true,
}

describe('extractDouyinLinks', () => {
  it('extracts plain short links', () => {
    expect(extractDouyinLinks('看看 https://v.douyin.com/_2ljF4AmKL8/ ，不错')).toEqual([
      'https://v.douyin.com/_2ljF4AmKL8/',
    ])
  })

  it('extracts direct video and note links', () => {
    expect(extractDouyinLinks('https://www.douyin.com/video/7521023890996514083 https://www.douyin.com/note/7469411074119322899')).toEqual([
      'https://www.douyin.com/video/7521023890996514083',
      'https://www.douyin.com/note/7469411074119322899',
    ])
  })

  it('extracts direct links without www', () => {
    expect(extractDouyinLinks('https://douyin.com/video/7521023890996514083')).toEqual([
      'https://douyin.com/video/7521023890996514083',
    ])
  })

  it('extracts links from escaped card payloads', () => {
    const card = '<json data="{&quot;meta&quot;:{&quot;detail_1&quot;:{&quot;qqdocurl&quot;:&quot;https:\\/\\/v.douyin.com\\/_2ljF4AmKL8\\/&quot;}}}"/>'
    expect(extractDouyinLinks(card)).toEqual([
      'https://v.douyin.com/_2ljF4AmKL8/',
    ])
  })

  it('deduplicates links', () => {
    const link = 'https://www.douyin.com/video/7521023890996514083'
    expect(extractDouyinLinks(`${link}\n${link}`)).toEqual([link])
  })
})

describe('extractRouterDataPost', () => {
  it('extracts video data from router data', () => {
    const html = `<script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"aweme_id":"1","desc":"hello","create_time":1,"author":{"nickname":"alice","avatar_thumb":{"url_list":["https://example.com/a.jpg"]}},"video":{"play_addr":{"url_list":["https://example.com/playwm.mp4"]},"cover":{"url_list":["https://example.com/c.jpg"]},"duration":1000}}]}}}}</script>`
    const post = extractRouterDataPost(html, { id: '1', type: 'video', url: 'https://www.douyin.com/video/1' })
    expect(post?.title).toBe('hello')
    expect(post?.authorName).toBe('alice')
    expect(post?.videoUrls).toEqual(['https://example.com/play.mp4'])
  })

  it('extracts note images from router data', () => {
    const html = `<script>window._ROUTER_DATA = {"loaderData":{"note_(id)/page":{"videoInfoRes":{"item_list":[{"aweme_id":"2","desc":"note","author":{"nickname":"bob"},"images":[{"url_list":["https://example.com/1.jpg"]},{"video":{"play_addr":{"url_list":["https://example.com/gif.mp4"]}}}] }]}}}}</script>`
    const post = extractRouterDataPost(html, { id: '2', type: 'note', url: 'https://www.douyin.com/note/2' })
    expect(post?.imageUrls).toEqual(['https://example.com/1.jpg'])
    expect(post?.dynamicImageUrls).toEqual(['https://example.com/gif.mp4'])
    expect(post?.videoUrls).toEqual([])
  })
})

describe('buildDouyinMessages', () => {
  it('builds text and media messages', () => {
    const messages = buildDouyinMessages({
      id: '1',
      url: 'https://www.douyin.com/video/1',
      title: '标题',
      desc: '描述',
      type: 'video',
      authorName: '作者',
      imageUrls: ['https://example.com/1.jpg'],
      dynamicImageUrls: [],
      videoUrls: ['https://example.com/1.mp4'],
    }, config)

    expect(messages).toHaveLength(3)
    expect(messages[0].toString()).toContain('抖音：标题')
    expect(messages[1].toString()).toContain('img')
    expect(messages[2].toString()).toContain('video')
  })

  it('uses configured max description length', () => {
    const messages = buildDouyinMessages({
      id: '1',
      url: 'https://www.douyin.com/video/1',
      title: '标题',
      desc: '1234567890',
      type: 'video',
      authorName: '作者',
      imageUrls: [],
      dynamicImageUrls: [],
      videoUrls: [],
    }, {
      ...config,
      maxDescLength: 5,
      showLink: false,
    })

    expect(messages[0].toString()).toContain('12345...(已截断)')
    expect(messages[0].toString()).not.toContain('1234567890')
  })

  it('sends dynamic image videos as video elements', () => {
    const messages = buildDouyinMessages({
      id: '1',
      url: 'https://www.douyin.com/note/1',
      title: '动态图集',
      desc: '动态图集',
      type: 'slides',
      authorName: '作者',
      imageUrls: [],
      dynamicImageUrls: ['https://example.com/dynamic.mp4'],
      videoUrls: [],
    }, config)

    expect(messages).toHaveLength(2)
    expect(messages[1].toString()).toContain('video')
  })

  it('sends downloaded video buffers before remaining video links', () => {
    const messages = buildDouyinMessages({
      id: '1',
      url: 'https://www.douyin.com/video/1',
      title: '视频',
      desc: '视频',
      type: 'video',
      authorName: '作者',
      imageUrls: [],
      dynamicImageUrls: [],
      videoUrls: ['https://example.com/fallback.mp4'],
      videoBuffer: Buffer.from('video-data'),
      videoMimeType: 'video/mp4',
    }, config)

    expect(messages).toHaveLength(3)
    expect(messages[1].toString()).toContain('video')
    expect(messages[2].toString()).toContain('https://example.com/fallback.mp4')
  })

  it('adds a message when video is skipped', () => {
    const messages = buildDouyinMessages({
      id: '1',
      url: 'https://www.douyin.com/video/1',
      title: '视频',
      desc: '视频',
      type: 'video',
      authorName: '作者',
      imageUrls: [],
      dynamicImageUrls: [],
      videoUrls: [],
      videoSkippedMessage: '[视频文件过大，跳过解析]',
    }, config)

    expect(messages).toHaveLength(2)
    expect(messages[1].toString()).toContain('[视频文件过大，跳过解析]')
  })
})
