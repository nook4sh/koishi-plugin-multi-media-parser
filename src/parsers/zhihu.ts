import crypto from 'node:crypto'
import { h } from 'koishi'
import {
  cleanUrl,
  expandTextCandidates,
  fetchWithTimeout,
  formatCount,
  normalizeText,
  ParserConfigLike,
  stripHtml,
  trimText,
  unique,
  URL_BOUNDARY,
} from './common'

export interface ZhihuConfigLike extends ParserConfigLike {
  showAuthor: boolean
  showStats: boolean
}

export interface ZhihuPost {
  id: string
  url: string
  title: string
  desc: string
  type: 'question' | 'answer' | 'article'
  authorName: string
  authorId?: string
  likedCount?: string | number
  commentCount?: string | number
  collectCount?: string | number
  viewCount?: string | number
  imageUrls: string[]
  videoUrls: string[]
  videoBuffer?: Buffer
  videoMimeType?: string
  videoSkippedMessage?: string
}

const LINK_PATTERNS = [
  new RegExp(`https?://(?:www\\.)?zhihu\\.com/question/\\d+/answer/\\d+${URL_BOUNDARY}?`, 'gi'),
  new RegExp(`https?://(?:www\\.)?zhihu\\.com/question/\\d+${URL_BOUNDARY}?`, 'gi'),
  new RegExp(`https?://zhuanlan\\.zhihu\\.com/p/\\d+${URL_BOUNDARY}?`, 'gi'),
]

const ZHIHU_HEADERS = {
  accept: 'application/json,text/plain,*/*',
  referer: 'https://www.zhihu.com/',
}

const ZHIHU_MOBILE_HEADERS = {
  accept: 'application/json,text/plain,*/*',
  'user-agent': 'osee2unifiedRelease/7.33.0 (iPhone; iOS 18.5; Scale/3.00)',
  'x-api-version': '3.0.91',
  'x-app-version': '7.33.0',
}

export function extractZhihuLinks(content: string): string[] {
  const matches: Array<{ index: number, url: string }> = []
  for (const candidate of expandTextCandidates(content)) {
    const normalized = normalizeText(candidate)
    for (const pattern of LINK_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(normalized))) {
        const suffix = normalized.slice(match.index + match[0].length)
        let url = cleanUrl(match[0])
        if (/zhihu\.com\/question\/\d+\/?$/i.test(url) && (suffix.startsWith('/answer/') || suffix.startsWith('answer/'))) {
          continue
        }
        url = url.replace(/(zhihu\.com\/question\/\d+)\/$/i, '$1')
        matches.push({ index: match.index, url })
      }
    }
  }

  const seen = new Set<string>()
  return matches
    .sort((a, b) => a.index - b.index || b.url.length - a.url.length)
    .filter((match) => {
      if (seen.has(match.url)) return false
      seen.add(match.url)
      return true
    })
    .map((match) => match.url)
}

export function createZhihuZse96(url: string, dc0 = '', zse93 = '101_3_3.0') {
  const parsed = new URL(url)
  const pathname = `${parsed.pathname}${parsed.search}`
  const signSource = [zse93, pathname, dc0].join('+')
  const md5 = crypto.createHash('md5').update(signSource).digest('hex')
  return `2.0_${encryptZseV4(md5)}`
}

export async function fetchZhihuPost(rawUrl: string, config: ZhihuConfigLike): Promise<ZhihuPost> {
  const answerId = rawUrl.match(/\/answer\/(\d+)/)?.[1]
  if (answerId) return fetchAnswer(answerId, config)

  const articleId = rawUrl.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/)?.[1]
  if (articleId) return fetchArticle(articleId, config)

  const questionId = rawUrl.match(/zhihu\.com\/question\/(\d+)/)?.[1]
  if (questionId) return fetchQuestion(questionId, config)

  throw new Error('未能识别知乎链接。')
}

export function buildZhihuMessages(post: ZhihuPost, config: ZhihuConfigLike, session?: { userId?: string, username?: string, author?: { nickname?: string } }) {
  const messages: h[] = []
  const attrs = {
    userId: session?.userId,
    nickname: session?.author?.nickname || session?.username,
  }

  messages.push(h('message', attrs, h.text(formatZhihuText(post, config))))

  if (config.showImages) {
    for (const imageUrl of post.imageUrls.slice(0, config.maxImages)) {
      messages.push(h('message', attrs, h.image(imageUrl)))
    }
  }

  if (config.showVideo) {
    if (post.videoBuffer) messages.push(h('message', attrs, h.video(post.videoBuffer, post.videoMimeType || 'video/mp4')))
    for (const videoUrl of post.videoUrls.slice(0, 1)) messages.push(h('message', attrs, h.video(videoUrl)))
  }

  if (post.videoSkippedMessage) messages.push(h('message', attrs, h.text(post.videoSkippedMessage)))

  return messages
}

async function fetchQuestion(id: string, config: ZhihuConfigLike): Promise<ZhihuPost> {
  const data = await fetchZhihuJson(`https://www.zhihu.com/api/v4/questions/${id}?include=read_count,visit_count,answer_count,voteup_count,comment_count,follower_count,detail,excerpt,author,relationship.is_following,topics`, config)
  const content = String(data?.detail || data?.excerpt || '')
  return {
    id,
    url: `https://www.zhihu.com/question/${id}`,
    title: String(data?.title || '知乎问题'),
    desc: stripHtml(content),
    type: 'question',
    authorName: String(data?.author?.name || '未知作者'),
    authorId: String(data?.author?.url_token || ''),
    likedCount: data?.voteup_count,
    commentCount: data?.comment_count,
    viewCount: data?.visit_count || data?.read_count,
    imageUrls: unique(extractImageUrls(content)),
    videoUrls: [],
  }
}

async function fetchAnswer(id: string, config: ZhihuConfigLike): Promise<ZhihuPost> {
  const data = await fetchZhihuJson(`https://www.zhihu.com/api/v4/answers/${id}?include=content,paid_info,can_comment,excerpt,thanks_count,voteup_count,comment_count,visited_count,attachment,reaction,ip_info,pagination_info,question.topics,reaction.relation.voting,author.badge_v2`, config)
  const stats = data?.reaction?.statistics || {}
  const content = String(data?.content || data?.excerpt || '')
  return {
    id,
    url: `https://www.zhihu.com/question/${data?.question?.id || ''}/answer/${id}`,
    title: String(data?.question?.title || '知乎回答'),
    desc: stripHtml(content),
    type: 'answer',
    authorName: String(data?.author?.name || '未知作者'),
    authorId: String(data?.author?.url_token || ''),
    likedCount: stats.like_count ?? data?.voteup_count,
    commentCount: stats.comment_count ?? data?.comment_count,
    collectCount: stats.favorites,
    viewCount: data?.visited_count,
    imageUrls: unique(extractImageUrls(content)),
    videoUrls: [],
  }
}

async function fetchArticle(id: string, config: ZhihuConfigLike): Promise<ZhihuPost> {
  const data = await fetchZhihuJson(`https://www.zhihu.com/api/v4/articles/${id}?include=content,topics,paid_info,can_comment,excerpt,thanks_count,voteup_count,comment_count,visited_count,relationship,ip_info,relationship.vote,author.badge_v2`, config)
  const stats = data?.reaction?.statistics || {}
  const content = String(data?.content || data?.excerpt || '')
  return {
    id,
    url: `https://zhuanlan.zhihu.com/p/${id}`,
    title: String(data?.title || '知乎专栏'),
    desc: stripHtml(content),
    type: 'article',
    authorName: String(data?.author?.name || '未知作者'),
    authorId: String(data?.author?.url_token || ''),
    likedCount: stats.like_count,
    commentCount: stats.comment_count,
    collectCount: stats.favorites,
    imageUrls: unique(extractImageUrls(content)),
    videoUrls: [],
  }
}

async function fetchZhihuJson(url: string, config: ZhihuConfigLike) {
  const response = await fetchWithTimeout(url, config, {
    headers: {
      ...ZHIHU_HEADERS,
      ...signZhihuFetchRequest(url),
    },
  })
  if (response.ok) return response.json()

  const mobile = await fetchWithTimeout(url, config, {
    headers: ZHIHU_MOBILE_HEADERS,
  })
  if (mobile.ok) return mobile.json()

  throw new Error(`请求知乎接口失败：HTTP ${response.status}；移动端接口 HTTP ${mobile.status}`)
}

function formatZhihuText(post: ZhihuPost, config: ZhihuConfigLike) {
  const label = post.type === 'article' ? '知乎专栏' : post.type === 'answer' ? '知乎回答' : '知乎问题'
  const lines = [`${label}：${post.title || label}`]
  if (config.showAuthor) lines.push(`作者：${post.authorName}`)
  if (post.desc && config.maxDescLength > 0) lines.push(trimText(post.desc, config.maxDescLength, config.descTruncateSuffix))
  if (config.showStats) {
    lines.push(`赞同/喜欢：${formatCount(post.likedCount)}  评论：${formatCount(post.commentCount)}  收藏：${formatCount(post.collectCount)}  浏览：${formatCount(post.viewCount)}`)
  }
  if (config.showLink) lines.push(post.url)
  return lines.join('\n')
}

function extractImageUrls(html: string) {
  const urls: string[] = []
  for (const match of html.matchAll(/<img[^>]+(?:data-original|data-actualsrc|data-default-watermark-src|src)=["']([^"']+)["']/gi)) {
    urls.push(match[1])
  }
  return urls
}

function signZhihuFetchRequest(url: string, dc0 = '', zse93 = '101_3_3.0') {
  return {
    'x-zse-93': zse93,
    'x-zse-96': createZhihuZse96(url, dc0, zse93),
    'x-requested-with': 'fetch',
  }
}

const ALPHABET = '6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE'
const KEY16 = Buffer.from('059053f7d15e01d7')
const ZK = [1170614578, 1024848638, 1413669199, 3951632832, 3528873006, 2921909214, 4151847688, 3997739139, 1933479194, 3323781115, 3888513386, 460404854, 3747539722, 2403641034, 2615871395, 2119585428, 2265697227, 2035090028, 2773447226, 4289380121, 4217216195, 2200601443, 3051914490, 1579901135, 1321810770, 456816404, 2903323407, 4065664991, 330002838, 3506006750, 363569021, 2347096187]
const ZB = [20, 223, 245, 7, 248, 2, 194, 209, 87, 6, 227, 253, 240, 128, 222, 91, 237, 9, 125, 157, 230, 93, 252, 205, 90, 79, 144, 199, 159, 197, 186, 167, 39, 37, 156, 198, 38, 42, 43, 168, 217, 153, 15, 103, 80, 189, 71, 191, 97, 84, 247, 95, 36, 69, 14, 35, 12, 171, 28, 114, 178, 148, 86, 182, 32, 83, 158, 109, 22, 255, 94, 238, 151, 85, 77, 124, 254, 18, 4, 26, 123, 176, 232, 193, 131, 172, 143, 142, 150, 30, 10, 146, 162, 62, 224, 218, 196, 229, 1, 192, 213, 27, 110, 56, 231, 180, 138, 107, 242, 187, 54, 120, 19, 44, 117, 228, 215, 203, 53, 239, 251, 127, 81, 11, 133, 96, 204, 132, 41, 115, 73, 55, 249, 147, 102, 48, 122, 145, 106, 118, 74, 190, 29, 16, 174, 5, 177, 129, 63, 113, 99, 31, 161, 76, 246, 34, 211, 13, 60, 68, 207, 160, 65, 111, 82, 165, 67, 169, 225, 57, 112, 244, 155, 51, 236, 200, 233, 58, 61, 47, 100, 137, 185, 64, 17, 70, 234, 163, 219, 108, 170, 166, 59, 149, 52, 105, 24, 212, 78, 173, 45, 0, 116, 226, 119, 136, 206, 135, 175, 195, 25, 92, 121, 208, 126, 139, 3, 75, 141, 21, 130, 98, 241, 40, 154, 66, 184, 49, 181, 46, 243, 88, 101, 183, 8, 23, 72, 188, 104, 179, 210, 134, 250, 201, 164, 89, 216, 202, 220, 50, 221, 152, 140, 33, 235, 214]

function encryptZseV4(input: string) {
  const encoded = encodeURIComponent(input).replace(/'/g, '%27')
  const plain = [210, 0, ...[...encoded].map((char) => char.charCodeAt(0))]
  const pad = 16 - (plain.length % 16)
  plain.push(...Array.from({ length: pad }, () => pad))

  const first = Buffer.alloc(16)
  for (let i = 0; i < 16; i += 1) first[i] = plain[i] ^ KEY16[i] ^ 42
  const c0 = rBlock(first)
  const cipher = Buffer.alloc(plain.length)
  c0.copy(cipher, 0)

  if (plain.length > 16) xBlocks(Buffer.from(plain.slice(16)), c0).copy(cipher, 16)
  return customEncode(cipher)
}

function rBlock(input: Buffer) {
  const tr = Array.from({ length: 36 }, () => 0)
  tr[0] = input.readUInt32BE(0)
  tr[1] = input.readUInt32BE(4)
  tr[2] = input.readUInt32BE(8)
  tr[3] = input.readUInt32BE(12)
  for (let i = 0; i < 32; i += 1) {
    const ta = gTransform((tr[i + 1] ^ tr[i + 2] ^ tr[i + 3] ^ ZK[i]) >>> 0)
    tr[i + 4] = (tr[i] ^ ta) >>> 0
  }
  const out = Buffer.alloc(16)
  out.writeUInt32BE(tr[35], 0)
  out.writeUInt32BE(tr[34], 4)
  out.writeUInt32BE(tr[33], 8)
  out.writeUInt32BE(tr[32], 12)
  return out
}

function xBlocks(data: Buffer, iv0: Buffer) {
  let iv = Buffer.from(iv0)
  const out = Buffer.alloc(data.length)
  for (let off = 0; off < data.length; off += 16) {
    const mixed = Buffer.alloc(16)
    for (let i = 0; i < 16; i += 1) mixed[i] = data[off + i] ^ iv[i]
    iv = rBlock(mixed)
    iv.copy(out, off)
  }
  return out
}

function gTransform(tt: number) {
  const te0 = (tt >>> 24) & 0xff
  const te1 = (tt >>> 16) & 0xff
  const te2 = (tt >>> 8) & 0xff
  const te3 = tt & 0xff
  const ti = (((ZB[te0] & 0xff) << 24) | ((ZB[te1] & 0xff) << 16) | ((ZB[te2] & 0xff) << 8) | (ZB[te3] & 0xff)) >>> 0
  return (ti ^ rotateLeft(ti, 2) ^ rotateLeft(ti, 10) ^ rotateLeft(ti, 18) ^ rotateLeft(ti, 24)) >>> 0
}

function rotateLeft(n: number, bits: number) {
  return ((n << bits) | (n >>> (32 - bits))) >>> 0
}

function customEncode(input: Buffer) {
  let bytes = Buffer.from(input)
  const rem = bytes.length % 3
  if (rem) bytes = Buffer.concat([bytes, Buffer.alloc(3 - rem)])
  const out: string[] = []
  let i = 0
  for (let p = bytes.length - 1; p >= 0; p -= 3) {
    let v = 0
    const m0 = (58 >>> (8 * (i % 4))) & 0xff
    v |= (bytes[p] ^ m0) & 0xff
    i += 1
    const m1 = (58 >>> (8 * (i % 4))) & 0xff
    v |= ((bytes[p - 1] ^ m1) & 0xff) << 8
    i += 1
    const m2 = (58 >>> (8 * (i % 4))) & 0xff
    v |= ((bytes[p - 2] ^ m2) & 0xff) << 16
    i += 1
    out.push(ALPHABET[v & 63], ALPHABET[(v >>> 6) & 63], ALPHABET[(v >>> 12) & 63], ALPHABET[(v >>> 18) & 63])
  }
  return out.join('')
}
