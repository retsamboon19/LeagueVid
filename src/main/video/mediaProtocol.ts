import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'

// Serves local video files under a custom "leaguevid-media://" scheme so the
// renderer's <video> element can load them. Plain file:// URLs get blocked
// by the browser's cross-origin media rules when the page itself is loaded
// from http://localhost (dev server) or a non-file origin.
//
// HTTP Range requests are parsed and honored manually here (rather than via
// net.fetch against file://, which does not reliably forward Range headers).
// Without proper 206/Content-Range/Accept-Ranges responses, Chromium's media
// engine treats the video as non-seekable and duration ends up Infinity/NaN.
//
// URL shape: leaguevid-media://local/<url-encoded-absolute-path>

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm'
}

function mimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function nodeStreamToWebStream(stream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(stream as Readable) as ReadableStream
}

export function registerMediaProtocol(): void {
  protocol.handle('leaguevid-media', async (request) => {
    const url = new URL(request.url)
    const encodedPath = url.pathname.replace(/^\//, '')
    const filePath = decodeURIComponent(encodedPath)

    let fileSize: number
    try {
      fileSize = statSync(filePath).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const mime = mimeType(filePath)
    const rangeHeader = request.headers.get('Range') ?? request.headers.get('range')

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
      if (match) {
        const startStr = match[1]
        const endStr = match[2]
        let start = startStr ? parseInt(startStr, 10) : 0
        let end = endStr ? parseInt(endStr, 10) : fileSize - 1

        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1
        if (start > end || start >= fileSize) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          })
        }

        const chunkSize = end - start + 1
        const stream = createReadStream(filePath, { start, end })

        return new Response(nodeStreamToWebStream(stream), {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    }

    // No range requested: return the whole file, but still advertise range
    // support so the <video> element knows it can issue ranged requests.
    const stream = createReadStream(filePath)
    return new Response(nodeStreamToWebStream(stream), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes'
      }
    })
  })
}

export function toMediaUrl(filePath: string): string {
  return `leaguevid-media://local/${encodeURIComponent(filePath)}`
}
