import { h } from 'koishi'
import {
  ensureProtocol,
  extractLinks,
  fetchWithTimeout,
  formatCount,
  formatMessageSections,
  ParserConfigLike,
  stripHtml,
  trimText,
  unique,
  URL_BOUNDARY,
} from './common'

export interface WeiboConfigLike extends ParserConfigLike {
  showAuthor: boolean
  showStats: boolean
}

export interface WeiboPost {
  id: string
  url: string
  title: string
  desc: string
  authorName: string
  authorId?: string
  likedCount?: string | number
  repostCount?: string | number
  commentCount?: string | number
  imageUrls: string[]
  videoUrls: string[]
  videoBuffer?: Buffer
  videoMimeType?: string
  videoSkippedMessage?: string
  repost?: WeiboPost
}

const LINK_PATTERNS = [
  new RegExp(`https?://(?:www\\.)?weibo\\.com/\\d+/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://m\\.weibo\\.cn/(?:status|detail|\\d+)/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://(?:www\\.)?weibo\\.com/tv/show/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://video\\.weibo\\.com/show\\?${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://mapp\\.api\\.weibo\\.cn/fx/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://(?:www\\.)?weibo\\.com/ttarticle/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://card\\.weibo\\.com/article/m/show/id/${URL_BOUNDARY}`, 'gi'),
]

let weiboCookie = ''
let weiboVisitorReadyAt = 0
const WEIBO_VISITOR_TTL = 3 * 60 * 60 * 1000
const WEIBO_BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function extractWeiboLinks(content: string): string[] {
  return extractLinks(content, LINK_PATTERNS)
}

export async function fetchWeiboPost(rawUrl: string, config: WeiboConfigLike): Promise<WeiboPost> {
  const url = await resolveWeiboLink(rawUrl, config)
  const articleId = extractArticleId(url)
  if (articleId) return fetchWeiboArticle(articleId, config)

  const fid = extractVideoFid(url)
  if (fid) return fetchWeiboTv(fid, config)

  const id = extractWeiboId(url)
  if (!id) throw new Error('未能识别微博 ID。')

  const api = new URL('https://www.weibo.com/ajax/statuses/show')
  api.searchParams.set('id', id)
  const data = await fetchJson(api.toString(), config, {
    referer: 'https://www.weibo.com/',
    accept: 'application/json,text/plain,*/*',
  })
  return buildWeiboPost(data, config)
}

export function buildWeiboMessages(post: WeiboPost, config: WeiboConfigLike, session?: { userId?: string, username?: string, author?: { nickname?: string } }) {
  const messages: h[] = []
  const attrs = {
    userId: session?.userId,
    nickname: session?.author?.nickname || session?.username,
  }

  messages.push(h('message', attrs, h.text(formatWeiboText(post, config))))

  if (config.showImages) {
    for (const imageUrl of post.imageUrls.slice(0, config.maxImages)) {
      messages.push(h('message', attrs, h.image(imageUrl)))
    }
  }

  if (config.showVideo) {
    if (post.videoBuffer) messages.push(h('message', attrs, h.video(post.videoBuffer, post.videoMimeType || 'video/mp4')))
    for (const videoUrl of post.videoUrls.slice(0, 1)) messages.push(h('message', attrs, h.video(videoUrl)))
  }

  if (post.repost) {
    messages.push(h('message', attrs, h.text(`转发微博：\n${formatWeiboText(post.repost, config)}`)))
  }

  if (post.videoSkippedMessage) messages.push(h('message', attrs, h.text(post.videoSkippedMessage)))

  return messages
}

async function resolveWeiboLink(rawUrl: string, config: WeiboConfigLike) {
  const url = ensureProtocol(rawUrl)
  if (!/mapp\.api\.weibo\.cn\/fx/i.test(url)) return url
  const redirect = await fetchWithTimeout(url, config, { redirect: 'manual' })
  const location = redirect.headers.get('location')
  if (location) return new URL(location, url).toString()

  const response = await fetchWithTimeout(url, config, { redirect: 'follow' })
  const visitorTarget = new URL(response.url || url).searchParams.get('url')
  if (visitorTarget) return visitorTarget
  return response.url || url
}

async function fetchWeiboArticle(id: string, config: WeiboConfigLike): Promise<WeiboPost> {
  const api = new URL('https://card.weibo.com/article/m/aj/detail')
  api.searchParams.set('id', id)
  const data = await fetchJson(api.toString(), config, { referer: 'https://weibo.com/' })
  const detail = data?.data || data

  return {
    id,
    url: detail?.url || `https://weibo.com/ttarticle/p/show?id=${id}`,
    title: String(detail?.title || '微博文章'),
    desc: stripHtml(String(detail?.content || detail?.summary || '')),
    authorName: String(detail?.userinfo?.screen_name || detail?.user?.screen_name || '未知作者'),
    authorId: String(detail?.userinfo?.idstr || detail?.user?.idstr || ''),
    likedCount: detail?.like_count,
    repostCount: detail?.repost_count,
    commentCount: detail?.comment_count,
    imageUrls: unique(extractImageUrls(detail)),
    videoUrls: [],
  }
}

async function fetchWeiboTv(fid: string, config: WeiboConfigLike): Promise<WeiboPost> {
  const payload = JSON.stringify({ Component_Play_Playinfo: { oid: fid } })
  const response = await fetchWeibo(`https://weibo.com/tv/api/component?page=/show/${encodeURIComponent(fid)}`, config, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://weibo.com/',
    },
    body: new URLSearchParams({ data: payload }),
  })
  if (!response.ok) throw new Error(`请求微博视频失败：HTTP ${response.status}`)
  const json = await response.json() as any
  const info = json?.data?.Component_Play_Playinfo || {}

  return {
    id: fid,
    url: `https://h5.video.weibo.com/show/${fid}`,
    title: String(info.title || '微博视频'),
    desc: stripHtml(String(info.text || '')),
    authorName: String(info.author || '未知作者'),
    likedCount: info.attitudes_count,
    repostCount: info.reposts_count,
    commentCount: info.comments_count,
    imageUrls: info.cover_image ? [`https:${String(info.cover_image).replace(/^https?:/, '')}`] : [],
    videoUrls: [normalizeProtocol(firstValue(info.urls) || info.stream_url)].filter(Boolean),
  }
}

async function buildWeiboPost(data: any, config: WeiboConfigLike): Promise<WeiboPost> {
  if (!isValidWeiboStatus(data)) throw new Error('微博接口未返回有效微博数据。')

  const text = data?.isLongText ? await fetchLongText(data.idstr, config).catch(() => data.text_raw || data.text || '') : data?.text_raw || data?.text || ''
  const repost = data?.retweeted_status ? await buildWeiboPost(data.retweeted_status, config) : undefined
  const mediaVideo = data?.page_info?.media_info?.stream_url_hd || data?.page_info?.media_info?.stream_url
  const statusId = String(data?.mblogid || data?.idstr || data?.mid || '')

  return {
    id: String(data?.idstr || data?.mid || ''),
    url: data?.user?.idstr && statusId ? `https://weibo.com/${data.user.idstr}/${statusId}` : '',
    title: stripHtml(String(text || '微博')),
    desc: stripHtml(String(text || '')),
    authorName: String(data?.user?.screen_name || '未知作者'),
    authorId: String(data?.user?.idstr || ''),
    likedCount: data?.attitudes_count,
    repostCount: data?.reposts_count,
    commentCount: data?.comments_count,
    imageUrls: unique(extractImageUrls(data)),
    videoUrls: unique([
      ...extractLivePhotoUrls(data),
      mediaVideo ? normalizeProtocol(mediaVideo) : '',
    ]),
    repost,
  }
}

async function fetchLongText(id: string, config: WeiboConfigLike) {
  const api = new URL('https://weibo.com/ajax/statuses/longtext')
  api.searchParams.set('id', id)
  const data = await fetchJson(api.toString(), config, { referer: 'https://weibo.com/' })
  return data?.data?.longTextContent_raw || ''
}

async function fetchJson(url: string, config: WeiboConfigLike, headers: Record<string, string> = {}) {
  let response = await fetchWeibo(url, config, {
    redirect: 'follow',
    headers: {
      accept: 'application/json,text/plain,*/*',
      ...headers,
    },
  })
  if (!response.ok) throw new Error(`请求微博接口失败：HTTP ${response.status}`)
  let data = await response.json() as any

  if (data?.ok === -100 && !config.cookie) {
    await initWeiboVisitor(config, true)
    response = await fetchWeibo(url, config, {
      redirect: 'follow',
      headers: {
        accept: 'application/json,text/plain,*/*',
        ...headers,
      },
    })
    if (!response.ok) throw new Error(`请求微博接口失败：HTTP ${response.status}`)
    data = await response.json() as any
  }

  if (data?.ok === -100) throw new Error('微博解析失败：需要有效 Cookie 或 visitor 授权。')
  if (data?.ok === 0 && data?.message) throw new Error(`微博解析失败：${String(data.message)}`)
  if (data?.error) throw new Error(`微博解析失败：${String(data.error)}`)
  return data
}

async function fetchWeibo(url: string, config: WeiboConfigLike, init: RequestInit = {}) {
  if (!config.cookie) await initWeiboVisitor(config)

  const cookie = config.cookie || weiboCookie
  const xsrf = extractCookie(cookie, 'XSRF-TOKEN')
  const response = await fetchWithTimeout(url, config, {
    ...init,
    headers: {
      referer: 'https://www.weibo.com/',
      ...(cookie ? { cookie } : {}),
      ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
      ...(init.headers || {}),
    },
  })
  rememberSetCookie(response)
  return response
}

async function initWeiboVisitor(config: WeiboConfigLike, force = false) {
  if (!force && weiboCookie && Date.now() - weiboVisitorReadyAt < WEIBO_VISITOR_TTL) return

  const response = await fetchWithTimeout('https://visitor.passport.weibo.cn/visitor/genvisitor2', config, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://visitor.passport.weibo.cn',
      referer: 'https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2F',
    },
    body: new URLSearchParams({ cb: 'visitor_gray_callback', tid: '', new_tid: 'null' }),
  })
  const text = await response.text()
  const match = text.match(/visitor_gray_callback\((.*)\)/)
  const data = match ? JSON.parse(match[1]) : null
  if (data?.retcode !== 20000000 || !data?.data?.sub || !data?.data?.subp) {
    throw new Error('微博 visitor 授权初始化失败。')
  }

  weiboCookie = mergeCookies(weiboCookie, `SUB=${data.data.sub}; SUBP=${data.data.subp}`)
  const home = await fetchWithTimeout('https://www.weibo.com', config, {
    redirect: 'follow',
    headers: {
      cookie: weiboCookie,
      referer: 'https://visitor.passport.weibo.cn/',
    },
  })
  rememberSetCookie(home)
  weiboVisitorReadyAt = Date.now()
}

function formatWeiboText(post: WeiboPost, config: WeiboConfigLike) {
  const meta = []
  if (config.showStats) meta.push(`点赞：${formatCount(post.likedCount)}  评论：${formatCount(post.commentCount)}  转发：${formatCount(post.repostCount)}`)
  if (config.showLink && post.url) meta.push(post.url)

  return formatMessageSections([
    [
      `微博：${trimText(post.title || '微博', config.maxDescLength || 80, config.descTruncateSuffix)}`,
      config.showAuthor ? `作者：${post.authorName}` : '',
    ],
    [
      post.desc && post.desc !== post.title && config.maxDescLength > 0
        ? trimText(post.desc, config.maxDescLength, config.descTruncateSuffix)
        : '',
    ],
    meta,
  ])
}

function extractArticleId(url: string) {
  return url.match(/[?&#]id=(\d+)/)?.[1] || url.match(/\/article\/m\/show\/id\/(\d+)/)?.[1] || ''
}

function extractVideoFid(url: string) {
  const fid = url.match(/[?&]fid=([^&#]+)/)?.[1] || url.match(/\/tv\/show\/([^?#]+)/)?.[1] || ''
  return fid ? decodeURIComponent(fid) : ''
}

function extractWeiboId(url: string) {
  const normalized = ensureProtocol(url)
  const direct = normalized.match(/weibo\.com\/\d+\/([0-9A-Za-z]+)/i)?.[1]
    || normalized.match(/m\.weibo\.cn\/(?:status|detail|\d+)\/([0-9A-Za-z]+)/i)?.[1]
  if (!direct) return ''
  return /^\d+$/.test(direct) ? direct : weiboMblogIdToMid(direct)
}

export function weiboMblogIdToMid(mblogid: string) {
  if (!/^[0-9A-Za-z]+$/.test(mblogid)) return mblogid

  const chunks: string[] = []
  for (let end = mblogid.length; end > 0; end -= 4) {
    const start = Math.max(0, end - 4)
    const decoded = decodeWeiboBase62(mblogid.slice(start, end))
    chunks.unshift(start === 0 ? decoded : decoded.padStart(7, '0'))
  }
  return chunks.join('')
}

function decodeWeiboBase62(value: string) {
  let result = 0n
  for (const char of value) {
    const digit = WEIBO_BASE62.indexOf(char)
    if (digit < 0) return value
    result = result * 62n + BigInt(digit)
  }
  return result.toString()
}

function isValidWeiboStatus(data: any) {
  if (!data || typeof data !== 'object') return false
  if (data.idstr || data.mid) return true
  if (data.user || data.text || data.text_raw || data.page_info || data.pic_infos) return true
  return false
}

function extractImageUrls(data: any) {
  const urls: string[] = []
  const picInfos = data?.pic_infos && typeof data.pic_infos === 'object' ? Object.values(data.pic_infos) : []
  for (const pic of picInfos as any[]) {
    const url = pic?.original?.url || pic?.large?.url || pic?.url
    if (url) urls.push(normalizeProtocol(url))
  }
  for (const pic of Array.isArray(data?.pics) ? data.pics : []) {
    const url = pic?.large?.url || pic?.url || pic?.pic_big
    if (url) urls.push(normalizeProtocol(url))
  }
  return urls
}

function extractLivePhotoUrls(data: any) {
  const urls: string[] = []
  const picInfos = data?.pic_infos && typeof data.pic_infos === 'object' ? Object.values(data.pic_infos) : []
  for (const pic of picInfos as any[]) {
    if (pic?.video) urls.push(normalizeProtocol(pic.video))
  }
  return urls
}

function normalizeProtocol(url: string) {
  if (!url) return ''
  return url.startsWith('//') ? `https:${url}` : url
}

function firstValue(value: unknown) {
  if (!value || typeof value !== 'object') return ''
  return String(Object.values(value)[0] || '')
}

function rememberSetCookie(response: Response) {
  if (!response.headers) return
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : [])
  if (!values.length) return
  weiboCookie = mergeCookies(weiboCookie, values.map((value) => value.split(';')[0]).join('; '))
}

function mergeCookies(base: string, next: string) {
  const map = new Map<string, string>()
  for (const source of [base, next]) {
    for (const part of source.split(';')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const index = trimmed.indexOf('=')
      if (index <= 0) continue
      map.set(trimmed.slice(0, index), trimmed.slice(index + 1))
    }
  }
  return [...map].map(([key, value]) => `${key}=${value}`).join('; ')
}

function extractCookie(cookie: string, name: string) {
  return cookie.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
