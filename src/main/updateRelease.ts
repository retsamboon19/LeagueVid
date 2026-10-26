const REPOSITORY = 'retsamboon19/LeagueVid'
const RELEASE_ROOT = `https://github.com/${REPOSITORY}/releases`
const API_ROOT = `https://api.github.com/repos/${REPOSITORY}`
export const UPDATE_USER_AGENT = 'LeagueVid-updater'

export interface ReleaseAsset {
  name: string
  size: number
  updated_at: string
  browser_download_url: string
}

interface GithubRelease {
  name: string | null
  tag_name: string
  body: string | null
  published_at: string
  html_url: string
  assets: ReleaseAsset[]
}

export interface ResolvedRelease {
  release: GithubRelease
  version: string
  commitSha: string
  installer: ReleaseAsset
  checksum: ReleaseAsset
}

export function validateDownloadUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || ![
    'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'
  ].includes(url.hostname)) {
    throw new Error('GitHub redirected the update download to an unexpected server.')
  }
}

function parseVersion(tag: string): string {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag)
  if (!match) throw new Error(`GitHub published an unsupported release tag: ${tag}`)
  return match[1]
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? entity
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

/** Read only metadata from GitHub's own release page; never execute its HTML. */
export function parsePublicRelease(url: string, html: string): Omit<ResolvedRelease, 'installer' | 'checksum'> {
  const location = new URL(url)
  const prefix = `/${REPOSITORY}/releases/tag/`
  if (location.origin !== 'https://github.com' || location.username || location.password || !location.pathname.startsWith(prefix)) {
    throw new Error('GitHub returned an unexpected release page.')
  }
  const tag = location.pathname.slice(prefix.length)
  const version = parseVersion(tag)
  const commitSha = /href=["']\/retsamboon19\/LeagueVid\/commit\/([a-f0-9]{40})["']/i.exec(html)?.[1]
  const publishedAt = /<relative-time\b[^>]*datetime=["']([^"']+)["']/i.exec(html)?.[1]
  if (!commitSha || !publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error('Could not read GitHub release details. Please try again later.')
  }
  const title = /<title>Release ([\s\S]*?) · retsamboon19\/LeagueVid · GitHub<\/title>/i.exec(html)?.[1]
  const notes = /<div\b[^>]*data-test-selector=["']body-content["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
  const body = notes ? decodeHtml(notes
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|ul|ol|h[1-6])\s*>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim() : null
  return {
    version, commitSha,
    release: {
      tag_name: tag, name: title ? decodeHtml(title).trim() : `LeagueVid ${tag}`,
      body, published_at: publishedAt, html_url: `${RELEASE_ROOT}/tag/${tag}`, assets: []
    }
  }
}

class GithubHttpError extends Error {
  constructor(readonly response: Response) {
    super(`GitHub returned ${response.status} while checking for updates.`)
  }
}

/** Reuse a successful check during installation and coalesce repeated clicks. */
export function createReleaseResolver(fetcher: typeof fetch = fetch, now = Date.now): () => Promise<ResolvedRelease> {
  let cached: { release: ResolvedRelease; expiresAt: number } | null = null
  let pending: Promise<ResolvedRelease> | null = null
  let apiRetryAt = 0

  async function request(url: string, api = false, method = 'GET'): Promise<Response> {
    const response = await fetcher(url, {
      method,
      headers: api ? {
        Accept: 'application/vnd.github+json', 'User-Agent': UPDATE_USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28'
      } : { Accept: '*/*', 'User-Agent': UPDATE_USER_AGENT },
      signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) throw new GithubHttpError(response)
    return response
  }

  async function fromApi(): Promise<ResolvedRelease> {
    const release = await (await request(`${API_ROOT}/releases/latest`, true)).json() as GithubRelease
    const version = parseVersion(release.tag_name)
    const name = `LeagueVid.Setup.${version}.exe`
    const installer = release.assets.find(asset => asset.name === name)
    const checksum = release.assets.find(asset => asset.name === `${name}.sha256`)
    if (!installer || !checksum) {
      throw new Error('The update is missing its installer or security checksum. Please wait for the release to finish.')
    }
    for (const asset of [installer, checksum]) {
      if (asset.browser_download_url !== `${RELEASE_ROOT}/download/${release.tag_name}/${asset.name}`) {
        throw new Error('GitHub returned an unexpected release asset URL.')
      }
    }
    const ref = await request(`${API_ROOT}/git/ref/tags/${encodeURIComponent(release.tag_name)}`, true)
    let object = await ref.json() as { object?: { type?: string; sha?: string; url?: string } }
    for (let depth = 0; depth < 3; depth++) {
      const target = object.object
      if (!target?.sha || !/^[a-f0-9]{40}$/i.test(target.sha)) throw new Error('GitHub returned an invalid release tag.')
      if (target.type === 'commit') return { release, version, commitSha: target.sha, installer, checksum }
      if (target.type !== 'tag' || target.url !== `${API_ROOT}/git/tags/${target.sha}`) {
        throw new Error('GitHub returned an unsupported release tag.')
      }
      object = await (await request(target.url, true)).json() as typeof object
    }
    throw new Error('The GitHub release tag points through too many nested tags.')
  }

  async function fromPublicPage(): Promise<ResolvedRelease> {
    const page = await request(`${RELEASE_ROOT}/latest`)
    const metadata = parsePublicRelease(page.url, await page.text())
    const name = `LeagueVid.Setup.${metadata.version}.exe`
    const assetUrl = `${RELEASE_ROOT}/download/${metadata.release.tag_name}/${name}`
    // HEAD obtains the real byte length without downloading the installer.
    // Require both assets before presenting a release that is still uploading.
    const installerHead = await request(assetUrl, false, 'HEAD')
    validateDownloadUrl(installerHead.url)
    const size = Number(installerHead.headers.get('content-length'))
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('GitHub did not provide the installer size. Please try again later.')
    const checksumHead = await request(`${assetUrl}.sha256`, false, 'HEAD')
    validateDownloadUrl(checksumHead.url)
    const installer = { name, size, updated_at: metadata.release.published_at, browser_download_url: assetUrl }
    const checksum = { ...installer, name: `${name}.sha256`, size: Number(checksumHead.headers.get('content-length')) || 0, browser_download_url: `${assetUrl}.sha256` }
    return { ...metadata, release: { ...metadata.release, assets: [installer, checksum] }, installer, checksum }
  }

  async function resolve(): Promise<ResolvedRelease> {
    if (now() >= apiRetryAt) {
      try { return await fromApi() } catch (error) {
        if (!(error instanceof GithubHttpError) || ![403, 429].includes(error.response.status)) throw error
        const reset = Number(error.response.headers.get('x-ratelimit-reset')) * 1000
        const retrySeconds = Number(error.response.headers.get('retry-after'))
        apiRetryAt = Math.max(reset || 0, now() + Math.max(60000, retrySeconds * 1000 || 0))
      }
    }
    return fromPublicPage()
  }

  return () => {
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.release)
    if (!pending) {
      pending = resolve().then(release => {
        cached = { release, expiresAt: now() + 60000 }
        return release
      }).finally(() => { pending = null })
    }
    return pending
  }
}
