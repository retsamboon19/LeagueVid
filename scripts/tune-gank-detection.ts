// Reports the accuracy verdicts collected from the "Gank source" list, so gank
// detection can be retuned against real judgment instead of guesswork.
//
// Gank detection is a heuristic: a third party inside the player's lane corridor,
// near them, before 15 minutes. Two knobs decide what it catches --
// LANE_HALF_WIDTH in src/main/riot/laneGeometry.ts and GANK_PROXIMITY in
// src/main/riot/gankAnalyzer.ts. The probes calibrated both statistically, but
// only the user can say whether a specific call was actually a gank.
//
// This reads those verdicts and breaks them down by outcome, because the three
// outcomes fail differently:
//
//   died          exact kill timestamp; a wrong verdict means the THIRD-PARTY or
//                 LANE test misfired, not the timing
//   turned_around exact kill timestamp; same as above
//   survived      a 60s position sample; a wrong verdict most likely means
//                 GANK_PROXIMITY is too loose and caught someone passing through
//
// Read-only. Opens the live application database, so close LeagueVid first to
// avoid reading a file mid-write.
//
// Usage: npx tsx scripts/tune-gank-detection.ts

import { existsSync } from 'fs'
import { join } from 'path'
import { closeDb, initDb } from '../src/main/db/index'
import * as repo from '../src/main/db/repository'

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const dbPath = join(process.env.APPDATA ?? '', 'leaguevid', 'leaguevid.db')
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`)
    process.exitCode = 1
    return
  }

  await initDb(dbPath)
  const summary = repo.getGankFeedbackSummary()
  const total = summary.accurate + summary.wrong

  console.log(`database: ${dbPath}`)
  console.log(`\nverdicts collected: ${total}`)

  if (total === 0) {
    console.log('\nNothing to tune against yet. Open a match in the player, go to')
    console.log('Insights > Ganks, and mark the detected ganks Right or Wrong.')
    closeDb()
    return
  }

  console.log(`  marked right : ${summary.accurate}  ${pct(summary.accurate, total)}`)
  console.log(`  marked wrong : ${summary.wrong}  ${pct(summary.wrong, total)}`)

  console.log('\n--- by detected outcome ---')
  console.log('  outcome         right   wrong   accuracy')
  const outcomes = [...new Set(summary.rows.map((r) => r.outcome))].sort()
  for (const outcome of outcomes) {
    const rows = summary.rows.filter((r) => r.outcome === outcome)
    const right = rows.filter((r) => r.verdict === 'accurate').length
    const wrong = rows.filter((r) => r.verdict === 'wrong').length
    console.log(
      `  ${outcome.padEnd(14)} ${String(right).padStart(5)}   ${String(wrong).padStart(5)}   ${pct(right, right + wrong).padStart(8)}`
    )
  }

  // 'survived' rows come from position sampling; the other two come from kill
  // events. Separating them says which mechanism needs the attention.
  const sampled = summary.rows.filter((r) => r.outcome === 'survived')
  const exact = summary.rows.filter((r) => r.outcome !== 'survived')
  const sampledWrong = sampled.filter((r) => r.verdict === 'wrong').length
  const exactWrong = exact.filter((r) => r.verdict === 'wrong').length

  console.log('\n--- what to adjust ---')
  console.log(
    `sampled attempts (position-based) : ${sampled.length} judged, ${sampledWrong} wrong  ${pct(sampledWrong, sampled.length)}`
  )
  console.log(
    `kill-based calls (exact)          : ${exact.length} judged, ${exactWrong} wrong  ${pct(exactWrong, exact.length)}`
  )

  const MIN_SAMPLE = 10
  if (sampled.length < MIN_SAMPLE && exact.length < MIN_SAMPLE) {
    console.log(
      `\nToo few verdicts to act on. Aim for at least ${MIN_SAMPLE} of a kind before changing a threshold --`
    )
    console.log('a couple of wrong calls is noise, not a signal.')
  } else {
    if (sampled.length >= MIN_SAMPLE && sampledWrong / sampled.length > 0.3) {
      console.log('\nSampled attempts are wrong more than 30% of the time.')
      console.log('  Tighten GANK_PROXIMITY in src/main/riot/gankAnalyzer.ts (currently 2000).')
      console.log('  The probe measured 1500 as the higher-precision setting.')
    }
    if (exact.length >= MIN_SAMPLE && exactWrong / exact.length > 0.2) {
      console.log('\nKill-based calls are wrong more than 20% of the time.')
      console.log('  That points at the lane test rather than the timing: try lowering')
      console.log('  LANE_HALF_WIDTH in src/main/riot/laneGeometry.ts (currently 1500).')
      console.log('  Re-run scripts/probe-gank-deaths.ts afterwards to see what the')
      console.log('  lane-duel control rate does at the new width.')
    }
    if (
      (sampled.length < MIN_SAMPLE || sampledWrong / sampled.length <= 0.3) &&
      (exact.length < MIN_SAMPLE || exactWrong / exact.length <= 0.2)
    ) {
      console.log('\nAccuracy is within the expected range. No threshold change indicated.')
    }
  }

  console.log('\n--- wrong calls, for inspection ---')
  const wrongRows = summary.rows.filter((r) => r.verdict === 'wrong')
  if (wrongRows.length === 0) {
    console.log('  none')
  } else {
    console.log('  match                  player  at        outcome         gankers')
    for (const r of wrongRows.slice(0, 40)) {
      const clock = `${Math.floor(r.timestamp_ms / 60000)}:${String(
        Math.floor((r.timestamp_ms % 60000) / 1000)
      ).padStart(2, '0')}`
      console.log(
        `  ${r.match_id.padEnd(22)} ${String(r.participant_id).padStart(6)}  ${clock.padStart(8)}  ${r.outcome.padEnd(14)}  ${r.ganker_ids ?? ''}`
      )
    }
    if (wrongRows.length > 40) console.log(`  ...and ${wrongRows.length - 40} more`)
  }

  closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
