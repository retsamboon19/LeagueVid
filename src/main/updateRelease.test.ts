import { describe, expect, it, vi } from 'vitest'
import { createReleaseResolver, parsePublicRelease, validateDownloadUrl } from './updateRelease'

const sha = 'e594c415746b39dcd0581719e5d1844d9f9f20d6'
const tagSha = '1203af8f1e6bfd6998ae2aa7cb6e4313122d5476'
const root = 'https://github.com/retsamboon19/LeagueVid/releases'
const api = 'https://api.github.com/repos/retsamboon19/LeagueVid'
const pageUrl = `${root}/tag/v0.3.11`
const assetUrl = `${root}/download/v0.3.11/LeagueVid.Setup.0.3.11.exe`
const page = `<title>Release LeagueVid v0.3.11 — Audio &amp; updates · retsamboon19/LeagueVid · GitHub</title>
<relative-time class="no-wrap" datetime="2026-10-26T07:44:25Z"></relative-time>
<a href="/retsamboon19/LeagueVid/commit/${sha}">Commit</a>
<div data-pjax="true" data-test-selector="body-content" class="markdown-body"><p>Record PC audio.</p>
<ul><li>Choose speakers &amp; headphones.</li><li>Keep &lt;all&gt; tracks.</li></ul></div>`

function response(body: string, url: string, status = 200, headers: Record<string, string> = {}): Response {
  const result = new Response(body, { status, headers })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

function publicResponses() {
  return [
    response(page, pageUrl),
    response('', 'https://release-assets.githubusercontent.com/installer', 200, { 'content-length': '112898838' }),
    response('', 'https://release-assets.githubusercontent.com/checksum', 200, { 'content-length': '92' })
  ]
}

function fetchSequence(responses: Response[]) {
  return vi.fn(async () => {
    const result = responses.shift()
    if (!result) throw new Error('Unexpected request')
    return result
  }) as ReturnType<typeof vi.fn> & typeof fetch
}

describe('public GitHub release metadata', () => {
  it('reads the version, full commit, date and readable notes from a release page', () => {
    expect(parsePublicRelease(pageUrl, page)).toMatchObject({
      version: '0.3.11', commitSha: sha,
      release: { name: 'LeagueVid v0.3.11 — Audio & updates', published_at: '2026-10-26T07:44:25Z' }
    })
    expect(parsePublicRelease(pageUrl, page).release.body).toContain('- Keep <all> tracks.')
  })

  it('rejects unexpected hosts, repositories and malformed release versions', () => {
    for (const url of ['https://example.com/releases/tag/v0.3.11',
      'https://github.com/other/project/releases/tag/v0.3.11', `${root}/tag/../../file`, `${root}/tag/v0.3.11-rc1`]) {
      expect(() => parsePublicRelease(url, page)).toThrow()
    }
  })

  it('fails clearly if the public page shape changes instead of guessing a commit', () => {
    expect(() => parsePublicRelease(pageUrl, '<html>Unavailable</html>')).toThrow('Could not read')
  })

  it('accepts only HTTPS GitHub asset hosts', () => {
    expect(() => validateDownloadUrl('https://release-assets.githubusercontent.com/file')).not.toThrow()
    for (const url of ['http://github.com/file', 'https://github.com.evil.test/file', 'https://user:pass@github.com/file']) {
      expect(() => validateDownloadUrl(url)).toThrow()
    }
  })
})

describe('release discovery', () => {
  it.each([403, 429])('checks and prepares the public installer when the API returns %i', async status => {
    const fetcher = fetchSequence([response('', `${api}/releases/latest`, status), ...publicResponses()])
    const release = await createReleaseResolver(fetcher)()
    expect(release.version).toBe('0.3.11')
    expect(release.commitSha).toBe(sha)
    expect(release.installer).toMatchObject({ size: 112898838, browser_download_url: assetUrl })
    expect(release.checksum.browser_download_url).toBe(`${assetUrl}.sha256`)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `${api}/releases/latest`, `${root}/latest`, assetUrl, `${assetUrl}.sha256`
    ])
    expect(fetcher.mock.calls[2][1].method).toBe('HEAD')
    expect(fetcher.mock.calls[2][1].headers).not.toHaveProperty('X-GitHub-Api-Version')
  })

  it('coalesces concurrent checks and reuses the result for installation', async () => {
    const fetcher = fetchSequence([response('', `${api}/releases/latest`, 403), ...publicResponses()])
    const resolve = createReleaseResolver(fetcher)
    const [first, second] = await Promise.all([resolve(), resolve()])
    expect(first).toBe(second)
    expect(await resolve()).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('does not hit the blocked API again before its reset time', async () => {
    let now = 1000000
    const fetcher = fetchSequence([
      response('', `${api}/releases/latest`, 403, { 'x-ratelimit-reset': '4600' }),
      ...publicResponses(), ...publicResponses()
    ])
    const resolve = createReleaseResolver(fetcher, () => now)
    await resolve()
    now += 61000
    await resolve()
    expect(fetcher.mock.calls.filter(call => String(call[0]).startsWith(api))).toHaveLength(1)
  })

  it('refuses a release whose checksum has not finished uploading', async () => {
    const [html, installer] = publicResponses()
    const fetcher = fetchSequence([response('', `${api}/releases/latest`, 403), html, installer,
      response('', `${assetUrl}.sha256`, 404)])
    await expect(createReleaseResolver(fetcher)()).rejects.toThrow('404')
  })

  it('refuses asset redirects outside GitHub', async () => {
    const fetcher = fetchSequence([response('', `${api}/releases/latest`, 403), response(page, pageUrl),
      response('', 'https://example.com/installer', 200, { 'content-length': '1000' })])
    await expect(createReleaseResolver(fetcher)()).rejects.toThrow('unexpected server')
  })

  it('continues to resolve annotated tags through the API when available', async () => {
    const assets = ['LeagueVid.Setup.0.3.11.exe', 'LeagueVid.Setup.0.3.11.exe.sha256'].map(name => ({
      name, size: 100, updated_at: '2026-10-26T07:44:25Z', browser_download_url: `${root}/download/v0.3.11/${name}`
    }))
    const fetcher = fetchSequence([
      response(JSON.stringify({ tag_name: 'v0.3.11', assets }), `${api}/releases/latest`),
      response(JSON.stringify({ object: { type: 'tag', sha: tagSha, url: `${api}/git/tags/${tagSha}` } }), `${api}/git/ref/tags/v0.3.11`),
      response(JSON.stringify({ object: { type: 'commit', sha } }), `${api}/git/tags/${tagSha}`)
    ])
    expect((await createReleaseResolver(fetcher)()).commitSha).toBe(sha)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('falls back if the limit is reached partway through API tag resolution', async () => {
    const name = 'LeagueVid.Setup.0.3.11.exe'
    const fetcher = fetchSequence([
      response(JSON.stringify({ tag_name: 'v0.3.11', assets: [name, `${name}.sha256`].map(n => ({
        name: n, browser_download_url: `${root}/download/v0.3.11/${n}`
      })) }), `${api}/releases/latest`),
      response('', `${api}/git/ref/tags/v0.3.11`, 403), ...publicResponses()
    ])
    expect((await createReleaseResolver(fetcher)()).commitSha).toBe(sha)
  })
})
