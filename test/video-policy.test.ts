import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', async () => {
  const { h } = await vi.importActual<typeof import('@satorijs/core')>('@satorijs/core')
  const createSchema = (): any => {
    const schema = {
      min: () => schema,
      max: () => schema,
      step: () => schema,
      default: () => schema,
      description: () => schema,
      role: () => schema,
      experimental: () => schema,
      required: () => schema,
    }
    return schema
  }
  const Schema = {
    object: () => createSchema(),
    intersect: () => createSchema(),
    array: () => createSchema(),
    union: () => createSchema(),
    const: () => createSchema(),
    string: () => createSchema(),
    number: () => createSchema(),
    boolean: () => createSchema(),
  }
  return {
    h,
    Schema,
    Logger: class {
      info() {}
      warn() {}
    },
  }
})

import { prepareSimpleVideo } from '../src'
import type { Config } from '../src'
import { WeiboPost } from '../src/parsers/weibo'

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    parseMode: ['link', 'card'],
    waitTip: null,
    useForward: false,
    quote: true,
    middleware: false,
    parseLimit: 3,
    minimumInterval: 180,
    showImages: true,
    maxImages: 9,
    maxDescLength: 160,
    descTruncateSuffix: '...(已截断)',
    showVideo: true,
    downloadVideoAsFile: true,
    videoDownloadMode: 'buffer',
    maxDownloadedVideoSizeMB: 20,
    maxVideoSendSizeMB: 100,
    showLink: true,
    showError: false,
    loggerinfo: false,
    parsers: {
      xhs: { enabled: true, userAgent: 'test', timeout: 15, imageFormat: 'jpeg', showStats: true },
      douyin: { enabled: true, userAgent: 'test', timeout: 15, showAuthor: true },
      weibo: { enabled: true, userAgent: 'test', timeout: 15, showAuthor: true, showStats: true },
      x: { enabled: true, userAgent: 'test', timeout: 15, showAuthor: true, showStats: true },
      zhihu: { enabled: true, userAgent: 'test', timeout: 15, showAuthor: true, showStats: true },
    },
    ...overrides,
  }
}

function createPost(): WeiboPost {
  return {
    id: '1',
    url: 'https://weibo.com/1/1',
    title: '视频',
    desc: '视频',
    authorName: '作者',
    imageUrls: [],
    videoUrls: ['https://example.com/video.mp4'],
  }
}

function createContext(contentLength: number) {
  return {
    http: {
      head: vi.fn(async () => new Headers({ 'content-length': String(contentLength) })),
      file: vi.fn(async () => ({ data: Buffer.from('video'), type: 'video/mp4' })),
    },
  } as any
}

describe('prepareSimpleVideo', () => {
  it('checks remote size before downloading and falls back to direct URL when over download limit', async () => {
    const ctx = createContext(21 * 1024 * 1024)
    const post = await prepareSimpleVideo(ctx, createPost(), createConfig({
      maxDownloadedVideoSizeMB: 20,
      maxVideoSendSizeMB: 100,
      downloadVideoAsFile: true,
    }), 'weibo')

    expect(ctx.http.head).toHaveBeenCalledTimes(1)
    expect(ctx.http.file).not.toHaveBeenCalled()
    expect(post.videoUrls).toEqual(['https://example.com/video.mp4'])
    expect(post.videoBuffer).toBeUndefined()
  })

  it('removes oversized video elements but keeps the direct link in the skipped message', async () => {
    const ctx = createContext(101 * 1024 * 1024)
    const post = await prepareSimpleVideo(ctx, createPost(), createConfig({
      maxDownloadedVideoSizeMB: 200,
      maxVideoSendSizeMB: 100,
      downloadVideoAsFile: true,
    }), 'weibo')

    expect(ctx.http.file).not.toHaveBeenCalled()
    expect(post.videoUrls).toEqual([])
    expect(post.videoSkippedMessage).toContain('[视频文件过大，跳过解析]')
    expect(post.videoSkippedMessage).toContain('https://example.com/video.mp4')
  })

  it('does not check remote size or download when showVideo is disabled', async () => {
    const ctx = createContext(1 * 1024 * 1024)
    const post = await prepareSimpleVideo(ctx, createPost(), createConfig({
      showVideo: false,
      downloadVideoAsFile: true,
    }), 'weibo')

    expect(ctx.http.head).not.toHaveBeenCalled()
    expect(ctx.http.file).not.toHaveBeenCalled()
    expect(post.videoUrls).toEqual(['https://example.com/video.mp4'])
  })
})
