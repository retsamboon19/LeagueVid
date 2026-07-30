// Explores whether a gank the player SURVIVED can be detected, and whether
// "the enemy jungler came to my lane" is observable at all.
//
// Dying to a gank is easy (CHAMPION_KILL carries a position). A failed gank
// may leave no trace. probe-timeline-schema.ts established the two candidate
// signals, and this measures whether either is trustworthy:
//
//   A. participantFrames carry a position for all 10 players at 100% of
//      frames -- but frameInterval is 60000ms. A gank lasts ~10s, so frames
//      only SAMPLE lane presence. Question: how much signal survives that?
//      Tested by whether a sampled jungler visit actually predicts a death.
//
//   B. victimDamageReceived is on 100% of kills and names every champion who
//      damaged the victim, vs assistingParticipantIds on only 76.9%. Question:
//      does damage-based attribution find gank deaths that assists miss?
//
// Plus the two fully provable events that need no sampling at all:
//
//   C. "Turned it around" -- a third-party enemy DIED in the player's lane
//      before 15min and the player did not. A failed gank, provable.
//   D. "Gank-proof" -- the enemy jungler demonstrably ganked other lanes
//      (their teammates died to that jungler in-lane) but never got the
//      player. This is what makes NOT dying to ganks mean something: there is
//      positive evidence the jungler was hunting.
//
// Read-only, no Riot API calls.
//
// Usage: npx tsx scripts/probe-gank-attempts.ts [matchLimit]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  EARLY_MS,
  LANE_HALF_WIDTH,
  LANE_ROLES,
  type Pt,
  distToLane,
  expectedOpponentRoles,
  laneForRole
} from './lib/laneGeometry'

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

/** How close in time a death has to be to a sampled frame to be attributed to it. */
const VISIT_DEATH_WINDOW_MS = 45_000

/** A ganker dying this soon after the player died means it was a trade, not a save. */
const TRADE_WINDOW_MS = 20_000

interface Kill {
  timestampMs: number
  killerId: number
  victimId: number
  assistIds: number[]
  /** Enemy participants who dealt any damage to the victim. */
  damagerIds: number[]
  position: Pt
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 1000)
  const matches = readKind<any>('match', limit)
  const timelines = readKind<any>('timeline', limit)

  const championStatsKeys = new Map<string, number>()

  let matchesUsed = 0
  let laneGames = 0

  // A: jungler lane-presence sampling
  let junglerSamples = 0 // frames where enemy jungler was in a laner's lane
  let junglerSamplesFollowedByDeath = 0
  let junglerSamplesFollowedByGankDeath = 0
  let framesChecked = 0
  const visitsPerGame: number[] = []

  // Baseline for A: if the jungler is NOT sampled in lane, how often does the
  // laner die to a gank in that same window? If this is close to the
  // conditional rate above, the sample carries no information.
  let noVisitWindows = 0
  let noVisitGankDeaths = 0

  // B: assist- vs damage-based attribution of gank deaths
  let gankDeathsAssistBased = 0
  let gankDeathsDamageBased = 0
  let damageOnly = 0
  let assistOnly = 0

  // C: turned it around
  let turnedAround = 0
  let turnedAroundTraded = 0 // ganker died but so did the player
  const turnedAroundPerGame: number[] = []

  // D: gank-proof
  let gankProof = 0
  let junglerActiveGames = 0
  let playerGames = 0
  const gankProofByThreshold = new Map<number, { qualified: number; clean: number }>()
  const survivedVisitsByThreshold = new Map<number, { qualified: number; clean: number }>()

  for (const [matchId, match] of matches) {
    const timeline = timelines.get(matchId)
    if (!timeline) continue
    if (match.info?.gameMode !== 'CLASSIC') continue
    const participants = match.info?.participants ?? []
    if (participants.length !== 10) continue
    matchesUsed++

    const roleById = new Map<number, string>()
    const teamById = new Map<number, number>()
    for (const p of participants) {
      roleById.set(p.participantId, p.teamPosition || p.individualPosition || '')
      teamById.set(p.participantId, p.teamId)
    }

    // The enemy jungler, per team: junglerOfTeam[teamId] = participantId
    const junglerOfTeam = new Map<number, number>()
    for (const p of participants) {
      if ((p.teamPosition || p.individualPosition) === 'JUNGLE') {
        junglerOfTeam.set(p.teamId, p.participantId)
      }
    }

    // --- collect kills ---
    const kills: Kill[] = []
    const frames: Array<{ timestampMs: number; positions: Map<number, Pt> }> = []

    for (const frame of timeline.info?.frames ?? []) {
      const positions = new Map<number, Pt>()
      for (const pf of Object.values(frame.participantFrames ?? {}) as any[]) {
        for (const k of Object.keys(pf.championStats ?? {})) {
          championStatsKeys.set(k, (championStatsKeys.get(k) ?? 0) + 1)
        }
        if (pf.position) positions.set(pf.participantId, pf.position)
      }
      frames.push({ timestampMs: frame.timestamp, positions })

      for (const ev of (frame.events ?? []) as any[]) {
        if (ev.type !== 'CHAMPION_KILL') continue
        if (ev.timestamp > EARLY_MS) continue
        if (!ev.victimId || !ev.position) continue
        const victimTeam = teamById.get(ev.victimId)
        const damagerIds = new Set<number>()
        for (const d of (ev.victimDamageReceived ?? []) as any[]) {
          const id = d.participantId
          if (typeof id !== 'number' || id < 1 || id > 10) continue
          if (teamById.get(id) === victimTeam) continue // own-team damage, ignore
          const total = (d.magicDamage ?? 0) + (d.physicalDamage ?? 0) + (d.trueDamage ?? 0)
          if (total > 0) damagerIds.add(id)
        }
        kills.push({
          timestampMs: ev.timestamp,
          killerId: ev.killerId ?? 0,
          victimId: ev.victimId,
          assistIds: ev.assistingParticipantIds ?? [],
          damagerIds: [...damagerIds],
          position: ev.position
        })
      }
    }

    /** Enemies involved in a kill, by the chosen attribution method. */
    const enemiesInvolved = (k: Kill, method: 'assist' | 'damage'): number[] => {
      const victimTeam = teamById.get(k.victimId)
      if (method === 'damage') return k.damagerIds
      const ids = [k.killerId, ...k.assistIds].filter((id) => id > 0)
      return ids.filter((id) => teamById.get(id) !== victimTeam)
    }

    /** Is this kill a gank death for the victim, under the given attribution? */
    const isGankDeath = (k: Kill, method: 'assist' | 'damage'): boolean => {
      const role = roleById.get(k.victimId) ?? ''
      const lane = laneForRole(role)
      if (!lane) return false
      if (distToLane(k.position, lane) > LANE_HALF_WIDTH) return false
      const expected = expectedOpponentRoles(role)
      return enemiesInvolved(k, method).some((id) => !expected.includes(roleById.get(id) ?? ''))
    }

    for (const k of kills) {
      const a = isGankDeath(k, 'assist')
      const d = isGankDeath(k, 'damage')
      if (a) gankDeathsAssistBased++
      if (d) gankDeathsDamageBased++
      if (d && !a) damageOnly++
      if (a && !d) assistOnly++
    }

    // --- per-laner analysis ---
    for (const p of participants) {
      const role = roleById.get(p.participantId) ?? ''
      const lane = laneForRole(role)
      if (!lane) continue
      laneGames++
      playerGames++

      const myTeam = p.teamId
      const enemyJungler = junglerOfTeam.get(myTeam === 100 ? 200 : 100)

      const myDeaths = kills.filter((k) => k.victimId === p.participantId)
      const myGankDeaths = myDeaths.filter((k) => isGankDeath(k, 'damage'))

      // --- A: jungler lane-presence sampling ---
      let visits = 0
      if (enemyJungler !== undefined) {
        for (const frame of frames) {
          if (frame.timestampMs > EARLY_MS) continue
          if (frame.timestampMs === 0) continue // spawn, everyone is in base
          const jPos = frame.positions.get(enemyJungler)
          if (!jPos) continue
          framesChecked++
          const inMyLane = distToLane(jPos, lane) <= LANE_HALF_WIDTH
          const diedNear = myDeaths.some(
            (k) => Math.abs(k.timestampMs - frame.timestampMs) <= VISIT_DEATH_WINDOW_MS
          )
          const gankDiedNear = myGankDeaths.some(
            (k) => Math.abs(k.timestampMs - frame.timestampMs) <= VISIT_DEATH_WINDOW_MS
          )
          if (inMyLane) {
            visits++
            junglerSamples++
            if (diedNear) junglerSamplesFollowedByDeath++
            if (gankDiedNear) junglerSamplesFollowedByGankDeath++
          } else {
            noVisitWindows++
            if (gankDiedNear) noVisitGankDeaths++
          }
        }
      }
      visitsPerGame.push(visits)

      // --- C: turned it around (a third party died in my lane) ---
      const expected = expectedOpponentRoles(role)
      let turns = 0
      for (const k of kills) {
        if (teamById.get(k.victimId) === myTeam) continue // an enemy must be the victim
        const victimRole = roleById.get(k.victimId) ?? ''
        if (expected.includes(victimRole)) continue // lane opponent dying is just lane
        if (distToLane(k.position, lane) > LANE_HALF_WIDTH) continue
        // I must have taken part, otherwise it's my jungler's kill, not my save.
        const iTookPart =
          k.killerId === p.participantId ||
          k.assistIds.includes(p.participantId) ||
          k.damagerIds.includes(p.participantId)
        if (!iTookPart) continue
        const iDiedInTrade = myDeaths.some(
          (d) => Math.abs(d.timestampMs - k.timestampMs) <= TRADE_WINDOW_MS
        )
        if (iDiedInTrade) turnedAroundTraded++
        else {
          turns++
          turnedAround++
        }
      }
      turnedAroundPerGame.push(turns)

      // --- D: gank-proof (jungler ganked others, never me) ---
      if (enemyJungler !== undefined) {
        const teammateGanks = kills.filter((k) => {
          if (teamById.get(k.victimId) !== myTeam) return false
          if (k.victimId === p.participantId) return false
          if (!isGankDeath(k, 'damage')) return false
          return k.damagerIds.includes(enemyJungler) || k.killerId === enemyJungler
        }).length
        const junglerGotMe = myGankDeaths.some(
          (k) => k.damagerIds.includes(enemyJungler) || k.killerId === enemyJungler
        )
        if (teammateGanks >= 1) {
          junglerActiveGames++
          if (!junglerGotMe) gankProof++
        }

        // How rare does "never ganked" get as the evidence of a hunting
        // jungler is tightened? Needed to pick a threshold that makes the
        // achievement mean something rather than fire in 4 games out of 10.
        for (const n of [1, 2, 3]) {
          if (teammateGanks >= n) {
            const e = gankProofByThreshold.get(n) ?? { qualified: 0, clean: 0 }
            e.qualified++
            if (!junglerGotMe) e.clean++
            gankProofByThreshold.set(n, e)
          }
        }
      }

      // Alternative evidence of pressure: sampled visits rather than kills on
      // teammates. "The jungler kept showing up and never got me."
      for (const n of [2, 3, 4]) {
        if (visits >= n) {
          const e = survivedVisitsByThreshold.get(n) ?? { qualified: 0, clean: 0 }
          e.qualified++
          if (myGankDeaths.length === 0) e.clean++
          survivedVisitsByThreshold.set(n, e)
        }
      }
    }
  }

  console.log(`matches used (CLASSIC, 10p, with timeline): ${matchesUsed}`)
  console.log(`laner-games analysed                      : ${laneGames}`)

  console.log('\n--- championStats fields (is health per-frame available?) ---')
  const statKeys = [...championStatsKeys.keys()].sort()
  console.log('  ' + statKeys.join(', '))
  console.log(
    `  health present: ${statKeys.includes('health') ? 'YES' : 'no'}   healthMax present: ${statKeys.includes('healthMax') ? 'YES' : 'no'}`
  )

  console.log('\n--- A: does a frame-sampled jungler visit predict anything? ---')
  console.log(`frames checked (pre-15min, per laner)     : ${framesChecked}`)
  console.log(
    `enemy jungler sampled inside my lane     : ${junglerSamples}  ${pct(junglerSamples, framesChecked)}`
  )
  console.log(
    `  ...and I died within ${VISIT_DEATH_WINDOW_MS / 1000}s            : ${junglerSamplesFollowedByDeath}  ${pct(junglerSamplesFollowedByDeath, junglerSamples)}`
  )
  console.log(
    `  ...and I died TO A GANK within ${VISIT_DEATH_WINDOW_MS / 1000}s   : ${junglerSamplesFollowedByGankDeath}  ${pct(junglerSamplesFollowedByGankDeath, junglerSamples)}`
  )
  console.log(
    `baseline: jungler NOT in my lane         : ${noVisitWindows} windows, gank death in ${noVisitGankDeaths}  ${pct(noVisitGankDeaths, noVisitWindows)}`
  )
  const lift =
    noVisitWindows > 0 && junglerSamples > 0
      ? junglerSamplesFollowedByGankDeath / junglerSamples / (noVisitGankDeaths / noVisitWindows)
      : 0
  console.log(`=> lift: a sampled visit makes a gank death ${lift.toFixed(1)}x more likely`)

  const visitDist: Record<number, number> = {}
  for (const v of visitsPerGame) visitDist[Math.min(v, 4)] = (visitDist[Math.min(v, 4)] ?? 0) + 1
  console.log('\n  sampled visits per laner-game (4 = 4 or more):')
  for (const k of Object.keys(visitDist).sort()) {
    console.log(
      `    ${k}: ${String(visitDist[Number(k)]).padStart(6)}   ${pct(visitDist[Number(k)], visitsPerGame.length)}`
    )
  }

  console.log('\n--- B: assist-based vs damage-based attribution ---')
  console.log(`gank deaths via assistingParticipantIds  : ${gankDeathsAssistBased}`)
  console.log(`gank deaths via victimDamageReceived     : ${gankDeathsDamageBased}`)
  console.log(`  found ONLY by damage (assists missed)  : ${damageOnly}`)
  console.log(`  found ONLY by assists (damage missed)  : ${assistOnly}`)

  console.log('\n--- C: turned it around (third party died in my lane) ---')
  console.log(`clean turnarounds (they died, I did not) : ${turnedAround}`)
  console.log(`traded (they died but so did I)          : ${turnedAroundTraded}`)
  const turnDist: Record<number, number> = {}
  for (const v of turnedAroundPerGame)
    turnDist[Math.min(v, 3)] = (turnDist[Math.min(v, 3)] ?? 0) + 1
  console.log('  clean turnarounds per laner-game (3 = 3 or more):')
  for (const k of Object.keys(turnDist).sort()) {
    console.log(
      `    ${k}: ${String(turnDist[Number(k)]).padStart(6)}   ${pct(turnDist[Number(k)], turnedAroundPerGame.length)}`
    )
  }

  console.log('\n--- D: gank-proof (jungler ganked my team, never me) ---')
  console.log(`laner-games where enemy jungler landed a`)
  console.log(`  gank on SOMEONE on my team             : ${junglerActiveGames}  ${pct(junglerActiveGames, playerGames)}`)
  console.log(
    `  ...and never got me                    : ${gankProof}  ${pct(gankProof, junglerActiveGames)} of those`
  )
  console.log(`  as a share of all laner-games          : ${pct(gankProof, playerGames)}`)

  console.log('\n  tightening the evidence, to make "never ganked" mean something:')
  console.log('    jungler ganked my team N+ times   qualifying games   never got me')
  for (const n of [1, 2, 3]) {
    const e = gankProofByThreshold.get(n) ?? { qualified: 0, clean: 0 }
    console.log(
      `      N >= ${n}                          ${String(e.qualified).padStart(14)}   ${String(e.clean).padStart(6)}  ${pct(e.clean, playerGames)} of all laner-games`
    )
  }

  console.log('\n  alternative evidence -- sampled visits instead of kills:')
  console.log('    jungler sampled in my lane N+ times   qualifying   zero gank deaths')
  for (const n of [2, 3, 4]) {
    const e = survivedVisitsByThreshold.get(n) ?? { qualified: 0, clean: 0 }
    console.log(
      `      N >= ${n}                              ${String(e.qualified).padStart(8)}   ${String(e.clean).padStart(6)}  ${pct(e.clean, playerGames)} of all laner-games`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
