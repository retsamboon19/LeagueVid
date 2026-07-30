// Verifies the SHIPPED gank analyzer (src/main/riot/gankAnalyzer.ts) against
// the cached timelines, and reports the distributions the achievement
// thresholds are calibrated from.
//
// This imports the production module rather than reimplementing the rules, so
// what is measured here is exactly what the app will show. The earlier probes
// explored the design; this checks the result.
//
// Read-only, no Riot API calls.
//
// Usage: npx tsx scripts/verify-gank-stats.ts [matchLimit] [--role TOP]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { analyzeGanks } from '../src/main/riot/gankAnalyzer'
import type { GankStats } from '../src/shared/types'

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
  return d === 0 ? '    n/a' : `${((n / d) * 100).toFixed(1)}%`
}

function tail(values: number[], label: string): void {
  console.log(`  ${label}`)
  const max = Math.max(0, ...values)
  for (let n = 1; n <= Math.min(max, 5); n++) {
    const c = values.filter((v) => v >= n).length
    console.log(`    >= ${n}: ${String(c).padStart(6)}   ${pct(c, values.length)}`)
  }
  const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
  console.log(`    mean: ${mean.toFixed(2)}   max: ${max}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 1000)
  const roleFilterIndex = args.indexOf('--role')
  const roleFilter = roleFilterIndex >= 0 ? args[roleFilterIndex + 1] : null

  const matches = readKind<any>('match', limit)
  const timelines = readKind<any>('timeline', limit)

  let matchesUsed = 0
  let skippedNonClassic = 0
  let junglerEntries = 0
  const byRole = new Map<string, GankStats[]>()
  const all: GankStats[] = []

  for (const [matchId, match] of matches) {
    const timeline = timelines.get(matchId)
    if (!timeline) continue
    const participants = match.info?.participants ?? []
    if (participants.length !== 10) continue
    if (match.info?.gameMode !== 'CLASSIC') {
      skippedNonClassic++
      continue
    }
    matchesUsed++

    const roleById = new Map<number, string>()
    for (const p of participants) {
      roleById.set(p.participantId, p.teamPosition || p.individualPosition || '')
    }

    const stats = analyzeGanks(
      timeline.info?.frames ?? [],
      participants.map((p: any) => ({
        participantId: p.participantId,
        teamId: p.teamId,
        role: p.teamPosition || p.individualPosition || ''
      }))
    )

    for (const [idRaw, s] of Object.entries(stats)) {
      const role = roleById.get(Number(idRaw)) ?? ''
      if (role === 'JUNGLE') junglerEntries++
      if (roleFilter && role !== roleFilter) continue
      const list = byRole.get(role) ?? []
      list.push(s)
      byRole.set(role, list)
      all.push(s)
    }
  }

  console.log(`matches analysed (CLASSIC, 10p, timeline): ${matchesUsed}`)
  console.log(`non-Summoner's-Rift matches skipped       : ${skippedNonClassic}`)
  console.log(`laner-games with gank stats               : ${all.length}`)
  if (roleFilter) console.log(`role filter                               : ${roleFilter}`)

  console.log(
    `\nCORRECTNESS CHECK -- jungle participants in output: ${junglerEntries} (must be 0)`
  )
  console.log(
    `  ${junglerEntries === 0 ? 'PASS: junglers are omitted, so the UI shows them as unavailable.' : 'FAIL: junglers are being given lane stats.'}`
  )

  // A survived attempt must never coexist with more survived than attempted.
  const inconsistent = all.filter((s) => s.ganksSurvived > s.gankAttempts).length
  console.log(`\nCORRECTNESS CHECK -- ganksSurvived > gankAttempts: ${inconsistent} (must be 0)`)
  console.log(`  ${inconsistent === 0 ? 'PASS' : 'FAIL'}`)

  // --- The reviewable event list must line up with the counters it explains ---
  const countBy = (s: GankStats, outcome: string): number =>
    s.gankEvents.filter((e) => e.outcome === outcome).length

  const diedMismatch = all.filter((s) => countBy(s, 'died') !== s.gankDeaths).length
  const turnedMismatch = all.filter(
    (s) => countBy(s, 'turned_around') !== s.ganksTurnedAround
  ).length
  // Survived rows may be FEWER than the counter: a survived gank the player also
  // won is shown once as turned_around while still counting as survived. More
  // rows than the counter would be a real bug.
  const survivedTooMany = all.filter((s) => countBy(s, 'survived') > s.ganksSurvived).length

  console.log(`\nCORRECTNESS CHECK -- 'died' rows vs gankDeaths mismatches: ${diedMismatch} (must be 0)`)
  console.log(`  ${diedMismatch === 0 ? 'PASS' : 'FAIL'}`)
  console.log(
    `CORRECTNESS CHECK -- 'turned_around' rows vs counter mismatches: ${turnedMismatch} (must be 0)`
  )
  console.log(`  ${turnedMismatch === 0 ? 'PASS' : 'FAIL'}`)
  console.log(`CORRECTNESS CHECK -- 'survived' rows exceeding counter: ${survivedTooMany} (must be 0)`)
  console.log(`  ${survivedTooMany === 0 ? 'PASS' : 'FAIL'}`)

  // Feedback rows are keyed on (match, participant, timestamp), so two events
  // sharing a timestamp would make one verdict silently overwrite the other.
  const dupTimestamps = all.filter((s) => {
    const seen = new Set<number>()
    return s.gankEvents.some((e) => {
      const key = Math.round(e.timestampMs)
      if (seen.has(key)) return true
      seen.add(key)
      return false
    })
  }).length
  console.log(
    `\nCORRECTNESS CHECK -- players with two ganks on the same ms: ${dupTimestamps} (must be 0)`
  )
  console.log(
    `  ${dupTimestamps === 0 ? 'PASS: every row has a unique feedback key.' : 'FAIL: verdicts would collide in gank_feedback.'}`
  )

  const lateEvents = all.reduce(
    (n, s) => n + s.gankEvents.filter((e) => e.timestampMs > 15 * 60 * 1000).length,
    0
  )
  console.log(`\nCORRECTNESS CHECK -- events after 15:00: ${lateEvents} (must be 0)`)
  console.log(`  ${lateEvents === 0 ? 'PASS' : 'FAIL'}`)

  const noGankers = all.reduce(
    (n, s) => n + s.gankEvents.filter((e) => e.gankerParticipantIds.length === 0).length,
    0
  )
  const totalEvents = all.reduce((n, s) => n + s.gankEvents.length, 0)
  const approx = all.reduce(
    (n, s) => n + s.gankEvents.filter((e) => e.approximateTime).length,
    0
  )
  console.log(`\n--- event list shape ---`)
  console.log(`total reviewable rows            : ${totalEvents}`)
  console.log(`  with an approximate timestamp  : ${approx}  ${pct(approx, totalEvents)}`)
  console.log(`  with no ganker identified      : ${noGankers}  ${pct(noGankers, totalEvents)}`)
  console.log(`rows per laner-game (mean)       : ${(totalEvents / (all.length || 1)).toFixed(2)}`)

  console.log('\n--- distributions across all lane roles ---')
  tail(
    all.map((s) => s.gankDeaths),
    'deaths to ganks'
  )
  tail(
    all.map((s) => s.gankAttempts),
    'gank attempts (sampled)'
  )
  tail(
    all.map((s) => s.ganksSurvived),
    'ganks survived'
  )
  tail(
    all.map((s) => s.ganksTurnedAround),
    'ganks turned around'
  )

  const zeroDeaths = all.filter((s) => s.gankDeaths === 0).length
  const pressuredClean = all.filter((s) => s.gankAttempts >= 2 && s.gankDeaths === 0).length
  console.log('\n--- combined conditions (for the "not ganked" achievements) ---')
  console.log(`zero gank deaths                       : ${zeroDeaths}  ${pct(zeroDeaths, all.length)}`)
  console.log(
    `2+ attempts AND zero gank deaths       : ${pressuredClean}  ${pct(pressuredClean, all.length)}`
  )
  for (const n of [3, 4]) {
    const c = all.filter((s) => s.gankAttempts >= n && s.gankDeaths === 0).length
    console.log(`${n}+ attempts AND zero gank deaths       : ${c}  ${pct(c, all.length)}`)
  }

  console.log('\n--- per role: mean attempts / deaths / survived / turned ---')
  console.log('  role       games   attempts   deaths   survived   turned')
  for (const role of ['TOP', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
    const list = byRole.get(role)
    if (!list || list.length === 0) continue
    const mean = (pick: (s: GankStats) => number): string =>
      (list.reduce((a, s) => a + pick(s), 0) / list.length).toFixed(2)
    console.log(
      `  ${role.padEnd(9)}  ${String(list.length).padStart(5)}   ${mean((s) => s.gankAttempts).padStart(8)}   ${mean((s) => s.gankDeaths).padStart(6)}   ${mean((s) => s.ganksSurvived).padStart(8)}   ${mean((s) => s.ganksTurnedAround).padStart(6)}`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
