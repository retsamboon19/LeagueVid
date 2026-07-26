import { open, type FileHandle } from 'fs/promises'

// Reads a video's duration directly from an MP4/MOV container's 'moov/mvhd'
// box, without decoding any video frames -- this is what makes it fast even
// for large files. MP4 and QuickTime (.mov) share the same ISO base media
// box structure, including 'mvhd', so one parser covers both.
//
// Box layout (ISO/IEC 14496-12): each box is [size:4][type:4][...data...],
// where size===1 means the real size follows as a 64-bit value, and
// size===0 means "extends to the end of the parent". Boxes are read by
// seeking directly to each header instead of loading the file into memory,
// so this stays fast regardless of file size or where 'moov' sits (some
// encoders write it at the very end, after all the frame data).
//
// Returns null if the file isn't a box-structured container we recognize,
// or the relevant boxes/fields can't be found -- callers should fall back
// to a slower-but-general probing method in that case.

interface BoxHeader {
  type: string
  size: number
  headerSize: number
}

async function readBoxHeader(fh: FileHandle, offset: number): Promise<BoxHeader | null> {
  const buf = Buffer.alloc(8)
  const { bytesRead } = await fh.read(buf, 0, 8, offset)
  if (bytesRead < 8) return null

  let size = buf.readUInt32BE(0)
  const type = buf.toString('ascii', 4, 8)
  let headerSize = 8

  if (size === 1) {
    // 32-bit size field is a sentinel; the real 64-bit size follows.
    const ext = Buffer.alloc(8)
    const { bytesRead: extRead } = await fh.read(ext, 0, 8, offset + 8)
    if (extRead < 8) return null
    size = Number(ext.readBigUInt64BE(0))
    headerSize = 16
  }

  return { type, size, headerSize }
}

/** Finds a direct child box of the given type within [rangeStart, rangeEnd). */
async function findChildBox(
  fh: FileHandle,
  targetType: string,
  rangeStart: number,
  rangeEnd: number
): Promise<{ dataStart: number; dataEnd: number } | null> {
  let pos = rangeStart

  while (pos < rangeEnd) {
    const header = await readBoxHeader(fh, pos)
    if (!header) return null

    // size===0 means "rest of the containing box/file" (used for the last
    // box in a stream). Treat headerSize<=0 as corrupt data and bail rather
    // than looping forever.
    const boxSize = header.size === 0 ? rangeEnd - pos : header.size
    if (boxSize < header.headerSize) return null

    if (header.type === targetType) {
      return { dataStart: pos + header.headerSize, dataEnd: pos + boxSize }
    }
    pos += boxSize
  }

  return null
}

export async function probeMp4DurationMs(filePath: string): Promise<number | null> {
  let fh: FileHandle | null = null
  try {
    fh = await open(filePath, 'r')
    const { size: fileSize } = await fh.stat()

    const moov = await findChildBox(fh, 'moov', 0, fileSize)
    if (!moov) return null

    const mvhd = await findChildBox(fh, 'mvhd', moov.dataStart, moov.dataEnd)
    if (!mvhd) return null

    // mvhd body: version(1) + flags(3), then fields that differ by version.
    const versionBuf = Buffer.alloc(1)
    await fh.read(versionBuf, 0, 1, mvhd.dataStart)
    const version = versionBuf.readUInt8(0)

    let timescale: number
    let duration: number

    if (version === 1) {
      // creation_time(8) + modification_time(8) + timescale(4) + duration(8)
      const buf = Buffer.alloc(28)
      await fh.read(buf, 0, 28, mvhd.dataStart + 4)
      timescale = buf.readUInt32BE(16)
      duration = Number(buf.readBigUInt64BE(20))
    } else {
      // creation_time(4) + modification_time(4) + timescale(4) + duration(4)
      const buf = Buffer.alloc(16)
      await fh.read(buf, 0, 16, mvhd.dataStart + 4)
      timescale = buf.readUInt32BE(8)
      duration = buf.readUInt32BE(12)
    }

    if (!timescale || !Number.isFinite(duration)) return null
    return (duration / timescale) * 1000
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}
