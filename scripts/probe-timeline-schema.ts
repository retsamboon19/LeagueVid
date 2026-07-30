// Inventories what the cached timelines ACTUALLY contain, so gank-attempt
// detection is designed against real fields rather than assumed ones.
//
// Detecting a death is easy: CHAMPION_KILL carries a position. Detecting a
// gank the player SURVIVED is the open question -- a failed gank with no kills
// may leave no trace at all. This answers what trace, if any, exists:
//
//   1. frameInterval -- how coarse is the position sampling? A gank lasts
//      ~10s, so a 60s interval mostly cannot see one.
//   2. Do participantFrames carry `position`? (Riot sends it; this repo's
//      TimelineParticipantFrameDto does not model it, so it needs confirming
//      in the cached data.)
//   3. Which event types exist, and which of them carry a position?
//   4. Does CHAMPION_KILL carry victimDamageReceived / victimDamageDealt?
//      Those would name every champion who damaged the victim, which is a far
//      better "who was involved" signal than assists.
//
// Read-only, no Riot API calls.
//
// Usage: npx tsx scripts/probe-timeline-schema.ts [matchLimit]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const cacheRoot = join(process.env.APPDATA ?? '', 'leaguevid', 'riot-api-cache')

function readKind<T>(kind: string, limit: number): Map<string, T> {
  const out = new Map<string, T>()
  const root = join(cacheRoot, kind)
  if (!existsSync(root)) return out
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.size >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) {
        try {
          out.set(entry.name.replace(/\.json$/, ''), JSON.parse(readFileSync(full, 'utf8')) as T)
        } catch {
          continue
        }
      }
    }
  }
  walk(root)
  return out
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 200)
  const timelines = readKind<any>('timeline', limit)

  const frameIntervals = new Map<number, number>()
  const eventTypes = new Map<string, number>()
  const eventTypesWithPosition = new Map<string, number>()
  const participantFrameKeys = new Map<string, number>()
  let participantFrameCount = 0
  let framesWithPosition = 0

  let killEvents = 0
  let killsWithVictimDamageReceived = 0
  let killsWithVictimDamageDealt = 0
  const killEventKeys = new Map<string, number>()
  let sampleVictimDamage: unknown = null

  for (const [, timeline] of timelines) {
    const info = timeline.info
    if (!info) continue
    const fi = info.frameInterval
    if (typeof fi === 'number') frameIntervals.set(fi, (frameIntervals.get(fi) ?? 0) + 1)

    for (const frame of info.frames ?? []) {
      for (const pf of Object.values(frame.participantFrames ?? {}) as any[]) {
        participantFrameCount++
        for (const k of Object.keys(pf)) {
          participantFrameKeys.set(k, (participantFrameKeys.get(k) ?? 0) + 1)
        }
        if (pf.position && typeof pf.position.x === 'number') framesWithPosition++
      }

      for (const ev of (frame.events ?? []) as any[]) {
        eventTypes.set(ev.type, (eventTypes.get(ev.type) ?? 0) + 1)
        if (ev.position && typeof ev.position.x === 'number') {
          eventTypesWithPosition.set(ev.type, (eventTypesWithPosition.get(ev.type) ?? 0) + 1)
        }
        if (ev.type === 'CHAMPION_KILL') {
          killEvents++
          for (const k of Object.keys(ev)) killEventKeys.set(k, (killEventKeys.get(k) ?? 0) + 1)
          if (Array.isArray(ev.victimDamageReceived)) {
            killsWithVictimDamageReceived++
            if (!sampleVictimDamage) sampleVictimDamage = ev.victimDamageReceived.slice(0, 3)
          }
          if (Array.isArray(ev.victimDamageDealt)) killsWithVictimDamageDealt++
        }
      }
    }
  }

  console.log(`timelines inspected: ${timelines.size}`)

  console.log('\n--- Q1: frame interval (position sampling granularity) ---')
  for (const [interval, count] of [...frameIntervals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${interval} ms (${interval / 1000}s) : ${count} timelines`)
  }
  console.log('  A gank lasts roughly 10s. Anything at 60s can only sample it,')
  console.log('  never observe it directly.')

  console.log('\n--- Q2: do participantFrames carry a position? ---')
  console.log(`participant frames seen        : ${participantFrameCount}`)
  console.log(
    `...with a position             : ${framesWithPosition}  ${pct(framesWithPosition, participantFrameCount)}`
  )
  console.log('  participantFrame fields present (count of frames carrying each):')
  for (const [k, n] of [...participantFrameKeys].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(34)} ${String(n).padStart(9)}`)
  }

  console.log('\n--- Q3: event types, and which carry a position ---')
  console.log('  type                              count     with position')
  for (const [type, n] of [...eventTypes].sort((a, b) => b[1] - a[1])) {
    const withPos = eventTypesWithPosition.get(type) ?? 0
    console.log(
      `  ${type.padEnd(32)} ${String(n).padStart(7)}   ${String(withPos).padStart(7)} ${pct(withPos, n).padStart(7)}`
    )
  }

  console.log('\n--- Q4: does CHAMPION_KILL name everyone who damaged the victim? ---')
  console.log(`CHAMPION_KILL events           : ${killEvents}`)
  console.log(
    `...with victimDamageReceived   : ${killsWithVictimDamageReceived}  ${pct(killsWithVictimDamageReceived, killEvents)}`
  )
  console.log(
    `...with victimDamageDealt      : ${killsWithVictimDamageDealt}  ${pct(killsWithVictimDamageDealt, killEvents)}`
  )
  console.log('  all CHAMPION_KILL fields seen:')
  for (const [k, n] of [...killEventKeys].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(30)} ${String(n).padStart(7)} ${pct(n, killEvents).padStart(7)}`)
  }
  if (sampleVictimDamage) {
    console.log('\n  sample victimDamageReceived entries:')
    console.log(
      JSON.stringify(sampleVictimDamage, null, 2)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
