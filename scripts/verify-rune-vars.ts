// Verifies what rune performance data actually exists in the locally cached
// Riot match data, before any UI is built on top of it.
//
// Why this exists: match-v5 exposes each rune selection as
// { perk, var1, var2, var3 }, and those numbers are believed to hold the
// same values the League client's post-game rune panel shows (Press the
// Attack total damage, Triumph health restored, and so on). That belief is
// an assumption until checked against real data -- if Riot leaves them as
// zeros, the Build tab's rune section would silently render nothing useful.
//
// Usage:
//   npx tsx scripts/verify-rune-vars.ts [pathToLeagueVidDb]
//
// Reads the database file directly and never writes to it, and never calls
// the Riot API. Deliberately does NOT go through src/main/db/index.ts:
// initDb() runs migrations, one of which clears api_cache. A read-only
// inspection script must not be able to destroy the data it inspects.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface PerkSelection {
  perk: number
  var1: number
  var2: number
  var3: number
}

interface CachedMatch {
  info?: {
    gameVersion?: string
    participants?: Array<{
      championName?: string
      perks?: {
        styles?: Array<{
          description?: string
          style?: number
          selections?: PerkSelection[]
        }>
      }
    }>
  }
}

function defaultCacheDir(): string {
  // Matches Electron's userData location for this app on Windows. Match
  // bodies are one JSON file each under cache/match/<region>/.
  return join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'cache', 'match')
}

/** Every cached match file, walking the per-region subdirectories. */
function listMatchFiles(root: string): string[] {
  const out: string[] = []
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...listMatchFiles(full))
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

async function main(): Promise<void> {
  const cacheDir = process.argv[2] ?? defaultCacheDir()
  const files = listMatchFiles(cacheDir)

  console.log(`Cache directory: ${cacheDir}`)
  console.log(`Cached match files found: ${files.length}\n`)

  if (files.length === 0) {
    console.log('No cached match data to inspect yet.')
    console.log('Leave the app open so the background download can populate the cache,')
    console.log('then run this again.')
    return
  }

  const rows = files.map((f) => [readFileSync(f, 'utf8')])

  let matchesInspected = 0
  let matchesParsed = 0
  let selectionsSeen = 0
  let selectionsWithNonZeroVar = 0

  // perk id -> what we've observed, so the label map can be written against
  // real values instead of guesswork.
  const perkObservations = new Map<
    number,
    { count: number; nonZero: number; samples: PerkSelection[]; champs: Set<string> }
  >()
  const gameVersions = new Set<string>()

  for (const row of rows) {
    matchesInspected++
    const raw = row[0]
    if (typeof raw !== 'string') continue

    let match: CachedMatch
    try {
      match = JSON.parse(raw) as CachedMatch
    } catch {
      continue
    }
    matchesParsed++

    if (match.info?.gameVersion) gameVersions.add(match.info.gameVersion)

    for (const participant of match.info?.participants ?? []) {
      for (const style of participant.perks?.styles ?? []) {
        for (const selection of style.selections ?? []) {
          selectionsSeen++
          const hasNonZero =
            (selection.var1 ?? 0) !== 0 ||
            (selection.var2 ?? 0) !== 0 ||
            (selection.var3 ?? 0) !== 0
          if (hasNonZero) selectionsWithNonZeroVar++

          const existing = perkObservations.get(selection.perk) ?? {
            count: 0,
            nonZero: 0,
            samples: [],
            champs: new Set<string>()
          }
          existing.count++
          if (hasNonZero) {
            existing.nonZero++
            if (existing.samples.length < 3) existing.samples.push(selection)
          }
          if (participant.championName) existing.champs.add(participant.championName)
          perkObservations.set(selection.perk, existing)
        }
      }
    }
  }

  console.log('--- Summary ---')
  console.log(`Matches inspected:                 ${matchesInspected}`)
  console.log(`Matches parsed successfully:        ${matchesParsed}`)
  console.log(`Rune selections seen:              ${selectionsSeen}`)
  console.log(`Selections with a non-zero var:    ${selectionsWithNonZeroVar}`)
  console.log(`Distinct perk ids seen:            ${perkObservations.size}`)
  if (gameVersions.size > 0) {
    console.log(`Game versions present:             ${[...gameVersions].sort().join(', ')}`)
  }
  console.log('')

  if (selectionsWithNonZeroVar === 0) {
    console.log('VERDICT: rune performance values are UNAVAILABLE in the cached data.');
    console.log('Every var1/var2/var3 came back as 0 (or absent). The Build tab should')
    console.log('show runes without performance numbers rather than showing zeros.')
    return
  }

  console.log('VERDICT: rune performance values ARE present.')
  console.log(
    `${((selectionsWithNonZeroVar / selectionsSeen) * 100).toFixed(1)}% of selections carry a non-zero value.`
  )
  console.log('(Runes with no measurable effect legitimately report zeros, so less')
  console.log('than 100% is expected -- stat shards and defensive runes especially.)\n')

  console.log('--- Per-perk observations (sorted by frequency) ---')
  console.log('Use this to write the label map in src/renderer/src/lib/runeLabels.ts.')
  console.log('perkId  seen  nonZero  sample var1/var2/var3')
  const sorted = [...perkObservations.entries()].sort((a, b) => b[1].count - a[1].count)
  for (const [perkId, obs] of sorted) {
    const sample = obs.samples[0]
    const sampleText = sample
      ? `${sample.var1} / ${sample.var2} / ${sample.var3}`
      : '(always zero)'
    console.log(
      `${String(perkId).padEnd(7)} ${String(obs.count).padEnd(5)} ${String(obs.nonZero).padEnd(8)} ${sampleText}`
    )
  }
}

main().catch((err) => {
  console.error('Verification failed:', err)
  process.exitCode = 1
})
