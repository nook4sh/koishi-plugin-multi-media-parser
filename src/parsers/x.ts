import { h } from 'koishi'
import {
  extractLinks,
  fetchWithTimeout,
  formatCount,
  ParserConfigLike,
  stripHtml,
  trimText,
  unique,
  URL_BOUNDARY,
} from './common'

export interface XConfigLike extends ParserConfigLike {
  showAuthor: boolean
  showStats: boolean
}

export interface XPost {
  id: string
  url: string
  title: string
  desc: string
  authorName: string
  authorId?: string
  likedCount?: string | number
  repostCount?: string | number
  commentCount?: string | number
  quoteCount?: string | number
  bookmarkCount?: string | number
  viewCount?: string | number
  imageUrls: string[]
  videoUrls: string[]
  videoBuffer?: Buffer
  videoMimeType?: string
  videoSkippedMessage?: string
  quoted?: XPost
}

const LINK_PATTERNS = [
  new RegExp(`https?://(?:www\\.)?(?:x|twitter)\\.com/[0-9A-Za-z_]{1,20}/status/\\d+${URL_BOUNDARY}?`, 'gi'),
]

export function extractXLinks(content: string): string[] {
  return extractLinks(content, LINK_PATTERNS)
}

export async function fetchXPost(rawUrl: string, config: XConfigLike): Promise<XPost> {
  const id = rawUrl.match(/\/status\/(\d+)/)?.[1]
  if (!id) throw new Error('未能识别 X 推文 ID。')

  try {
    const response = await fetchWithTimeout('https://easycomment.ai/api/twitter/v1/free/get-tweet-detail', config, {
      method: 'POST',
      headers: {
        host: 'easycomment.ai',
        'content-type': 'application/json',
        accept: 'application/json,text/plain,*/*',
        origin: 'https://easycomment.ai',
        referer: 'https://easycomment.ai/twitter',
      },
      body: JSON.stringify({ pid: id }),
    })
    if (!response.ok) throw new Error(`请求 X 接口失败：HTTP ${response.status}`)
    const json = await response.json() as any
    if (json?.code !== 100000) throw new Error(`X 解析失败：${JSON.stringify(json)}`)

    const tweet = findTweetResult(json?.data, id)
    if (!tweet) throw new Error(`未找到推文数据：${id}`)
    return buildXPost(tweet)
  } catch {
    try {
      return await fetchXPostFromSyndication(rawUrl, id, config)
    } catch {
      return fetchXPostFromOEmbed(rawUrl, id, config)
    }
  }
}

export function buildXMessages(post: XPost, config: XConfigLike, session?: { userId?: string, username?: string, author?: { nickname?: string } }) {
  const messages: h[] = []
  const attrs = {
    userId: session?.userId,
    nickname: session?.author?.nickname || session?.username,
  }

  messages.push(h('message', attrs, h.text(formatXText(post, config))))

  if (config.showImages) {
    for (const imageUrl of post.imageUrls.slice(0, config.maxImages)) {
      messages.push(h('message', attrs, h.image(imageUrl)))
    }
  }

  if (config.showVideo) {
    if (post.videoBuffer) messages.push(h('message', attrs, h.video(post.videoBuffer, post.videoMimeType || 'video/mp4')))
    for (const videoUrl of post.videoUrls.slice(0, 1)) messages.push(h('message', attrs, h.video(videoUrl)))
  }

  if (post.quoted) messages.push(h('message', attrs, h.text(`引用推文：\n${formatXText(post.quoted, config)}`)))
  if (post.videoSkippedMessage) messages.push(h('message', attrs, h.text(post.videoSkippedMessage)))

  return messages
}

export function buildXPost(entry: any): XPost {
  const result = unwrapTweet(entry?.result || entry)
  const legacy = result?.legacy || {}
  const user = result?.core?.user_results?.result || {}
  const userCore = user?.core || {}
  const textRange = legacy?.display_text_range || [0, legacy?.full_text?.length || 0]
  const text = String(legacy?.full_text || '').slice(textRange[0], textRange[1])
  const quotedEntry = result?.quoted_status_result || result?.retweeted_status_result

  return {
    id: String(result?.rest_id || ''),
    url: `https://x.com/${userCore.screen_name || 'i'}/status/${result?.rest_id || ''}`,
    title: text || 'X 推文',
    desc: text,
    authorName: String(userCore.name || userCore.screen_name || '未知作者'),
    authorId: String(userCore.screen_name || ''),
    likedCount: legacy?.favorite_count,
    repostCount: legacy?.retweet_count,
    quoteCount: legacy?.quote_count,
    commentCount: legacy?.reply_count,
    bookmarkCount: legacy?.bookmark_count,
    viewCount: result?.views?.count,
    imageUrls: unique(extractMedia(result, 'image')),
    videoUrls: unique(extractMedia(result, 'video')),
    quoted: quotedEntry ? buildXPost(quotedEntry) : undefined,
  }
}

function findTweetResult(data: any, id: string) {
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || []
  const entries = instructions.find((item: any) => item?.type === 'TimelineAddEntries')?.entries || []
  const tweetMap = new Map<string, any>()
  let root: any

  for (const entry of entries) {
    const tweetResults = entry?.content?.itemContent?.tweet_results
    const result = unwrapTweet(tweetResults?.result)
    const restId = result?.rest_id
    if (!restId) continue
    tweetMap.set(restId, tweetResults)
    if (restId === id) root = tweetResults
  }

  const rootResult = unwrapTweet(root?.result)
  const legacy = rootResult?.legacy || {}
  const parentId = legacy.in_reply_to_status_id_str || legacy.conversation_id_str
  if (rootResult && parentId && parentId !== id && !rootResult.quoted_status_result) {
    rootResult.quoted_status_result = tweetMap.get(parentId)
  }

  return root
}

function unwrapTweet(result: any) {
  return result?.tweet || result
}

function extractMedia(result: any, type: 'image' | 'video') {
  const media = result?.legacy?.extended_entities?.media || []
  const urls: string[] = []

  for (const item of media) {
    if (type === 'image' && item?.type === 'photo' && item?.media_url_https) {
      urls.push(`${item.media_url_https}:orig`)
    }
    if (type === 'video' && item?.video_info?.variants) {
      const candidates = item.video_info.variants
        .filter((variant: any) => variant?.content_type === 'video/mp4' && typeof variant?.url === 'string')
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))
      if (candidates[0]?.url) urls.push(candidates[0].url)
    }
  }

  return urls
}

function formatXText(post: XPost, config: XConfigLike) {
  const lines = [`X：${trimText(post.title || 'X 推文', config.maxDescLength || 80, config.descTruncateSuffix)}`]
  if (config.showAuthor) lines.push(`作者：${post.authorName}${post.authorId ? ` (@${post.authorId})` : ''}`)
  if (post.desc && post.desc !== post.title && config.maxDescLength > 0) {
    lines.push(trimText(post.desc, config.maxDescLength, config.descTruncateSuffix))
  }
  if (config.showStats) {
    lines.push(`点赞：${formatCount(post.likedCount)}  回复：${formatCount(post.commentCount)}  转发：${formatCount(post.repostCount)}  引用：${formatCount(post.quoteCount)}`)
  }
  if (config.showLink) lines.push(post.url)
  return lines.join('\n')
}

async function fetchXPostFromSyndication(rawUrl: string, id: string, config: XConfigLike): Promise<XPost> {
  const api = new URL('https://cdn.syndication.twimg.com/tweet-result')
  api.searchParams.set('id', id)
  api.searchParams.set('token', '0')
  api.searchParams.set('lang', 'en')

  const response = await fetchSyndicationWithRetry(api.toString(), config)
  if (!response.ok) throw new Error(`请求 X syndication 接口失败：HTTP ${response.status}`)

  const data = await response.json() as any
  if (!data?.id_str) throw new Error('X syndication 接口未返回推文数据。')
  return buildXPostFromSyndication(data, rawUrl)
}

async function fetchSyndicationWithRetry(url: string, config: XConfigLike) {
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fetchWithTimeout(url, config, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          referer: 'https://platform.x.com/',
          connection: 'close',
        },
      })
    } catch (error) {
      lastError = error
      await delay(250 * (attempt + 1))
    }
  }
  throw lastError
}

function buildXPostFromSyndication(data: any, rawUrl: string): XPost {
  const user = data?.user || {}
  const authorId = String(user.screen_name || rawUrl.match(/(?:x|twitter)\.com\/([^/?#]+)/i)?.[1] || '')
  const text = replaceEntityUrls(String(data.text || ''), data.entities?.urls || [])

  return {
    id: String(data.id_str || ''),
    url: `https://x.com/${authorId || 'i'}/status/${data.id_str || ''}`,
    title: text || 'X 推文',
    desc: text,
    authorName: String(user.name || authorId || '未知作者'),
    authorId,
    likedCount: data.favorite_count,
    commentCount: data.conversation_count,
    imageUrls: unique([
      ...extractSyndicationMedia(data, 'image'),
      ...extractCardImages(data),
    ]),
    videoUrls: unique(extractSyndicationMedia(data, 'video')),
  }
}

function replaceEntityUrls(text: string, urls: any[]) {
  let result = text
  for (const item of urls) {
    if (item?.url && item?.expanded_url) result = result.replace(item.url, item.expanded_url)
  }
  return result.trim()
}

function extractSyndicationMedia(data: any, type: 'image' | 'video') {
  const details = Array.isArray(data?.mediaDetails) ? data.mediaDetails : []
  const urls: string[] = []
  for (const item of details) {
    if (type === 'image' && item?.type === 'photo' && item?.media_url_https) {
      urls.push(`${item.media_url_https}:orig`)
    }
    if (type === 'video' && item?.video_info?.variants) {
      const candidates = item.video_info.variants
        .filter((variant: any) => variant?.content_type === 'video/mp4' && typeof variant?.url === 'string')
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))
      if (candidates[0]?.url) urls.push(candidates[0].url)
    }
  }
  return urls
}

function extractCardImages(data: any) {
  const values = data?.card?.binding_values || {}
  const preferred = [
    'photo_image_full_size_original',
    'summary_photo_image_original',
    'thumbnail_image_original',
    'photo_image_full_size_large',
    'summary_photo_image_large',
    'thumbnail_image_large',
  ]
  return preferred
    .map((key) => values?.[key]?.image_value?.url)
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url))
    .slice(0, 1)
}

async function fetchXPostFromOEmbed(rawUrl: string, id: string, config: XConfigLike): Promise<XPost> {
  const api = new URL('https://publish.x.com/oembed')
  api.searchParams.set('url', rawUrl)
  api.searchParams.set('omit_script', 'true')
  const response = await fetchOEmbedWithRetry(api.toString(), config)
  if (!response.ok) throw new Error(`请求 X oEmbed 接口失败：HTTP ${response.status}`)
  const data = await response.json() as any
  const html = String(data?.html || '')
  const desc = stripHtml(html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || html)
  const authorId = String(data?.author_url || '').match(/(?:x|twitter)\.com\/([^/?#]+)/i)?.[1] || ''

  return {
    id,
    url: String(data?.url || rawUrl),
    title: desc || 'X 推文',
    desc,
    authorName: String(data?.author_name || authorId || '未知作者'),
    authorId,
    imageUrls: [],
    videoUrls: [],
  }
}

async function fetchOEmbedWithRetry(url: string, config: XConfigLike) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchWithTimeout(url, config, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          referer: 'https://publish.x.com/',
        },
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
