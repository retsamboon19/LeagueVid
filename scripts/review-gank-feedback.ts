// Reads the gank verdicts collected from the stats panel and checks them
// against what the shipped analyzer currently reports.
//
// This is the only ground truth available for gank detection: every other
// number in the pipeline is derived from Riot's once-a-minute position samples,
// which is exactly the thing under suspicion. A verdict says "this detected
// gank was real" or "this one wasn't", per event, judged against the video.
//
// Read-only. Never writes to the database.
//
// Usage: npx tsx scripts/review-gank-feedback.ts

import initSqlJs from 'sql.js'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { analyzeGanks } from '../src/main/riot/gankAnalyzer'
import type { MatchDto, MatchTimelineDto } from '../src/main/riot/types'
import type { GankEvent } from '../src/shared/types'

const APP_DIR = join(homedir(), 'AppData', 'Roaming', 'leaguevid')
const CACHE_ROOT = join(APP_DIR, 'riot-api-cache')
const DB_PATH = join(APP_DIR, 'leaguevid.db')
const DATASET_ROOT = join(__dirname, '..', 'dataset')

interface FeedbackRow {
  match_id: string
  participant_id: number
  timestamp_ms: number
  outcome: string
  ganker_ids: string | null
  verdict: string
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

function findCached<T>(kind: 'match' | 'timeline', matchId: string): T | null {
  for (const base of [CACHE_ROOT, DATASET_ROOT]) {
    const root = join(base, kind)
    if (!existsSync(root)) continue
    for (const region of readdirSync(root, { withFileTypes: true })) {
      if (!region.isDirectory()) continue
      const p = join(root, region.name, `${matchId}.json`)
      if (existsSync(p)) {
        const v = readJson<T>(p)
        if (v) return v
      }
    }
  }
  return null
}

function fmt(ms: number): string {
  const t = Math.round(ms / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`)
    process.exit(1)
  }

  const SQL = await initSqlJs({
    locateFile: (f) => join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
  })
  const db = new SQL.Database(readFileSync(DB_PATH))

  let rows: FeedbackRow[] = []
  try {
    const res = db.exec(
      `SELECT match_id, participant_id, timestamp_ms, outcome, ganker_ids, verdict
       FROM gank_feedback ORDER BY match_id, participant_id, timestamp_ms`
    )
    const cols = res[0]?.columns ?? []
    rows = (res[0]?.values ?? []).map((v) => {
      const o: Record<string, unknown> = {}
      cols.forEach((c, i) => (o[c] = v[i]))
      return o as unknown as FeedbackRow
    })
  } finally {
    db.close()
  }

  if (rows.length === 0) {
    console.log('No gank feedback recorded yet -- nothing to calibrate against.')
    return
  }

  const accurate = rows.filter((r) => r.verdict === 'accurate').length
  const wrong = rows.filter((r) => r.verdict === 'wrong').length

  console.log(`=== Gank feedback: ${rows.length} verdicts ===`)
  console.log(`  accurate: ${accurate}`)
  console.log(`  wrong   : ${wrong}`)
  console.log(`  precision (accurate / total): ${((accurate / rows.length) * 100).toFixed(1)}%\n`)

  // Verdicts grouped by the outcome the analyzer claimed, since the three
  // detection paths (kill-event deaths, sampled attempts, turnarounds) can be
  // right or wrong independently -- a precision figure blended across them
  // would hide which path is actually misfiring.
  console.log('=== By claimed outcome ===')
  const outcomes = [...new Set(rows.map((r) => r.outcome))].sort()
  for (const outcome of outcomes) {
    const list = rows.filter((r) => r.outcome === outcome)
    const ok = list.filter((r) => r.verdict === 'accurate').length
    const bad = list.filter((r) => r.verdict === 'wrong').length
    console.log(
      `  ${outcome.padEnd(15)} n=${String(list.length).padStart(3)}  accurate=${String(ok).padStart(3)}  wrong=${String(bad).padStart(3)}  precision=${list.length ? ((ok / list.length) * 100).toFixed(1) : 'n/a'}%`
    )
  }

  // --- Do the judged events still exist in the current analyzer output? ---
  //
  // Feedback is keyed on (match, participant, exact game-time ms) because gank
  // stats are recomputed on every panel open and never persisted. If a change
  // to the analyzer makes a judged gank stop being detected, the verdict is
  // still evidence -- of a regression, or of a fix, depending on the verdict.
  console.log('\n=== Are judged events still detected by the current analyzer? ===')

  const byMatch = new Map<string, FeedbackRow[]>()
  for (const r of rows) {
    const list = byMatch.get(r.match_id) ?? []
    list.push(r)
    byMatch.set(r.match_id, list)
  }

  let stillDetected = 0
  let noLongerDetected = 0
  let missingData = 0
  const survivors: FeedbackRow[] = []
  const lost: FeedbackRow[] = []

  for (const [matchId, list] of byMatch) {
    const match = findCached<MatchDto>('match', matchId)
    const timeline = findCached<MatchTimelineDto>('timeline', matchId)
    if (!match || !timeline) {
      missingData += list.length
      console.log(`  ${matchId}: match or timeline not cached, skipping ${list.length} verdict(s)`)
      continue
    }

    const stats = analyzeGanks(
      timeline.info?.frames ?? [],
      (match.info.participants ?? []).map((p) => ({
        participantId: p.participantId,
        teamId: p.teamId,
        role: p.teamPosition || p.individualPosition || ''
      }))
    )

    for (const r of list) {
      const mine = stats[r.participant_id]
      const events: GankEvent[] = mine?.gankEvents ?? []
      // Exact-ms match, mirroring how the UI keys feedback onto a row.
      const hit = events.find((e) => Math.round(e.timestampMs) === Math.round(r.timestamp_ms))
      if (hit) {
        stillDetected++
        survivors.push(r)
      } else {
        noLongerDetected++
        lost.push(r)
      }
    }
  }

  console.log(`  still detected     : ${stillDetected}`)
  console.log(`  no longer detected : ${noLongerDetected}`)
  if (missingData > 0) console.log(`  unevaluable        : ${missingData}`)

  if (lost.length > 0) {
    console.log('\n  Judged events the analyzer no longer emits:')
    for (const r of lost) {
      console.log(
        `    ${r.match_id} p${r.participant_id} ${fmt(r.timestamp_ms)} claimed=${r.outcome} verdict=${r.verdict}` +
          (r.verdict === 'wrong' ? '   <- GOOD: a false positive that is now gone' : '   <- BAD: a real gank now missed')
      )
    }
  }

  // --- The headline number: precision on events that currently fire ---
  if (survivors.length > 0) {
    const ok = survivors.filter((r) => r.verdict === 'accurate').length
    console.log(
      `\n=== Precision on currently-detected events: ${ok}/${survivors.length} = ${((ok / survivors.length) * 100).toFixed(1)}% ===`
    )
    for (const outcome of outcomes) {
      const list = survivors.filter((r) => r.outcome === outcome)
      if (list.length === 0) continue
      const good = list.filter((r) => r.verdict === 'accurate').length
      console.log(
        `  ${outcome.padEnd(15)} ${good}/${list.length} = ${((good / list.length) * 100).toFixed(1)}%`
      )
    }
  }

  console.log('\n--- All verdicts ---')
  for (const r of rows) {
    console.log(
      `  ${r.match_id} p${String(r.participant_id).padStart(2)} ${fmt(r.timestamp_ms).padStart(5)} ` +
        `${r.outcome.padEnd(14)} ${r.verdict.padEnd(8)} gankers=${r.ganker_ids ?? '-'}`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
