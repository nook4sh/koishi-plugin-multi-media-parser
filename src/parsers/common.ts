import { h } from 'koishi'

export interface ParserConfigLike {
  userAgent: string
  timeout: number
  cookie?: string
  showVideo: boolean
  showImages: boolean
  maxImages: number
  maxDescLength: number
  descTruncateSuffix: string
  showLink: boolean
}

export const URL_BOUNDARY = '[^\\s"\'<>\\\\^`{|}，。；！？、【】《》]+'

export function extractLinks(content: string, patterns: RegExp[]): string[] {
  const links: string[] = []
  for (const candidate of expandTextCandidates(content)) {
    const normalized = normalizeText(candidate)
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(normalized))) links.push(cleanUrl(match[0]))
    }
  }
  return [...new Set(links)]
}

export function expandTextCandidates(content: string): string[] {
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

  for (const child of element.children || []) collectElementText(child as h, values)
}

function maybeCollectJsonValues(text: string, values: Set<string>) {
  try {
    walkJson(JSON.parse(text), values)
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

export function normalizeText(text: string) {
  let value = decodeHtmlEntities(text).replace(/\\\//g, '/')
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep the original if it is only partly percent-encoded.
  }
  return value
}

export function decodeHtmlEntities(text: string) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function stripHtml(html: string) {
  return decodeHtmlEntities(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function cleanUrl(url: string) {
  return ensureProtocol(url)
    .replace(/[),，。；;！？!]+$/g, '')
    .replace(/&amp;/g, '&')
}

export function ensureProtocol(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

export async function fetchWithTimeout(url: string, config: ParserConfigLike, init: RequestInit = {}) {
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

export function trimText(text: string, maxLength: number, suffix: string) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}${suffix}` : text
}

export function formatCount(value: unknown) {
  if (value == null || value === '') return '-'
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  return num < 10000 ? String(num) : `${(num / 10000).toFixed(1)}万`
}

export function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}
