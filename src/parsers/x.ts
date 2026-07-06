import { h } from 'koishi'
import {
  extractLinks,
  fetchWithTimeout,
  formatCount,
  ParserConfigLike,
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

  const response = await fetchWithTimeout('https://easycomment.ai/api/twitter/v1/free/get-tweet-detail', config, {
    method: 'POST',
    headers: {
      host: 'easycomment.ai',
      'content-type': 'application/json',
      accept: 'application/json,text/plain,*/*',
    },
    body: JSON.stringify({ pid: id }),
  })
  if (!response.ok) throw new Error(`请求 X 接口失败：HTTP ${response.status}`)
  const json = await response.json() as any
  if (json?.code !== 100000) throw new Error(`X 解析失败：${JSON.stringify(json)}`)

  const tweet = findTweetResult(json?.data, id)
  if (!tweet) throw new Error(`未找到推文数据：${id}`)
  return buildXPost(tweet)
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

