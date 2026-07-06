import { h } from 'koishi'

export interface XhsConfigLike {
  userAgent: string
  timeout: number
  imageFormat: 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | 'auto'
  showVideo: boolean
  showImages: boolean
  maxImages: number
  maxDescLength: number
  descTruncateSuffix: string
  showStats: boolean
  showLink: boolean
  cookie?: string
}

export interface XhsNote {
  id: string
  url: string
  title: string
  desc: string
  type: 'video' | 'normal' | 'unknown'
  authorName: string
  authorId: string
  likedCount?: string | number
  collectedCount?: string | number
  commentCount?: string | number
  shareCount?: string | number
  imageUrls: string[]
  videoUrls: string[]
  videoBuffer?: Buffer
  videoMimeType?: string
  videoSkippedMessage?: string
}

const URL_BOUNDARY = '[^\\s"\'<>\\\\^`{|}，。；！？、【】《》]+'
const LINK_PATTERNS = [
  new RegExp(`https?://www\\.xiaohongshu\\.com/explore/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://www\\.xiaohongshu\\.com/discovery/item/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`https?://xhslink\\.com/${URL_BOUNDARY}`, 'gi'),
  new RegExp(`http://xhslink\\.com/${URL_BOUNDARY}`, 'gi'),
]

const DEFAULT_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  referer: 'https://www.xiaohongshu.com/explore',
}

export function extractXhsLinks(content: string): string[] {
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

export async function resolveXhsLink(rawUrl: string, config: XhsConfigLike): Promise<string> {
  const url = ensureProtocol(rawUrl)
  if (!/xhslink\.com/i.test(url)) return url

  const response = await fetchWithTimeout(url, config, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (location) return new URL(location, url).toString()

  if (response.status >= 300 && response.status < 400) return url

  const followed = await fetchWithTimeout(url, config, { redirect: 'follow' })
  return followed.url || url
}

export async function fetchXhsNote(rawUrl: string, config: XhsConfigLike): Promise<XhsNote> {
  const url = await resolveXhsLink(rawUrl, config)
  const html = await fetchText(url, config)
  const data = extractInitialStateNote(html)

  if (!data) {
    throw new Error('未能从页面中读取小红书笔记数据。可能需要 Cookie，或链接已失效。')
  }

  return buildNote(data, url, config)
}

export function buildXhsMessages(note: XhsNote, config: XhsConfigLike, session?: { userId?: string, username?: string, author?: { nickname?: string } }) {
  const messages: h[] = []
  const text = formatNoteText(note, config)

  messages.push(h('message', {
    userId: session?.userId,
    nickname: session?.author?.nickname || session?.username,
  }, h.text(text)))

  if (config.showImages) {
    for (const imageUrl of note.imageUrls.slice(0, config.maxImages)) {
      messages.push(h('message', {
        userId: session?.userId,
        nickname: session?.author?.nickname || session?.username,
      }, h.image(imageUrl)))
    }
  }

  if (config.showVideo) {
    if (note.videoBuffer) {
      messages.push(h('message', {
        userId: session?.userId,
        nickname: session?.author?.nickname || session?.username,
      }, h.video(note.videoBuffer, note.videoMimeType || 'video/mp4')))
    }

    for (const videoUrl of note.videoUrls.slice(0, 1)) {
      messages.push(h('message', {
        userId: session?.userId,
        nickname: session?.author?.nickname || session?.username,
      }, h.video(videoUrl)))
    }
  }

  if (note.videoSkippedMessage) {
    messages.push(h('message', {
      userId: session?.userId,
      nickname: session?.author?.nickname || session?.username,
    }, h.text(note.videoSkippedMessage)))
  }

  return messages
}

export function extractInitialStateNote(html: string): any | null {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .reverse()

  const script = scripts.find((item) => item.startsWith('window.__INITIAL_STATE__='))
  if (!script) return null

  const payload = script
    .replace(/^window\.__INITIAL_STATE__=/, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

  const state = parseLooseObject(payload)
  return deepGet(state, ['noteData', 'data', 'noteData'])
    || getFirstNoteFromDetailMap(deepGet(state, ['note', 'noteDetailMap']))
    || null
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

async function fetchText(url: string, config: XhsConfigLike) {
  const response = await fetchWithTimeout(url, config, { redirect: 'follow' })
  if (!response.ok) throw new Error(`请求小红书页面失败：HTTP ${response.status}`)
  return response.text()
}

async function fetchWithTimeout(url: string, config: XhsConfigLike, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout * 1000)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...DEFAULT_HEADERS,
        'user-agent': config.userAgent,
        ...(config.cookie ? { cookie: config.cookie } : {}),
        ...(init.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

function sanitizeJsonPayload(payload: string): string {
  // The XHS __INITIAL_STATE__ is JavaScript, not JSON — it may contain
  // literal undefined / NaN / Infinity which are not valid JSON tokens.
  // Replace value-positions of these literals with null so JSON.parse succeeds.
  return payload
    .replace(/(?<=[:\[,{]\s*)undefined(?=\s*[,\]}\n])/g, 'null')
    .replace(/(?<=[:\[,{]\s*)NaN(?=\s*[,\]}\n])/g, 'null')
    .replace(/(?<=[:\[,{]\s*)Infinity(?=\s*[,\]}\n])/g, 'null')
}

function parseLooseObject(payload: string) {
  return JSON.parse(sanitizeJsonPayload(payload))
}

function getFirstNoteFromDetailMap(map: unknown) {
  if (!map || typeof map !== 'object') return null
  const first = Object.values(map)[0] as any
  return first?.note || null
}

function buildNote(data: any, url: string, config: XhsConfigLike): XhsNote {
  const id = get(data, 'noteId') || extractIdFromUrl(url)
  const type = normalizeType(get(data, 'type'))

  return {
    id,
    url: id ? `https://www.xiaohongshu.com/explore/${id}` : url,
    title: get(data, 'title') || '小红书笔记',
    desc: get(data, 'desc') || '',
    type,
    authorName: get(data, 'user.nickname') || get(data, 'user.nickName') || '未知作者',
    authorId: get(data, 'user.userId') || '',
    likedCount: get(data, 'interactInfo.likedCount'),
    collectedCount: get(data, 'interactInfo.collectedCount'),
    commentCount: get(data, 'interactInfo.commentCount'),
    shareCount: get(data, 'interactInfo.shareCount'),
    imageUrls: extractImageUrls(data, config.imageFormat),
    videoUrls: extractVideoUrls(data),
  }
}

function formatNoteText(note: XhsNote, config: XhsConfigLike) {
  const lines = [
    `小红书：${note.title}`,
    `作者：${note.authorName}`,
  ]

  if (note.desc && config.maxDescLength > 0) {
    lines.push(trimText(note.desc, config.maxDescLength, config.descTruncateSuffix))
  }
  if (config.showStats) {
    lines.push(`点赞：${displayCount(note.likedCount)}  收藏：${displayCount(note.collectedCount)}  评论：${displayCount(note.commentCount)}  分享：${displayCount(note.shareCount)}`)
  }
  if (config.showLink) lines.push(note.url)

  return lines.join('\n')
}

function extractImageUrls(data: any, format: XhsConfigLike['imageFormat']) {
  const images = Array.isArray(data?.imageList) ? data.imageList : []
  const urls: string[] = []

  for (const image of images) {
    const source = image?.urlDefault || image?.url
    if (!source || typeof source !== 'string') continue

    const token = extractImageToken(source)
    if (!token) continue
    urls.push(format === 'auto'
      ? `https://sns-img-bd.xhscdn.com/${token}`
      : `https://ci.xiaohongshu.com/${token}?imageView2/format/${format}`)
  }

  return [...new Set(urls)]
}

function extractImageToken(url: string) {
  try {
    const parsed = new URL(url.replace(/\\u002F/g, '/'))
    return parsed.pathname.split('/').slice(3).join('/').split('!')[0]
  } catch {
    return url.split('/').slice(5).join('/').split('!')[0]
  }
}

function extractVideoUrls(data: any) {
  const originVideoKey = get(data, 'video.consumer.originVideoKey')
  if (originVideoKey) return [`https://sns-video-bd.xhscdn.com/${originVideoKey}`]

  const streams = [
    ...(get(data, 'video.media.stream.h265') || []),
    ...(get(data, 'video.media.stream.h264') || []),
  ].filter(Boolean)

  streams.sort((a, b) => (a.height || 0) - (b.height || 0))
  const best = streams[streams.length - 1]
  return best?.backupUrls?.[0] ? [best.backupUrls[0]] : best?.masterUrl ? [best.masterUrl] : []
}

function normalizeType(type: unknown): XhsNote['type'] {
  if (type === 'video') return 'video'
  if (type === 'normal') return 'normal'
  return 'unknown'
}

function get(source: any, path: string) {
  return deepGet(source, path.split('.'))
}

function deepGet(source: any, path: string[]) {
  let cursor = source
  for (const key of path) {
    if (cursor == null) return undefined
    cursor = cursor[key]
  }
  return cursor
}

function extractIdFromUrl(url: string) {
  return url.match(/\/(?:explore|item)\/([^/?#]+)/)?.[1] || ''
}

function trimText(text: string, maxLength: number, suffix: string) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}${suffix}` : text
}

function displayCount(value: unknown) {
  return value == null || value === '' ? '-' : String(value)
}
