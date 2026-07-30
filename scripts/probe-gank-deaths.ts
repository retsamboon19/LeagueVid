// Feasibility probe for a "deaths to ganks" stat.
//
// The proposed definition is: a death before 15 minutes, while the player was
// in their own lane, that was not a fair 1v1. This script tests whether that
// is actually derivable from the cached timelines, and which formulation of
// "not a 1v1" holds up.
//
// Four questions:
//   1. Do pre-15min CHAMPION_KILL events reliably carry a map position?
//      (Without it there is no "in their own lane" test at all.)
//   2. Does a lane-corridor test built from the static turret table actually
//      work? Validated against a falsifiable control: deaths where the ONLY
//      enemy involved is the player's own lane opponent should land in-lane
//      the overwhelming majority of the time. If they don't, the geometry is
//      wrong. (Measured: 93.6% at a 1500-unit half-width.)
//   3. How do two competing definitions of "not a 1v1" compare?
//        naive     -- the kill had at least one assister
//        3rd-party -- at least one enemy involved (killer or assister) was
//                     NOT one of the player's expected lane opponents
//      The naive one should miss ganks where the jungler does all the damage
//      and the laner contributes nothing (killerId = jungler, no assists), and
//      should badly over-count in bot lane, where 2v2 is the normal state.
//   4. What per-role and per-game rates come out, i.e. is the resulting number
//      plausible enough to display?
//
// Read-only. No Riot API calls.
//
// Usage: npx tsx scripts/probe-gank-deaths.ts [corridorHalfWidth] [matchLimit]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  BOT_LANE,
  EARLY_MS,
  MID_LANE,
  TOP_LANE,
  type Pt,
  distToLane,
  expectedOpponentRoles,
  laneForRole
} from './lib/laneGeometry'

const cacheRoot = join(
  process.env.APPDATA ?? '',
  'leaguevid',
  'riot-api-cache'
)

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

// Lane geometry (polylines through the static turret table, corridor
// half-width, role -> lane mapping) lives in ./lib/laneGeometry.ts so the
// gank probes share one copy.

interface Ev {
  type: string
  timestamp: number
  killerId?: number
  victimId?: number
  assistingParticipantIds?: number[]
  position?: Pt
}

function pct(n: number, d: number): string {
  return d === 0 ? '   n/a' : `${((n / d) * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const halfWidth = Number(process.argv[2] ?? 1500)
  const limit = Number(process.argv[3] ?? 1000)

  const matches = readKind<any>('match', limit)
  const timelines = readKind<any>('timeline', limit)

  let matchesUsed = 0
  let earlyDeaths = 0
  let earlyDeathsWithPosition = 0
  let killerZero = 0

  // Q2 control: 1v1-vs-lane-opponent deaths, how many land in the corridor.
  let controlTotal = 0
  let controlInLane = 0
  // Reference group, NOT a counter-control: deaths where the only enemy is the
  // enemy jungler. A jungler solo-killing a laner in lane IS a gank, so a high
  // in-lane rate here is expected rather than evidence against the geometry.
  // Reported only to show how the corridor treats the clearest gank case.
  let jungleOnlyTotal = 0
  let jungleOnlyInLane = 0

  let naiveGanks = 0
  let thirdPartyGanks = 0
  let bothAgree = 0
  let naiveOnly = 0
  let thirdPartyOnly = 0

  // Corridor sensitivity
  const widths = [1000, 1250, 1500, 1750, 2000, 2500]
  const controlByWidth = new Map<number, number>(widths.map((w) => [w, 0]))
  const ganksByWidth = new Map<number, number>(widths.map((w) => [w, 0]))

  const byRole = new Map<string, { deaths: number; ganks: number; games: number }>()
  const perGame: number[] = []
  let laneDeathsNoPosition = 0
  let junglerDeathsSkipped = 0
  let inLaneAny = 0
  let thirdPartyIgnoringLane = 0
  let thirdPartyOutOfLane = 0
  const naiveOnlyByRole = new Map<string, number>()
  const thirdPartyOnlyByRole = new Map<string, number>()
  const enemyCountHist = new Map<number, number>()

  for (const [matchId, match] of matches) {
    const timeline = timelines.get(matchId)
    if (!timeline) continue
    const participants = match.info?.participants ?? []
    if (participants.length === 0) continue
    // Only Summoner's Rift 5v5 makes lane sense.
    if (match.info?.gameMode !== 'CLASSIC') continue
    matchesUsed++

    const roleById = new Map<number, string>()
    const teamById = new Map<number, number>()
    for (const p of participants) {
      roleById.set(p.participantId, p.teamPosition || p.individualPosition || '')
      teamById.set(p.participantId, p.teamId)
    }

    // participantId -> role, for the enemy team, to identify third parties.
    const gankCountThisGame = new Map<number, number>()

    for (const frame of timeline.info?.frames ?? []) {
      for (const ev of (frame.events ?? []) as Ev[]) {
        if (ev.type !== 'CHAMPION_KILL') continue
        if (ev.timestamp > EARLY_MS) continue
        const victimId = ev.victimId
        if (!victimId) continue

        earlyDeaths++
        const role = roleById.get(victimId) ?? ''
        const lane = laneForRole(role)
        if (!lane) {
          junglerDeathsSkipped++
          continue
        }

        if (!ev.position) {
          laneDeathsNoPosition++
          continue
        }
        earlyDeathsWithPosition++

        const killerId = ev.killerId ?? 0
        if (killerId <= 0) killerZero++

        const victimTeam = teamById.get(victimId)
        const assists = ev.assistingParticipantIds ?? []
        const involved = [killerId, ...assists].filter((id) => id > 0)
        const enemies = involved.filter((id) => teamById.get(id) !== victimTeam)
        const enemyRoles = enemies.map((id) => roleById.get(id) ?? '')

        const dist = distToLane(ev.position, lane)
        const inLane = dist <= halfWidth

        const expected = expectedOpponentRoles(role)
        const thirdParties = enemyRoles.filter((r) => !expected.includes(r))

        // Q2 control: exactly one enemy, and it is the lane opponent.
        if (enemies.length === 1 && expected.includes(enemyRoles[0])) {
          controlTotal++
          if (inLane) controlInLane++
          for (const w of widths) {
            if (dist <= w) controlByWidth.set(w, (controlByWidth.get(w) ?? 0) + 1)
          }
        }
        if (enemies.length === 1 && enemyRoles[0] === 'JUNGLE') {
          jungleOnlyTotal++
          if (inLane) jungleOnlyInLane++
        }

        const naive = inLane && assists.length > 0
        const thirdParty = inLane && thirdParties.length > 0

        if (naive) naiveGanks++
        if (thirdParty) thirdPartyGanks++
        if (naive && thirdParty) bothAgree++
        if (naive && !thirdParty) naiveOnly++
        if (!naive && thirdParty) thirdPartyOnly++

        if (thirdParties.length > 0) {
          for (const w of widths) {
            if (dist <= w) ganksByWidth.set(w, (ganksByWidth.get(w) ?? 0) + 1)
          }
        }

        const entry = byRole.get(role) ?? { deaths: 0, ganks: 0, games: 0 }
        entry.deaths++
        if (thirdParty) entry.ganks++
        byRole.set(role, entry)

        // Is the lane test even load-bearing? Count in-lane share overall,
        // and how many third-party deaths it filters out.
        if (inLane) inLaneAny++
        if (thirdParties.length > 0) {
          thirdPartyIgnoringLane++
          if (!inLane) thirdPartyOutOfLane++
        }
        // Who does the naive definition over-count?
        if (naive && !thirdParty) {
          naiveOnlyByRole.set(role, (naiveOnlyByRole.get(role) ?? 0) + 1)
        }
        if (!naive && thirdParty) {
          thirdPartyOnlyByRole.set(role, (thirdPartyOnlyByRole.get(role) ?? 0) + 1)
        }
        // How many enemies pile on, for the "was it even close to fair" view.
        enemyCountHist.set(enemies.length, (enemyCountHist.get(enemies.length) ?? 0) + 1)

        if (thirdParty) {
          gankCountThisGame.set(victimId, (gankCountThisGame.get(victimId) ?? 0) + 1)
        }
      }
    }

    for (const p of participants) {
      const role = roleById.get(p.participantId) ?? ''
      if (!laneForRole(role)) continue
      const entry = byRole.get(role) ?? { deaths: 0, ganks: 0, games: 0 }
      entry.games++
      byRole.set(role, entry)
      perGame.push(gankCountThisGame.get(p.participantId) ?? 0)
    }
  }

  console.log(`cache: ${cacheRoot}`)
  console.log(
    `matches with timeline (CLASSIC only): ${matchesUsed}   corridor half-width: ${halfWidth}`
  )

  console.log('\n--- Q1: is there position data on early deaths? ---')
  console.log(`early (<15min) deaths, all roles          : ${earlyDeaths}`)
  console.log(`  of those, jungler deaths (no own lane)  : ${junglerDeathsSkipped}`)
  console.log(`laner early deaths WITHOUT a position     : ${laneDeathsNoPosition}`)
  console.log(`laner early deaths WITH a position        : ${earlyDeathsWithPosition}`)
  console.log(`  killerId == 0 (execution/turret/minion) : ${killerZero}`)

  console.log('\n--- Q2: does the lane-corridor test hold up? ---')
  console.log('control = death where the ONLY enemy involved is the lane opponent.')
  console.log('These are fair lane duels, so they should be in-lane almost always.')
  console.log(
    `  lane-opponent-only deaths in corridor  : ${controlInLane}/${controlTotal}  ${pct(controlInLane, controlTotal)}`
  )
  console.log('reference (not a control) = only enemy involved is the enemy JUNGLER,')
  console.log('  i.e. the clearest gank case; a high in-lane rate here is expected.')
  console.log(
    `  jungler-only deaths in corridor        : ${jungleOnlyInLane}/${jungleOnlyTotal}  ${pct(jungleOnlyInLane, jungleOnlyTotal)}`
  )

  console.log('\n  corridor width sensitivity:')
  console.log('    width   control in-lane     ganks found')
  for (const w of widths) {
    console.log(
      `    ${String(w).padStart(5)}   ${pct(controlByWidth.get(w) ?? 0, controlTotal).padStart(6)}            ${String(ganksByWidth.get(w) ?? 0).padStart(6)}`
    )
  }

  console.log('\n--- Q3: naive "had an assist" vs "a third party was involved" ---')
  console.log(`naive ganks (in lane + >=1 assister)      : ${naiveGanks}`)
  console.log(`third-party ganks (non-lane-opponent)     : ${thirdPartyGanks}`)
  console.log(`  both definitions agree                  : ${bothAgree}`)
  console.log(
    `  naive ONLY (a real 2v2/2v1 lane fight,  : ${naiveOnly}  <- naive over-counts these`
  )
  console.log('    e.g. bot lane ADC+sup killing you)')
  console.log(
    `  third-party ONLY (solo gank, no assist) : ${thirdPartyOnly}  <- naive MISSES these`
  )

  console.log('\n--- Q3b: is the lane test load-bearing, or just noise? ---')
  console.log(
    `early laner deaths that are in-lane at all: ${inLaneAny}/${earlyDeathsWithPosition}  ${pct(inLaneAny, earlyDeathsWithPosition)}`
  )
  console.log(`third-party deaths ignoring lane position : ${thirdPartyIgnoringLane}`)
  console.log(
    `  ...of which OUT of lane (filtered out)  : ${thirdPartyOutOfLane}  ${pct(thirdPartyOutOfLane, thirdPartyIgnoringLane)}`
  )
  console.log('  (these are roams/invades/river fights, not lane ganks)')

  console.log('\n  where the two definitions disagree, by role:')
  console.log('    role      naive-only (over-count)   third-party-only (naive misses)')
  for (const role of ['TOP', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
    console.log(
      `    ${role.padEnd(8)}  ${String(naiveOnlyByRole.get(role) ?? 0).padStart(21)}   ${String(thirdPartyOnlyByRole.get(role) ?? 0).padStart(30)}`
    )
  }

  console.log('\n  enemies involved in an early laner death:')
  for (const k of [...enemyCountHist.keys()].sort((a, b) => a - b)) {
    console.log(
      `    ${k} enemies: ${String(enemyCountHist.get(k)).padStart(6)}   ${pct(enemyCountHist.get(k) ?? 0, earlyDeathsWithPosition)}`
    )
  }

  console.log('\n--- Q4: resulting rates ---')
  console.log('  role      games   early lane deaths   ganked   gank share of deaths   ganks/game')
  for (const role of ['TOP', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
    const e = byRole.get(role)
    if (!e) continue
    const perGameRate = e.games > 0 ? (e.ganks / e.games).toFixed(2) : 'n/a'
    console.log(
      `  ${role.padEnd(8)}  ${String(e.games).padStart(5)}   ${String(e.deaths).padStart(17)}   ${String(e.ganks).padStart(6)}   ${pct(e.ganks, e.deaths).padStart(20)}   ${perGameRate.padStart(10)}`
    )
  }

  const dist: Record<number, number> = {}
  for (const n of perGame) dist[Math.min(n, 5)] = (dist[Math.min(n, 5)] ?? 0) + 1
  console.log('\n  ganks per player-game distribution (5 = 5 or more):')
  for (const k of Object.keys(dist).sort()) {
    console.log(`    ${k}: ${String(dist[Number(k)]).padStart(6)}   ${pct(dist[Number(k)], perGame.length)}`)
  }
  const mean = perGame.length > 0 ? perGame.reduce((a, b) => a + b, 0) / perGame.length : 0
  console.log(`  mean ganks per player-game: ${mean.toFixed(2)}`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
