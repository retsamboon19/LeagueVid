// Diagnoses a specific match where gankDeaths > 0 but gankAttempts == 0.
//
// The two counters come from completely different sources in
// src/main/riot/gankAnalyzer.ts:
//
//   gankDeaths   <- CHAMPION_KILL events, which carry an exact timestamp and
//                   an exact position. Every gank death is therefore seen.
//   gankAttempts <- participantFrames, which are sampled once every 60s. An
//                   attempt is only counted if a frame happens to land while
//                   the ganker is still standing next to you.
//
// So "0 attempts, 1 death" is reachable whenever the gank started and finished
// between two frames. This script prints the per-frame evidence so that can be
// confirmed rather than assumed.
//
// Read-only, no Riot API calls.
//
// Usage:
//   npx tsx scripts/diagnose-gank-discrepancy.ts                 # latest linked VOD
//   npx tsx scripts/diagnose-gank-discrepancy.ts SG2_156043554   # a specific match

import initSqlJs from 'sql.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { analyzeGanks } from '../src/main/riot/gankAnalyzer'
import {
  LANE_HALF_WIDTH,
  distance,
  distanceToLane,
  expectedOpponentRoles,
  laneForRole
} from '../src/main/riot/laneGeometry'
import type { MatchDto, MatchTimelineDto } from '../src/main/riot/types'

const APP_DIR = join(homedir(), 'AppData', 'Roaming', 'leaguevid')
const CACHE_ROOT = join(APP_DIR, 'riot-api-cache')
const DB_PATH = join(APP_DIR, 'leaguevid.db')
const DATASET_ROOT = join(__dirname, '..', 'dataset')

// Mirrors GANK_PROXIMITY in gankAnalyzer.ts (not exported).
const GANK_PROXIMITY = 2000
const EARLY_PHASE_END_MS = 15 * 60 * 1000

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Looks in the app cache first, then the calibration dataset. */
function findCached<T>(kind: 'match' | 'timeline', matchId: string): T | null {
  const region = matchId.split('_')[0]
  const candidates = [
    join(CACHE_ROOT, kind, 'sea', `${matchId}.json`),
    join(DATASET_ROOT, kind, 'sea', `${matchId}.json`)
  ]
  for (const base of [CACHE_ROOT, DATASET_ROOT]) {
    for (const r of ['sea', 'americas', 'asia', 'europe', region]) {
      candidates.push(join(base, kind, r, `${matchId}.json`))
    }
  }
  for (const path of candidates) {
    if (existsSync(path)) {
      const value = readJson<T>(path)
      if (value) return value
    }
  }
  return null
}

interface LatestVod {
  matchId: string
  puuid: string | null
  championName: string | null
  teamPosition: string | null
  fileName: string
}

async function findLatestVod(): Promise<LatestVod | null> {
  if (!existsSync(DB_PATH)) return null
  const SQL = await initSqlJs({
    locateFile: (f) => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(DB_PATH))
  try {
    // Latest ranked solo (420) linked VOD, newest first by when the game was played.
    const res = db.exec(`
      SELECT match_id, champion_name, team_position, file_name, queue_id, recorded_at
      FROM videos
      WHERE match_id IS NOT NULL AND queue_id = 420
      ORDER BY COALESCE(recorded_at, created_at) DESC
      LIMIT 1
    `)
    const row = res[0]?.values[0]
    if (!row) return null

    // The owning account: whichever linked puuid actually played in it.
    const settings = db.exec(`SELECT value FROM settings WHERE key = 'riotAccount'`)[0]?.values[0]?.[0]
    let puuids: string[] = []
    if (typeof settings === 'string') {
      const parsed = JSON.parse(settings) as { accounts?: Array<{ puuid: string }> }
      puuids = (parsed.accounts ?? []).map((a) => a.puuid)
    }

    const matchId = String(row[0])
    const match = findCached<MatchDto>('match', matchId)
    const mine = match?.info?.participants?.find((p) => puuids.includes(p.puuid))

    return {
      matchId,
      puuid: mine?.puuid ?? null,
      championName: (row[1] as string) ?? mine?.championName ?? null,
      teamPosition: (row[2] as string) ?? mine?.teamPosition ?? null,
      fileName: String(row[3])
    }
  } finally {
    db.close()
  }
}

function fmt(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

async function main(): Promise<void> {
  const explicitMatchId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null

  let matchId: string
  let ownerPuuid: string | null = null

  if (explicitMatchId) {
    matchId = explicitMatchId
  } else {
    const latest = await findLatestVod()
    if (!latest) {
      console.error('No linked ranked-solo VOD found. Pass a match id explicitly.')
      process.exit(1)
    }
    matchId = latest.matchId
    ownerPuuid = latest.puuid
    console.log(`Latest ranked solo VOD: ${latest.fileName}`)
    console.log(`  match ${latest.matchId} | ${latest.championName} ${latest.teamPosition}\n`)
  }

  const match = findCached<MatchDto>('match', matchId)
  const timeline = findCached<MatchTimelineDto>('timeline', matchId)
  if (!match) {
    console.error(`Match ${matchId} not found in the cache or dataset.`)
    process.exit(1)
  }
  if (!timeline) {
    console.error(`Timeline for ${matchId} not found -- gank stats need it.`)
    process.exit(1)
  }

  const participants = match.info.participants ?? []
  const frames = timeline.info?.frames ?? []
  const frameInterval = timeline.info?.frameInterval ?? 60_000

  const me = ownerPuuid
    ? participants.find((p) => p.puuid === ownerPuuid)
    : participants[0]
  if (!me) {
    console.error('Could not identify which participant is you in this match.')
    process.exit(1)
  }

  const myRole = me.teamPosition || me.individualPosition || ''
  console.log(`You: participantId=${me.participantId} ${me.championName} ${myRole} team=${me.teamId}`)
  console.log(`Timeline: ${frames.length} frames, frameInterval=${frameInterval}ms\n`)

  // --- What the shipped analyzer reports ---
  const stats = analyzeGanks(
    frames,
    participants.map((p) => ({
      participantId: p.participantId,
      teamId: p.teamId,
      role: p.teamPosition || p.individualPosition || ''
    }))
  )
  const mine = stats[me.participantId]
  console.log('--- What the app reports ---')
  if (!mine) {
    console.log('  (no gank stats: jungle or unknown role -- shown as unavailable in the UI)')
    return
  }
  console.log(`  gankDeaths       : ${mine.gankDeaths}`)
  console.log(`  gankAttempts     : ${mine.gankAttempts}`)
  console.log(`  ganksSurvived    : ${mine.ganksSurvived}`)
  console.log(`  ganksTurnedAround: ${mine.ganksTurnedAround}`)
  console.log(`  reviewable rows  : ${mine.gankEvents.length}`)
  for (const e of mine.gankEvents) {
    console.log(
      `    ${fmt(e.timestampMs)} ${e.outcome}${e.approximateTime ? ' (approx)' : ''} gankers=[${e.gankerParticipantIds.join(',')}]`
    )
  }

  const lane = laneForRole(myRole)
  if (!lane) {
    console.log('\nNo lane geometry for this role, so attempts can never be sampled.')
    return
  }

  const expected = expectedOpponentRoles(myRole)
  const roleById = new Map<number, string>()
  const teamById = new Map<number, number>()
  for (const p of participants) {
    roleById.set(p.participantId, p.teamPosition || p.individualPosition || '')
    teamById.set(p.participantId, p.teamId)
  }
  const isThirdParty = (id: number): boolean =>
    teamById.get(id) !== me.teamId && !expected.includes(roleById.get(id) ?? '')
  const thirdPartyIds = participants.map((p) => p.participantId).filter((id) => isThirdParty(id))

  console.log(`\nYour lane: ${myRole} | expected opponents: [${expected.join(', ')}]`)
  console.log(
    `Third parties (anyone else on the enemy team): ${thirdPartyIds
      .map((id) => `${id}:${roleById.get(id)}`)
      .join(', ')}`
  )

  // --- Every early death of yours, with the lane/third-party test spelled out ---
  console.log('\n--- Your early deaths (from exact CHAMPION_KILL events) ---')
  let earlyDeathCount = 0
  for (const frame of frames) {
    for (const ev of frame.events ?? []) {
      if (ev.type !== 'CHAMPION_KILL') continue
      if (ev.victimId !== me.participantId) continue
      if (ev.timestamp > EARLY_PHASE_END_MS) continue
      earlyDeathCount++
      const credited = [ev.killerId ?? 0, ...(ev.assistingParticipantIds ?? [])].filter((id) => id > 0)
      const enemies = credited.filter((id) => teamById.get(id) !== me.teamId)
      const thirdParties = enemies.filter(isThirdParty)
      const laneDist = ev.position ? Math.round(distanceToLane(ev.position, lane)) : null
      const inLane = laneDist !== null && laneDist <= LANE_HALF_WIDTH
      console.log(
        `  ${fmt(ev.timestamp)}  killers/assists=[${credited
          .map((id) => `${id}:${roleById.get(id)}`)
          .join(', ')}]`
      )
      console.log(
        `           distanceToLane=${laneDist} (limit ${LANE_HALF_WIDTH}) inOwnLane=${inLane}` +
          `  thirdParties=[${thirdParties.map((id) => `${id}:${roleById.get(id)}`).join(', ')}]`
      )
      console.log(
        `           => counted as a GANK DEATH: ${inLane && thirdParties.length > 0 ? 'YES' : 'no'}`
      )
    }
  }
  if (earlyDeathCount === 0) console.log('  (none before 15:00)')

  // --- Frame-by-frame: why no attempt was sampled ---
  console.log('\n--- Frame-by-frame attempt sampling (the source of gankAttempts) ---')
  console.log('   time   yourPos            distToLane  inLane  nearbyThirdParties')
  for (const frame of frames) {
    if (frame.timestamp > EARLY_PHASE_END_MS) continue
    if (frame.timestamp === 0) continue
    const pf = Object.values(frame.participantFrames ?? {}).find(
      (p) => p.participantId === me.participantId
    )
    const myPos = pf?.position
    if (!myPos) {
      console.log(`  ${fmt(frame.timestamp).padStart(5)}   (no position reported -- dead or absent)`)
      continue
    }
    const laneDist = Math.round(distanceToLane(myPos, lane))
    const inLane = laneDist <= LANE_HALF_WIDTH
    const nearby: string[] = []
    if (inLane) {
      for (const id of thirdPartyIds) {
        const theirPf = Object.values(frame.participantFrames ?? {}).find(
          (p) => p.participantId === id
        )
        if (!theirPf?.position) continue
        const theirLaneDist = Math.round(distanceToLane(theirPf.position, lane))
        const gap = Math.round(distance(theirPf.position, myPos))
        if (theirLaneDist <= LANE_HALF_WIDTH && gap <= GANK_PROXIMITY) {
          nearby.push(`${id}:${roleById.get(id)}(gap ${gap})`)
        }
      }
    }
    console.log(
      `  ${fmt(frame.timestamp).padStart(5)}   (${String(myPos.x).padStart(5)},${String(myPos.y).padStart(5)})` +
        `      ${String(laneDist).padStart(6)}   ${inLane ? 'yes' : ' no'}    ` +
        (nearby.length > 0 ? nearby.join(', ') : '-')
    )
  }

  // --- The gap that explains the discrepancy ---
  const gankDeathTimes: number[] = []
  for (const frame of frames) {
    for (const ev of frame.events ?? []) {
      if (ev.type !== 'CHAMPION_KILL' || ev.victimId !== me.participantId) continue
      if (ev.timestamp > EARLY_PHASE_END_MS || !ev.position) continue
      const credited = [ev.killerId ?? 0, ...(ev.assistingParticipantIds ?? [])].filter((id) => id > 0)
      const enemies = credited.filter((id) => teamById.get(id) !== me.teamId)
      if (distanceToLane(ev.position, lane) <= LANE_HALF_WIDTH && enemies.some(isThirdParty)) {
        gankDeathTimes.push(ev.timestamp)
      }
    }
  }

  if (gankDeathTimes.length > 0) {
    console.log('\n--- Why the counters disagree ---')
    for (const t of gankDeathTimes) {
      const before = Math.floor(t / frameInterval) * frameInterval
      const after = before + frameInterval
      console.log(
        `  Gank death at ${fmt(t)} sits between the ${fmt(before)} and ${fmt(after)} frames.`
      )
      console.log(
        `  Attempt sampling can only see ${fmt(before)} and ${fmt(after)}; if the ganker` +
          ` wasn't already next to you at one of those instants, no attempt is recorded.`
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
