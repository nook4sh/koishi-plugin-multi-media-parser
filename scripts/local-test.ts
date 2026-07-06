import {
  extractDouyinLinks,
  extractXhsLinks,
  fetchDouyinPost,
  fetchXhsNote,
} from '../src'

const input = process.argv.slice(2).join(' ')
if (!input) {
  console.error('Usage: npm run dev -- <xhs-or-douyin-link>')
  process.exit(1)
}

const common = {
  showVideo: true,
  showImages: true,
  maxImages: 9,
  maxDescLength: 160,
  descTruncateSuffix: '...(已截断)',
  showLink: true,
}

async function main() {
  const xhs = extractXhsLinks(input)[0]
  if (xhs) {
    const note = await fetchXhsNote(xhs, {
      ...common,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      timeout: 15,
      imageFormat: 'jpeg',
      showStats: true,
    })
    console.log(JSON.stringify(note, null, 2))
    return
  }

  const douyin = extractDouyinLinks(input)[0]
  if (douyin) {
    const post = await fetchDouyinPost(douyin, {
      ...common,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      timeout: 15,
      showAuthor: true,
    })
    console.log(JSON.stringify(post, null, 2))
    return
  }

  throw new Error('No supported link found.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
