import { Context, Logger, Schema, h } from 'koishi'
import os from 'node:os'
import path from 'node:path'
import nodeUrl from 'node:url'
import { promises as fs } from 'node:fs'
import {
  buildDouyinMessages,
  DouyinPost,
  extractDouyinLinks,
  fetchDouyinPost,
} from './parsers/douyin'
import {
  buildXhsMessages,
  extractXhsLinks,
  fetchXhsNote,
  XhsNote,
} from './parsers/xhs'
import {
  buildWeiboMessages,
  extractWeiboLinks,
  fetchWeiboPost,
  WeiboPost,
} from './parsers/weibo'
import {
  buildXMessages,
  extractXLinks,
  fetchXPost,
  XPost,
} from './parsers/x'
import {
  buildZhihuMessages,
  extractZhihuLinks,
  fetchZhihuPost,
  ZhihuPost,
} from './parsers/zhihu'

export const name = 'gensokyo-parser'

const logger = new Logger(name)
const VIDEO_TOO_LARGE_MESSAGE = '[视频文件过大，跳过解析]'

export interface Config {
  enabled: boolean
  parseMode: ('link' | 'card')[]
  waitTip?: string | null
  useForward: boolean
  quote: boolean
  middleware: boolean
  parseLimit: number
  minimumInterval: number
  showImages: boolean
  maxImages: number
  maxDescLength: number
  descTruncateSuffix: string
  showVideo: boolean
  downloadVideoAsFile: boolean
  videoDownloadMode: 'buffer' | 'file' | 'base64'
  maxDownloadedVideoSizeMB: number
  maxVideoSendSizeMB: number
  showLink: boolean
  showError: boolean
  loggerinfo: boolean
  parsers: {
    xhs: {
      enabled: boolean
      userAgent: string
      cookie?: string
      timeout: number
      imageFormat: 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'auto'
      showStats: boolean
    }
    douyin: {
      enabled: boolean
      userAgent: string
      cookie?: string
      timeout: number
      showAuthor: boolean
    }
    weibo: {
      enabled: boolean
      userAgent: string
      cookie?: string
      timeout: number
      showAuthor: boolean
      showStats: boolean
    }
    x: {
      enabled: boolean
      userAgent: string
      cookie?: string
      timeout: number
      showAuthor: boolean
      showStats: boolean
    }
    zhihu: {
      enabled: boolean
      userAgent: string
      cookie?: string
      timeout: number
      showAuthor: boolean
      showStats: boolean
    }
  }
}

type ParserId = keyof Config['parsers']

interface ParseTarget {
  parser: ParserId
  label: string
  link: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('开启幻想乡通用解析器。'),
    parseMode: Schema.array(Schema.union([
      Schema.const('link').description('普通链接'),
      Schema.const('card').description('卡片消息'),
    ])).role('checkbox').default(['link', 'card']).description('选择解析来源。'),
    waitTip: Schema.union([
      Schema.const(null).description('不发送提示'),
      Schema.string().description('解析前发送提示语').default('正在解析链接...'),
    ]).default(null).description('等待提示。'),
  }).description('基础设置'),
  Schema.object({
    useForward: Schema.boolean().default(false).description('开启合并转发。主要适用于 onebot / red 适配器。').experimental(),
    quote: Schema.boolean().default(true).description('普通发送时引用原消息。'),
    middleware: Schema.boolean().default(false).description('以前置中间件模式捕获消息。').experimental(),
    parseLimit: Schema.number().min(1).max(10).step(1).default(3).description('单条消息最多解析的链接数量。'),
    minimumInterval: Schema.number().min(0).max(3600).step(1).default(180).description('同频道同链接去重间隔，单位秒。0 表示不去重。'),
  }).description('发送设置'),
  Schema.object({
    showImages: Schema.boolean().default(true).description('返回图片/动图。'),
    maxImages: Schema.number().min(0).max(18).step(1).default(9).description('单个作品最多发送图片数。'),
    maxDescLength: Schema.number().min(0).max(2000).step(10).default(160).description('描述最大字数。设为 0 时不展示描述。'),
    descTruncateSuffix: Schema.string().default('...(已截断)').description('描述超出最大字数时追加的截断标志。'),
    showVideo: Schema.boolean().default(true).description('返回视频元素。'),
    downloadVideoAsFile: Schema.boolean().default(false).description('尝试先下载首个视频再发送，缓解 QQ / OneBot 等平台直链“资源已过期”的问题。会增加带宽消耗。'),
    videoDownloadMode: Schema.union([
      Schema.const('buffer').description('使用二进制 Buffer 方式发送视频（推荐）'),
      Schema.const('base64').description('使用 base64:// 段发送视频（OneBot 常用格式，buffer 失败时可尝试）'),
      Schema.const('file').description('写入临时文件并通过 file:// URL 发送（Napcat 等特殊环境）'),
    ]).default('buffer').description('下载视频后的发送方式。'),
    maxDownloadedVideoSizeMB: Schema.number().min(0).max(2048).step(1).default(20).description('下载视频大小上限，单位 MB。超过后自动回退为发送视频直链；设为 0 表示不限制。'),
    maxVideoSendSizeMB: Schema.number().min(0).max(2048).step(1).default(100).description('视频发送大小上限，单位 MB。超过后不发送视频，包括直链；设为 0 表示不限制。'),
    showLink: Schema.boolean().default(true).description('展示原文链接。'),
  }).description('内容设置'),
  Schema.object({
    parsers: Schema.object({
      xhs: Schema.object({
        enabled: Schema.boolean().default(true).description('开启小红书子解析器。'),
        imageFormat: Schema.union([
          Schema.const('jpeg').description('jpeg'),
          Schema.const('png').description('png'),
          Schema.const('webp').description('webp'),
          Schema.const('heic').description('heic'),
          Schema.const('avif').description('avif'),
          Schema.const('auto').description('原图格式'),
        ]).default('jpeg').description('图片返回格式。'),
        showStats: Schema.boolean().default(true).description('展示点赞、收藏、评论、分享数据。'),
        userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0').description('请求小红书页面时使用的 User-Agent。'),
        cookie: Schema.string().role('textarea').default('').description('可选 Cookie。遇到风控或无法读取页面数据时可填写。'),
        timeout: Schema.number().min(3).max(60).step(1).default(15).description('请求超时时间，单位秒。'),
      }).description('小红书'),
      douyin: Schema.object({
        enabled: Schema.boolean().default(true).description('开启抖音子解析器。'),
        showAuthor: Schema.boolean().default(true).description('展示作者。'),
        userAgent: Schema.string().default('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1').description('请求抖音页面时使用的 User-Agent。'),
        cookie: Schema.string().role('textarea').default('').description('可选 Cookie。遇到风控或无法读取页面数据时可填写。'),
        timeout: Schema.number().min(3).max(60).step(1).default(15).description('请求超时时间，单位秒。'),
      }).description('抖音'),
      weibo: Schema.object({
        enabled: Schema.boolean().default(true).description('开启微博子解析器。'),
        showAuthor: Schema.boolean().default(true).description('展示作者。'),
        showStats: Schema.boolean().default(true).description('展示点赞、评论、转发数据。'),
        userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0').description('请求微博页面时使用的 User-Agent。'),
        cookie: Schema.string().role('textarea').default('').description('可选 Cookie。遇到风控或无法读取页面数据时可填写。'),
        timeout: Schema.number().min(3).max(60).step(1).default(15).description('请求超时时间，单位秒。'),
      }).description('微博'),
      x: Schema.object({
        enabled: Schema.boolean().default(true).description('开启 X / Twitter 子解析器。'),
        showAuthor: Schema.boolean().default(true).description('展示作者。'),
        showStats: Schema.boolean().default(true).description('展示点赞、回复、转发、引用数据。'),
        userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0').description('请求 X 解析接口时使用的 User-Agent。'),
        cookie: Schema.string().role('textarea').default('').description('可选 Cookie。'),
        timeout: Schema.number().min(3).max(60).step(1).default(15).description('请求超时时间，单位秒。'),
      }).description('X / Twitter'),
      zhihu: Schema.object({
        enabled: Schema.boolean().default(true).description('开启知乎子解析器。'),
        showAuthor: Schema.boolean().default(true).description('展示作者。'),
        showStats: Schema.boolean().default(true).description('展示赞同/喜欢、评论、收藏、浏览数据。'),
        userAgent: Schema.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0').description('请求知乎接口时使用的 User-Agent。'),
        cookie: Schema.string().role('textarea').default('').description('可选 Cookie。遇到风控或无法读取接口时可填写。'),
        timeout: Schema.number().min(3).max(60).step(1).default(15).description('请求超时时间，单位秒。'),
      }).description('知乎'),
    }).description('子解析器设置'),
    showError: Schema.boolean().default(false).description('解析失败时向聊天发送错误提示。'),
    loggerinfo: Schema.boolean().default(false).description('输出调试日志。').experimental(),
  }).description('网络与调试'),
])

export const usage = `
发送小红书、抖音链接或平台卡片即可自动解析。

项目名：koishi-plugin-gensokyo-parser（幻想乡解析器）

支持示例：

- https://www.xiaohongshu.com/explore/...
- http://xhslink.com/m/AixEkyLwpfs
- https://v.douyin.com/_2ljF4AmKL8/
- https://www.douyin.com/video/7521023890996514083
- https://www.douyin.com/note/7469411074119322899
- https://weibo.com/7207262816/P5kWdcfDe
- https://x.com/openai/status/...
- https://www.zhihu.com/question/67423622
- https://zhuanlan.zhihu.com/p/...
`

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return

  const recent = new Map<string, number>()

  ctx.middleware(async (session, next) => {
    const content = session.content || session.stripped?.content || ''
    const isCard = /^<\w+\s/i.test(content) || content.includes('data=')

    if (isCard && !config.parseMode.includes('card')) return next()
    if (!isCard && !config.parseMode.includes('link')) return next()

    const targets = collectTargets(content, config)
      .filter((target) => shouldProcess(recent, session.channelId || session.guildId || 'private', target, config.minimumInterval))
      .slice(0, config.parseLimit)

    if (!targets.length) return next()

    handleTargets(ctx, session, targets, config).catch((error) => {
      logger.warn(error)
    })

    return next()
  }, config.middleware)
}

function collectTargets(content: string, config: Config): ParseTarget[] {
  const targets: ParseTarget[] = []

  if (config.parsers.xhs.enabled) {
    targets.push(...extractXhsLinks(content).map((link) => ({ parser: 'xhs' as const, label: '小红书', link })))
  }
  if (config.parsers.douyin.enabled) {
    targets.push(...extractDouyinLinks(content).map((link) => ({ parser: 'douyin' as const, label: '抖音', link })))
  }
  if (config.parsers.weibo.enabled) {
    targets.push(...extractWeiboLinks(content).map((link) => ({ parser: 'weibo' as const, label: '微博', link })))
  }
  if (config.parsers.x.enabled) {
    targets.push(...extractXLinks(content).map((link) => ({ parser: 'x' as const, label: 'X', link })))
  }
  if (config.parsers.zhihu.enabled) {
    targets.push(...extractZhihuLinks(content).map((link) => ({ parser: 'zhihu' as const, label: '知乎', link })))
  }

  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = `${target.parser}:${target.link}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function handleTargets(ctx: Context, session: any, targets: ParseTarget[], config: Config) {
  let waitTipMessageId: string | undefined

  if (config.waitTip) {
    const result = await session.send(`${h.quote(session.messageId)}${config.waitTip}`)
    waitTipMessageId = Array.isArray(result) ? result[0] : result
  }

  try {
    const allMessages: h[] = []

    for (const target of targets) {
      if (config.loggerinfo) logger.info(`parse ${target.parser}: ${target.link}`)
      allMessages.push(...await parseTarget(ctx, session, target, config))
    }

    if (!allMessages.length) return

    if (config.useForward && (session.platform === 'onebot' || session.platform === 'red')) {
      await session.send(h('figure', { children: allMessages }))
      return
    }

    if (config.quote) {
      await session.send(h('message', h.quote(session.messageId), allMessages[0].children))
      for (const message of allMessages.slice(1)) await session.send(message)
      return
    }

    for (const message of allMessages) await session.send(message)
  } catch (error) {
    logger.warn(error)
    if (config.showError) await session.send(`解析失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (waitTipMessageId && session.channelId) {
      await session.bot?.deleteMessage?.(session.channelId, waitTipMessageId).catch?.(() => undefined)
    }
  }
}

async function parseTarget(ctx: Context, session: any, target: ParseTarget, config: Config): Promise<h[]> {
  if (target.parser === 'xhs') {
    const note = await prepareXhsVideo(ctx, await fetchXhsNote(target.link, toXhsConfig(config)), config)
    return buildXhsMessages(note, toXhsConfig(config), session)
  }

  if (target.parser === 'douyin') {
    const post = await prepareDouyinVideo(ctx, await fetchDouyinPost(target.link, toDouyinConfig(config)), config)
    return buildDouyinMessages(post, toDouyinConfig(config), session)
  }

  if (target.parser === 'weibo') {
    const post = await prepareSimpleVideo(ctx, await fetchWeiboPost(target.link, toWeiboConfig(config)), config, 'weibo')
    return buildWeiboMessages(post, toWeiboConfig(config), session)
  }

  if (target.parser === 'x') {
    const post = await prepareSimpleVideo(ctx, await fetchXPost(target.link, toXConfig(config)), config, 'x')
    return buildXMessages(post, toXConfig(config), session)
  }

  const post = await prepareSimpleVideo(ctx, await fetchZhihuPost(target.link, toZhihuConfig(config)), config, 'zhihu')
  return buildZhihuMessages(post, toZhihuConfig(config), session)
}

function toXhsConfig(config: Config) {
  return {
    ...config.parsers.xhs,
    showVideo: config.showVideo,
    showImages: config.showImages,
    maxImages: config.maxImages,
    maxDescLength: config.maxDescLength,
    descTruncateSuffix: config.descTruncateSuffix,
    showLink: config.showLink,
  }
}

function toDouyinConfig(config: Config) {
  return {
    ...config.parsers.douyin,
    showVideo: config.showVideo,
    showImages: config.showImages,
    maxImages: config.maxImages,
    maxDescLength: config.maxDescLength,
    descTruncateSuffix: config.descTruncateSuffix,
    showLink: config.showLink,
  }
}

function toWeiboConfig(config: Config) {
  return {
    ...config.parsers.weibo,
    showVideo: config.showVideo,
    showImages: config.showImages,
    maxImages: config.maxImages,
    maxDescLength: config.maxDescLength,
    descTruncateSuffix: config.descTruncateSuffix,
    showLink: config.showLink,
  }
}

function toXConfig(config: Config) {
  return {
    ...config.parsers.x,
    showVideo: config.showVideo,
    showImages: config.showImages,
    maxImages: config.maxImages,
    maxDescLength: config.maxDescLength,
    descTruncateSuffix: config.descTruncateSuffix,
    showLink: config.showLink,
  }
}

function toZhihuConfig(config: Config) {
  return {
    ...config.parsers.zhihu,
    showVideo: config.showVideo,
    showImages: config.showImages,
    maxImages: config.maxImages,
    maxDescLength: config.maxDescLength,
    descTruncateSuffix: config.descTruncateSuffix,
    showLink: config.showLink,
  }
}

async function prepareXhsVideo(ctx: Context, note: XhsNote, config: Config): Promise<XhsNote> {
  return prepareVideo(ctx, note, config, {
    parser: 'xhs',
    urls: (value) => value.videoUrls,
    remove: (value) => ({ ...value, videoBuffer: undefined, videoUrls: [], videoSkippedMessage: VIDEO_TOO_LARGE_MESSAGE }),
    replace: (value, replacement) => ({
      ...value,
      videoBuffer: replacement.kind === 'buffer' ? replacement.buffer : undefined,
      videoMimeType: replacement.mimeType,
      videoUrls: replacement.kind === 'buffer'
        ? value.videoUrls.slice(1)
        : [replacement.src, ...value.videoUrls.slice(1)],
    }),
  })
}

async function prepareDouyinVideo(ctx: Context, post: DouyinPost, config: Config): Promise<DouyinPost> {
  return prepareVideo(ctx, post, config, {
    parser: 'douyin',
    urls: (value) => [...value.dynamicImageUrls, ...value.videoUrls],
    remove: (value) => ({
      ...value,
      videoBuffer: undefined,
      dynamicImageUrls: [],
      videoUrls: [],
      videoSkippedMessage: VIDEO_TOO_LARGE_MESSAGE,
    }),
    replace: (value, replacement, firstVideo) => {
      const fromDynamic = firstVideo === value.dynamicImageUrls[0]
      const remainingDynamicUrls = value.dynamicImageUrls.slice(fromDynamic ? 1 : 0)
      const remainingVideoUrls = fromDynamic ? value.videoUrls : value.videoUrls.slice(1)

      if (replacement.kind === 'buffer') {
        return {
          ...value,
          videoBuffer: replacement.buffer,
          videoMimeType: replacement.mimeType,
          dynamicImageUrls: remainingDynamicUrls,
          videoUrls: remainingVideoUrls,
        }
      }

      return {
        ...value,
        videoBuffer: undefined,
        videoMimeType: replacement.mimeType,
        dynamicImageUrls: fromDynamic ? [replacement.src, ...remainingDynamicUrls] : remainingDynamicUrls,
        videoUrls: fromDynamic ? remainingVideoUrls : [replacement.src, ...remainingVideoUrls],
      }
    },
  })
}

async function prepareSimpleVideo<T extends WeiboPost | XPost | ZhihuPost>(ctx: Context, post: T, config: Config, parser: string): Promise<T> {
  return prepareVideo(ctx, post, config, {
    parser,
    urls: (value) => value.videoUrls,
    remove: (value) => ({ ...value, videoBuffer: undefined, videoUrls: [], videoSkippedMessage: VIDEO_TOO_LARGE_MESSAGE }),
    replace: (value, replacement) => ({
      ...value,
      videoBuffer: replacement.kind === 'buffer' ? replacement.buffer : undefined,
      videoMimeType: replacement.mimeType,
      videoUrls: replacement.kind === 'buffer'
        ? value.videoUrls.slice(1)
        : [replacement.src, ...value.videoUrls.slice(1)],
    }),
  })
}

async function prepareVideo<T>(
  ctx: Context,
  value: T,
  config: Config,
  adapter: {
    parser: string
    urls: (value: T) => string[]
    remove: (value: T) => T
    replace: (value: T, replacement: { kind: 'buffer', buffer: Buffer, mimeType: string } | { kind: 'url', src: string, mimeType: string }, firstVideo: string) => T
  },
): Promise<T> {
  if (!config.showVideo) {
    if (config.loggerinfo) logger.info('skip video: showVideo=false')
    return value
  }

  const firstVideo = adapter.urls(value)[0]
  if (!firstVideo) {
    if (config.loggerinfo) logger.info('skip video download: no video URL found')
    return value
  }
  if (!/^https?:\/\//i.test(firstVideo)) {
    if (config.loggerinfo) logger.info(`skip video download: unsupported video URL protocol (${firstVideo})`)
    return value
  }

  const maxSendSizeBytes = getSizeLimitBytes(config.maxVideoSendSizeMB, 100)
  const remoteSize = await getRemoteVideoSize(ctx, firstVideo, config)
  if (remoteSize !== undefined && maxSendSizeBytes && remoteSize > maxSendSizeBytes) {
    if (config.loggerinfo) {
      logger.info(`skip video send: remote size=${formatBytes(remoteSize)}, max=${formatBytes(maxSendSizeBytes)}, url=${firstVideo}`)
    }
    return adapter.remove(value)
  }

  if (!config.downloadVideoAsFile) {
    if (config.loggerinfo) logger.info('skip video download: downloadVideoAsFile=false, use direct URL')
    return value
  }

  try {
    if (config.loggerinfo) logger.info(`download first video start: url=${firstVideo}`)

    const file = await ctx.http.file(firstVideo)
    if (!file?.data) {
      if (config.loggerinfo) logger.info('download video failed: empty response data')
      return value
    }

    const buffer = Buffer.from(file.data)
    const mimeType = (file as any).type || (file as any).mime || 'video/mp4'
    const mode = config.videoDownloadMode || 'buffer'
    const maxSizeBytes = config.maxDownloadedVideoSizeMB > 0
      ? config.maxDownloadedVideoSizeMB * 1024 * 1024
      : 0

    if (config.loggerinfo) {
      logger.info(`download first video success: size=${formatBytes(buffer.length)}, mime=${mimeType}, mode=${mode}, max=${maxSizeBytes ? formatBytes(maxSizeBytes) : 'unlimited'}`)
    }

    if (maxSendSizeBytes && buffer.length > maxSendSizeBytes) {
      if (config.loggerinfo) logger.info(`skip video send: downloaded size=${formatBytes(buffer.length)}, max=${formatBytes(maxSendSizeBytes)}`)
      return adapter.remove(value)
    }

    if (maxSizeBytes && buffer.length > maxSizeBytes) {
      if (config.loggerinfo) logger.info(`downloaded video exceeds limit: size=${formatBytes(buffer.length)}, max=${formatBytes(maxSizeBytes)}, fallback=direct URL`)
      return value
    }

    if (mode === 'buffer') {
      if (config.loggerinfo) logger.info(`use downloaded video buffer: size=${formatBytes(buffer.length)}`)
      return adapter.replace(value, { kind: 'buffer', buffer, mimeType }, firstVideo)
    }

    const src = mode === 'file'
      ? await createTempVideoFile(adapter.parser, buffer, mimeType)
      : `base64://${buffer.toString('base64')}`

    if (config.loggerinfo) {
      logger.info(`use downloaded video ${mode}: src=${mode === 'file' ? src : `base64://${formatBytes(buffer.length)} raw`}`)
    }

    return adapter.replace(value, { kind: 'url', src, mimeType }, firstVideo)
  } catch (error) {
    if (config.loggerinfo) logger.info(`download video failed: ${error instanceof Error ? error.message : String(error)}`)
    return value
  }
}

async function getRemoteVideoSize(ctx: Context, url: string, config: Config): Promise<number | undefined> {
  const maxSendSizeBytes = getSizeLimitBytes(config.maxVideoSendSizeMB, 100)
  if (!maxSendSizeBytes) return undefined

  try {
    if (config.loggerinfo) logger.info(`check remote video size start: url=${url}`)
    const timeout = Math.min(...[
      config.parsers.xhs.timeout,
      config.parsers.douyin.timeout,
      config.parsers.weibo.timeout,
      config.parsers.x.timeout,
      config.parsers.zhihu.timeout,
    ].filter((value) => Number.isFinite(value))) * 1000
    const headers = await ctx.http.head(url, { timeout })
    const contentLength = headers.get('content-length')
    if (!contentLength) {
      if (config.loggerinfo) logger.info('check remote video size skipped: missing content-length')
      return undefined
    }

    const size = Number.parseInt(contentLength, 10)
    if (!Number.isFinite(size) || size < 0) {
      if (config.loggerinfo) logger.info(`check remote video size skipped: invalid content-length=${contentLength}`)
      return undefined
    }

    if (config.loggerinfo) logger.info(`check remote video size success: size=${formatBytes(size)}, max=${formatBytes(maxSendSizeBytes)}`)
    return size
  } catch (error) {
    if (config.loggerinfo) logger.info(`check remote video size failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function getSizeLimitBytes(sizeMB: number | undefined, fallbackMB: number): number {
  const normalized = sizeMB ?? fallbackMB
  return normalized > 0 ? normalized * 1024 * 1024 : 0
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function createTempVideoFile(parser: string, buffer: Buffer, mimeType: string): Promise<string> {
  const fileName = `${parser}-video-${Date.now()}-${Math.random().toString(16).slice(2)}${getVideoFileExtension(mimeType)}`
  const filePath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(filePath, buffer)
  return nodeUrl.pathToFileURL(filePath).href
}

function getVideoFileExtension(mimeType: string) {
  const lower = mimeType.toLowerCase()
  if (lower.includes('mp4')) return '.mp4'
  if (lower.includes('webm')) return '.webm'
  if (lower.includes('ogg') || lower.includes('ogv')) return '.ogv'
  if (lower.includes('flv')) return '.flv'
  return '.mp4'
}

function shouldProcess(recent: Map<string, number>, channelId: string, target: ParseTarget, seconds: number) {
  if (seconds <= 0) return true

  const key = `${channelId}:${target.parser}:${target.link}`
  const now = Date.now()
  const last = recent.get(key)
  if (last && now - last < seconds * 1000) return false

  recent.set(key, now)
  return true
}

export * from './parsers/douyin'
export * from './parsers/weibo'
export * from './parsers/x'
export * from './parsers/xhs'
export * from './parsers/zhihu'
