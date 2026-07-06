import { h } from 'koishi'
import { formatMessageSections } from './common'

export interface DouyinConfigLike {
  userAgent: string
  timeout: number
  showVideo: boolean
  showImages: boolean
  maxImages: number
  maxDescLength: number
  descTruncateSuffix: string
  showAuthor: boolean
  showLink: boolean
  cookie?: string
}

export interface DouyinPost {
  id: string
  url: string
  title: string
  desc: string
  type: 'video' | 'note' | 'slides' | 'unknown'
  authorName: string
  authorAvatar?: string
  createTime?: number
  duration?: number
  coverUrl?: string
  imageUrls: string[]
  dynamicImageUrls: string[]
  videoUrls: string[]
  videoBuffer?: Buffer
  videoMimeType?: string
  videoSkippedMessage?: string
}

interface ParsedDouyinUrl {
  url: string
  id: string
  type: 'video' | 'note' | 'slides' | 'unknown'
}

const URL_BOUNDARY = '[^\\s"\'<>\\\\^`{|}，。；！？、【】《》]+'
const LINK_PATTERNS = [
  new RegExp(`https?://v\\.douyin\\.com/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://jx\\.douyin\\.com/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://(?:www\\.)?douyin\\.com/(?:video|note)/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://(?:www\\.)?iesdouyin\\.com/share/(?:slides|video|note)/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://m\\.douyin\\.com/share/(?:slides|video|note)/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://m\\.ixigua\\.com/douyin/share/(?:video|note)/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://jingxuan\\.douyin\\.com/m/(?:slides|video|note)/${URL_BOUNDARY}`, 'gi'),
]

const IOS_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  referer: 'https://www.douyin.com/',
}

const ANDROID_HEADERS = {
  accept: 'application/json,text/plain,*/*',
  referer: 'https://www.douyin.com/',
}

export function extractDouyinLinks(content: string): string[] {
  const candidates = expandTextCandidates(content)
  const links: string[] = []

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate)
    for (const pattern of LINK_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(normalized))) {
        links.push(cleanUrl(match[0]))
      }
    }
  }

  return [...new Set(links)]
}

export async function resolveDouyinLink(rawUrl: string, config: DouyinConfigLike): Promise<string> {
  const url = ensureProtocol(rawUrl)
  if (!/(?:v|jx)\.douyin\.com/i.test(url)) return url

  const response = await fetchWithTimeout(url, config, { redirect: 'manual', headers: IOS_HEADERS })
  const location = response.headers.get('location')
  if (location) return new URL(location, url).toString()

  if (response.status >= 300 && response.status < 400) return url

  const followed = await fetchWithTimeout(url, config, { redirect: 'follow', headers: IOS_HEADERS })
  return followed.url || url
}

export async function fetchDouyinPost(rawUrl: string, config: DouyinConfigLike): Promise<DouyinPost> {
  const resolvedUrl = await resolveDouyinLink(rawUrl, config)
  const parsed = parseDouyinUrl(resolvedUrl)
  if (!parsed.id) throw new Error('未能识别抖音作品 ID。')

  const errors: string[] = []
  if (parsed.type === 'slides') {
    try {
      const post = await fetchSlidesPost(parsed, config)
      if (hasDouyinMedia(post)) return post
      errors.push('slidesinfo: 图集接口未返回媒体数据。')
    } catch (error) {
      errors.push(`slidesinfo: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const url of buildPageCandidates(parsed)) {
    try {
      const html = await fetchText(url, config, IOS_HEADERS)
      const post = extractRouterDataPost(html, parsed, url)
      if (post) return post
      errors.push(`${url}: 未找到 _ROUTER_DATA`)
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    return await fetchSlidesPost(parsed, config)
  } catch (error) {
    errors.push(`slidesinfo: ${error instanceof Error ? error.message : String(error)}`)
  }

  throw new Error(`抖音解析失败：${errors.join('；')}`)
}

export function buildDouyinMessages(post: DouyinPost, config: DouyinConfigLike, session?: { userId?: string, username?: string, author?: { nickname?: string } }) {
  const messages: h[] = []
  const attrs = {
    userId: session?.userId,
    nickname: session?.author?.nickname || session?.username,
  }

  messages.push(h('message', attrs, h.text(formatPostText(post, config))))

  if (config.showImages) {
    for (const imageUrl of post.imageUrls.slice(0, config.maxImages)) {
      messages.push(h('message', attrs, h.image(imageUrl)))
    }
  }

  if (config.showVideo) {
    if (post.videoBuffer) {
      messages.push(h('message', attrs, h.video(post.videoBuffer, post.videoMimeType || 'video/mp4')))
    }
    for (const videoUrl of [...post.dynamicImageUrls, ...post.videoUrls].slice(0, 1)) {
      messages.push(h('message', attrs, h.video(videoUrl)))
    }
  }

  if (post.videoSkippedMessage) {
    messages.push(h('message', attrs, h.text(post.videoSkippedMessage)))
  }

  return messages
}

export function extractRouterDataPost(html: string, parsed: ParsedDouyinUrl = { id: '', type: 'unknown', url: '' }, sourceUrl = parsed.url): DouyinPost | null {
  const match = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/)
  if (!match?.[1]) return null

  const routerData = parseJsonLike(match[1].trim().replace(/;+\s*$/, ''))
  const item = firstDefined(
    deepGet(routerData, ['loaderData', 'video_(id)/page', 'videoInfoRes', 'item_list', 0]),
    deepGet(routerData, ['loaderData', 'note_(id)/page', 'videoInfoRes', 'item_list', 0]),
    deepGet(routerData, ['loaderData', 'slides_(id)/page', 'videoInfoRes', 'item_list', 0]),
  )
  if (!item) return null

  return buildPostFromAweme(item, parsed, sourceUrl)
}

function parseDouyinUrl(url: string): ParsedDouyinUrl {
  const normalized = ensureProtocol(url)
  const match = normalized.match(/(?:douyin\.com\/(?:video|note)|(?:iesdouyin|m\.douyin)\.com\/share\/(?:slides|video|note)|m\.ixigua\.com\/douyin\/share\/(?:video|note)|jingxuan\.douyin\.com\/m\/(?:slides|video|note))\/(\d+)/i)
  const typeMatch = normalized.match(/douyin\.com\/(video|note)\/\d+|(?:iesdouyin|m\.douyin)\.com\/share\/(slides|video|note)\/\d+|m\.ixigua\.com\/douyin\/share\/(video|note)\/\d+|jingxuan\.douyin\.com\/m\/(slides|video|note)\/\d+/i)
  return {
    url: normalized,
    id: match?.[1] || '',
    type: (typeMatch?.[1] || typeMatch?.[2] || typeMatch?.[3] || typeMatch?.[4] || 'unknown') as ParsedDouyinUrl['type'],
  }
}

function buildPageCandidates(parsed: ParsedDouyinUrl) {
  const type = parsed.type === 'unknown' ? 'video' : parsed.type
  const canonicalType = type === 'slides' ? 'note' : type
  return unique([
    parsed.url,
    `https://www.douyin.com/${canonicalType}/${parsed.id}`,
    `https://m.douyin.com/share/${type}/${parsed.id}`,
    `https://www.iesdouyin.com/share/${type}/${parsed.id}`,
  ])
}

function hasDouyinMedia(post: DouyinPost) {
  return post.imageUrls.length > 0 || post.dynamicImageUrls.length > 0 || post.videoUrls.length > 0
}

async function fetchSlidesPost(parsed: ParsedDouyinUrl, config: DouyinConfigLike): Promise<DouyinPost> {
  const api = new URL('https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/')
  api.searchParams.set('aweme_ids', `[${parsed.id}]`)
  api.searchParams.set('request_source', '200')

  const response = await fetchWithTimeout(api.toString(), config, { redirect: 'follow', headers: ANDROID_HEADERS })
  if (!response.ok) throw new Error(`请求抖音图集接口失败：HTTP ${response.status}`)

  const data = await response.json() as any
  const item = data?.aweme_details?.[0]
  if (!item) throw new Error('图集接口未返回作品数据。')

  return buildPostFromAweme(item, { ...parsed, type: 'slides' }, parsed.url)
}

function buildPostFromAweme(item: any, parsed: ParsedDouyinUrl, sourceUrl: string): DouyinPost {
  const video = item?.video
  const images = Array.isArray(item?.images) ? item.images : []
  const imageUrls: string[] = []
  const dynamicImageUrls: string[] = []

  for (const image of images) {
    const dynamicUrl = pickUrl(image?.video?.play_addr?.url_list)
    if (dynamicUrl) {
      dynamicImageUrls.push(removeWatermark(dynamicUrl))
      continue
    }
    const imageUrl = pickUrl(image?.url_list)
    if (imageUrl) imageUrls.push(imageUrl)
  }

  const hasImageContent = imageUrls.length > 0 || dynamicImageUrls.length > 0
  const videoUrl = hasImageContent ? undefined : pickUrl(video?.play_addr?.url_list)
  const coverUrl = pickUrl(video?.cover?.url_list)
  const avatarUrl = pickUrl(item?.author?.avatar_thumb?.url_list) || pickUrl(item?.author?.avatar_medium?.url_list)

  return {
    id: parsed.id || String(item?.aweme_id || ''),
    url: canonicalUrl(parsed, sourceUrl),
    title: String(item?.desc || '抖音作品'),
    desc: String(item?.desc || ''),
    type: parsed.type,
    authorName: String(item?.author?.nickname || '未知作者'),
    authorAvatar: avatarUrl,
    createTime: numberOrUndefined(item?.create_time),
    duration: typeof video?.duration === 'number' ? Math.round(video.duration / 1000) : undefined,
    coverUrl,
    imageUrls: unique(imageUrls),
    dynamicImageUrls: unique(dynamicImageUrls),
    videoUrls: videoUrl ? [removeWatermark(videoUrl)] : [],
  }
}

function formatPostText(post: DouyinPost, config: DouyinConfigLike) {
  return formatMessageSections([
    [
      `抖音：${post.title || '抖音作品'}`,
      config.showAuthor ? `作者：${post.authorName}` : '',
    ],
    [
      post.desc && post.desc !== post.title && config.maxDescLength > 0
        ? trimText(post.desc, config.maxDescLength, config.descTruncateSuffix)
        : '',
    ],
    [
      config.showLink ? post.url : '',
    ],
  ])
}

function expandTextCandidates(content: string): string[] {
  const values = new Set<string>([content])

  try {
    for (const element of h.parse(content)) collectElementText(element, values)
  } catch {
    // Some adapters deliver partial XML snippets; regex extraction below still handles them.
  }

  for (const match of content.matchAll(/\bdata=(?:"([^"]*)"|'([^']*)')/gi)) {
    values.add(match[1] || match[2] || '')
  }

  for (const value of [...values]) {
    const decoded = decodeHtmlEntities(value)
    values.add(decoded)
    maybeCollectJsonValues(decoded, values)
  }

  return [...values]
}

function collectElementText(element: h, values: Set<string>) {
  if (typeof element === 'string') {
    values.add(element)
    return
  }

  for (const value of Object.values(element.attrs || {})) {
    if (typeof value === 'string') values.add(value)
  }

  for (const child of element.children || []) {
    collectElementText(child as h, values)
  }
}

function maybeCollectJsonValues(text: string, values: Set<string>) {
  try {
    const json = JSON.parse(text)
    walkJson(json, values)
  } catch {
    const unescaped = text.replace(/\\"/g, '"').replace(/\\\//g, '/')
    if (unescaped !== text) values.add(unescaped)
  }
}

function walkJson(value: unknown, values: Set<string>) {
  if (typeof value === 'string') {
    values.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, values)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkJson(item, values)
  }
}

function normalizeText(text: string) {
  let value = decodeHtmlEntities(text).replace(/\\\//g, '/')
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep the original if it is only partly percent-encoded.
  }
  return value
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function cleanUrl(url: string) {
  return ensureProtocol(url)
    .replace(/[),，。；;！？!]+$/g, '')
    .replace(/&amp;/g, '&')
}

function ensureProtocol(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

async function fetchText(url: string, config: DouyinConfigLike, headers: Record<string, string>) {
  const response = await fetchWithTimeout(url, config, { redirect: 'follow', headers })
  if (!response.ok) throw new Error(`请求抖音页面失败：HTTP ${response.status}`)
  return response.text()
}

async function fetchWithTimeout(url: string, config: DouyinConfigLike, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout * 1000)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent,
        ...(config.cookie ? { cookie: config.cookie } : {}),
        ...(init.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonLike(payload: string) {
  return JSON.parse(payload.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''))
}

function deepGet(source: any, path: Array<string | number>) {
  let cursor = source
  for (const key of path) {
    if (cursor == null) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function firstDefined<T>(...values: T[]) {
  return values.find((value) => value != null)
}

function pickUrl(value: unknown) {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined
}

function removeWatermark(url: string) {
  return url.replace('playwm', 'play')
}

function canonicalUrl(parsed: ParsedDouyinUrl, fallback: string) {
  if (!parsed.id) return fallback
  const type = parsed.type === 'slides' ? 'note' : parsed.type === 'unknown' ? 'video' : parsed.type
  return `https://www.douyin.com/${type}/${parsed.id}`
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' ? value : undefined
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function trimText(text: string, maxLength: number, suffix: string) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}${suffix}` : text
}
