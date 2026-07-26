// Checks how multikills can actually be detected from the cached Riot data.
//
// Two questions:
//   1. Do timeline CHAMPION_KILL events carry multiKillLength? (The app
//      currently assumes they do.)
//   2. If not, does clustering a player's own kills by a time window
//      reproduce the authoritative counts in the match DTO
//      (doubleKills/tripleKills/quadraKills/pentaKills)?
//
// Read-only, no Riot API calls.
//
// Usage: npx tsx scripts/check-multikill-data.ts [gapSeconds] [matchLimit]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const cacheRoot = join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'cache')

/** Every cached JSON file of a kind ('match' or 'timeline'), keyed by id. */
function readKind<T>(kind: string): Map<string, T> {
  const out = new Map<string, T>()
  const root = join(cacheRoot, kind)
  if (!existsSync(root)) return out
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

interface Kill {
  timestamp: number
  killerId: number
  multiKillLength?: number
}

function clusterCounts(kills: number[], gapMs: number): Record<number, number> {
  // Walk one player's kill timestamps; a kill continues the current streak if
  // it lands within gapMs of the previous one.
  const streaks: number[] = []
  let current = 0
  let prev = -Infinity
  for (const t of kills) {
    if (t - prev <= gapMs) current++
    else {
      if (current > 0) streaks.push(current)
      current = 1
    }
    prev = t
  }
  if (current > 0) streaks.push(current)

  // League counts each tier a streak PASSES THROUGH, not just the tier it
  // ends on: a triple kill increments both doubleKills and tripleKills.
  const counts: Record<number, number> = { 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const len of streaks) {
    const capped = Math.min(len, 5)
    for (let tier = 2; tier <= capped; tier++) counts[tier]++
  }
  return counts
}

async function main(): Promise<void> {
  const gapSeconds = Number(process.argv[2] ?? 10)
  const limit = Number(process.argv[3] ?? 40)

  const matches = readKind<{ info?: { participants?: Record<string, unknown>[] } }>('match')
  const timelines = readKind<{ info?: { frames?: Record<string, unknown>[] } }>('timeline')

  let timelinesChecked = 0
  let eventsSeen = 0
  let eventsWithMultiKillLength = 0
  let playersCompared = 0
  let exactAgreement = 0
  const disagreements: string[] = []

  for (const [matchId, matchRaw] of [...matches].slice(0, limit)) {
    const timeline = timelines.get(matchId)
    if (!timeline) continue

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = matchRaw as any
    timelinesChecked++

    const killsByPlayer = new Map<number, Kill[]>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const frame of ((timeline as any).info?.frames ?? []) as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ev of (frame.events ?? []) as any[]) {
        if (ev.type !== 'CHAMPION_KILL') continue
        eventsSeen++
        if (ev.multiKillLength !== undefined) eventsWithMultiKillLength++
        const killerId = ev.killerId ?? 0
        if (killerId <= 0) continue
        const list = killsByPlayer.get(killerId) ?? []
        list.push({ timestamp: ev.timestamp, killerId, multiKillLength: ev.multiKillLength })
        killsByPlayer.set(killerId, list)
      }
    }

    for (const p of match.info?.participants ?? []) {
      const actual = {
        2: p.doubleKills ?? 0,
        3: p.tripleKills ?? 0,
        4: p.quadraKills ?? 0,
        5: p.pentaKills ?? 0
      }
      const total = actual[2] + actual[3] + actual[4] + actual[5]
      if (total === 0) continue

      const kills = (killsByPlayer.get(p.participantId) ?? [])
        .map((k) => k.timestamp)
        .sort((a, b) => a - b)
      const derived = clusterCounts(kills, gapSeconds * 1000)

      playersCompared++
      const same =
        derived[2] === actual[2] &&
        derived[3] === actual[3] &&
        derived[4] === actual[4] &&
        derived[5] === actual[5]
      if (same) exactAgreement++
      else if (disagreements.length < 12) {
        disagreements.push(
          `${matchId} ${String(p.championName).padEnd(12)} riot=${actual[2]}/${actual[3]}/${actual[4]}/${actual[5]}  derived=${derived[2]}/${derived[3]}/${derived[4]}/${derived[5]}`
        )
      }
    }
  }

  console.log(`gap used: ${gapSeconds}s   timelines checked: ${timelinesChecked}`)
  console.log('')
  console.log('--- Q1: does the timeline report multiKillLength? ---')
  console.log(`CHAMPION_KILL events seen        : ${eventsSeen}`)
  console.log(`...with a multiKillLength field  : ${eventsWithMultiKillLength}`)
  if (eventsWithMultiKillLength === 0) {
    console.log('=> NO. The timeline never reports it, so any code reading')
    console.log('   ev.multiKillLength can never fire. Multikills must be derived.')
  }
  console.log('')
  console.log('--- Q2: does clustering reproduce Riot\'s own counts? ---')
  console.log(`players with >=1 multikill        : ${playersCompared}`)
  console.log(`exact match on all four tiers     : ${exactAgreement}`)
  if (playersCompared > 0) {
    console.log(
      `agreement                          : ${((exactAgreement / playersCompared) * 100).toFixed(1)}%`
    )
  }
  if (disagreements.length > 0) {
    console.log('\nsample disagreements (double/triple/quadra/penta):')
    for (const d of disagreements) console.log('  ' + d)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
