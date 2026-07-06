import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => ({
  h: (await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')).h,
}))

import { buildXhsMessages, extractInitialStateNote, extractXhsLinks } from '../src/parsers/xhs'

describe('extractXhsLinks', () => {
  it('extracts plain short links', () => {
    expect(extractXhsLinks('看看 http://xhslink.com/m/AixEkyLwpfs ，不错')).toEqual([
      'http://xhslink.com/m/AixEkyLwpfs',
    ])
  })

  it('extracts links from escaped card payloads', () => {
    const card = '<json data="{&quot;meta&quot;:{&quot;detail_1&quot;:{&quot;qqdocurl&quot;:&quot;http:\\/\\/xhslink.com\\/m\\/AixEkyLwpfs&quot;}}}"/>'
    expect(extractXhsLinks(card)).toEqual([
      'http://xhslink.com/m/AixEkyLwpfs',
    ])
  })

  it('deduplicates direct links', () => {
    const link = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=token'
    expect(extractXhsLinks(`${link}\n${link}`)).toEqual([link])
  })
})

describe('extractInitialStateNote', () => {
  it('extracts noteData from initial state', () => {
    const html = '<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"noteId":"n1","title":"hello","type":"normal","imageList":[]}}}}</script>'
    expect(extractInitialStateNote(html)?.noteId).toBe('n1')
  })

  it('extracts note detail map from initial state', () => {
    const html = '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"n2":{"note":{"noteId":"n2","title":"world","type":"normal","imageList":[]}}}}}</script>'
    expect(extractInitialStateNote(html)?.noteId).toBe('n2')
  })
})

describe('buildXhsMessages', () => {
  it('builds text and media messages', () => {
    const messages = buildXhsMessages({
      id: 'n1',
      url: 'https://www.xiaohongshu.com/explore/n1',
      title: '标题',
      desc: '描述',
      type: 'normal',
      authorName: '作者',
      authorId: 'u1',
      likedCount: 1,
      collectedCount: 2,
      commentCount: 3,
      shareCount: 4,
      imageUrls: ['https://example.com/1.jpg'],
      videoUrls: [],
    }, {
      userAgent: 'test',
      timeout: 1,
      imageFormat: 'jpeg',
      showVideo: true,
      showImages: true,
      maxImages: 9,
      maxDescLength: 160,
      descTruncateSuffix: '...(已截断)',
      showStats: true,
      showLink: true,
    })

    expect(messages).toHaveLength(2)
    expect(messages[0].toString()).toContain('小红书：标题')
    expect(messages[0].toString()).toContain('作者：作者\n\n描述\n\n点赞：1')
    expect(messages[1].toString()).toContain('img')
  })

  it('uses configured max description length', () => {
    const messages = buildXhsMessages({
      id: 'n1',
      url: 'https://www.xiaohongshu.com/explore/n1',
      title: '标题',
      desc: '1234567890',
      type: 'normal',
      authorName: '作者',
      authorId: 'u1',
      imageUrls: [],
      videoUrls: [],
    }, {
      userAgent: 'test',
      timeout: 1,
      imageFormat: 'jpeg',
      showVideo: true,
      showImages: true,
      maxImages: 9,
      maxDescLength: 5,
      descTruncateSuffix: '...(已截断)',
      showStats: false,
      showLink: false,
    })

    expect(messages[0].toString()).toContain('12345...(已截断)')
    expect(messages[0].toString()).not.toContain('1234567890')
  })

  it('does not add truncate suffix when description is within limit', () => {
    const messages = buildXhsMessages({
      id: 'n1',
      url: 'https://www.xiaohongshu.com/explore/n1',
      title: '标题',
      desc: '12345',
      type: 'normal',
      authorName: '作者',
      authorId: 'u1',
      imageUrls: [],
      videoUrls: [],
    }, {
      userAgent: 'test',
      timeout: 1,
      imageFormat: 'jpeg',
      showVideo: true,
      showImages: true,
      maxImages: 9,
      maxDescLength: 5,
      descTruncateSuffix: '...(已截断)',
      showStats: false,
      showLink: false,
    })

    expect(messages[0].toString()).toContain('12345')
    expect(messages[0].toString()).not.toContain('已截断')
  })

  it('sends downloaded video buffers before remaining video links', () => {
    const messages = buildXhsMessages({
      id: 'n1',
      url: 'https://www.xiaohongshu.com/explore/n1',
      title: '视频',
      desc: '视频',
      type: 'video',
      authorName: '作者',
      authorId: 'u1',
      imageUrls: [],
      videoUrls: ['https://example.com/fallback.mp4'],
      videoBuffer: Buffer.from('video-data'),
      videoMimeType: 'video/mp4',
    }, {
      userAgent: 'test',
      timeout: 1,
      imageFormat: 'jpeg',
      showVideo: true,
      showImages: true,
      maxImages: 9,
      maxDescLength: 160,
      descTruncateSuffix: '...(已截断)',
      showStats: false,
      showLink: false,
    })

    expect(messages).toHaveLength(3)
    expect(messages[1].toString()).toContain('video')
    expect(messages[2].toString()).toContain('https://example.com/fallback.mp4')
  })

  it('adds a message when video is skipped', () => {
    const messages = buildXhsMessages({
      id: 'n1',
      url: 'https://www.xiaohongshu.com/explore/n1',
      title: '视频',
      desc: '视频',
      type: 'video',
      authorName: '作者',
      authorId: 'u1',
      imageUrls: [],
      videoUrls: [],
      videoSkippedMessage: '[视频文件过大，跳过解析]',
    }, {
      userAgent: 'test',
      timeout: 1,
      imageFormat: 'jpeg',
      showVideo: true,
      showImages: true,
      maxImages: 9,
      maxDescLength: 160,
      descTruncateSuffix: '...(已截断)',
      showStats: false,
      showLink: false,
    })

    expect(messages).toHaveLength(2)
    expect(messages[1].toString()).toContain('[视频文件过大，跳过解析]')
  })
})
