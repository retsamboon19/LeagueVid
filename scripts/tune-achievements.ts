// Calibration harness for the achievement rules.
//
// Runs the real engine across every match cached on disk and reports, per
// rule, how often it fires. A rule that fires in 90% of games isn't an
// achievement, it's a participation trophy; one that fires in 0% is dead
// weight. This is the only way to set thresholds honestly, since Riot doesn't
// publish population percentiles.
//
// Read-only: touches nothing but the cache, makes no API calls.
//
// Usage:
//   npx tsx scripts/tune-achievements.ts                 # all cached matches
//   npx tsx scripts/tune-achievements.ts --role TOP      # one role only
//   npx tsx scripts/tune-achievements.ts --champion Yorick
//   npx tsx scripts/tune-achievements.ts --puuid <puuid>
//   npx tsx scripts/tune-achievements.ts --distributions # stat percentiles
//   npx tsx scripts/tune-achievements.ts --sample 5      # show example tiles

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ACHIEVEMENTS, buildMatchFacts, selectAchievements } from '../src/renderer/src/lib/achievements'
import type { MatchFacts } from '../src/renderer/src/lib/achievements'
import type { MatchDto, MatchTimelineDto } from '../src/main/riot/types'
import type { MatchStats } from '../src/shared/types'

const CACHE_ROOT = join(homedir(), 'AppData', 'Roaming', 'leaguevid', 'riot-api-cache')

// Only queues where the achievement thresholds are meant to apply. ARAM and
// the rotating modes have completely different CS/vision/gold economies, so
// mixing them in would poison every percentile.
const SUMMONERS_RIFT_QUEUES = new Set([400, 420, 430, 440, 700])

interface Args {
  role: string | null
  champion: string | null
  puuid: string | null
  distributions: boolean
  sample: number
  includeAllQueues: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    role: get('--role')?.toUpperCase() ?? null,
    champion: get('--champion'),
    puuid: get('--puuid'),
    distributions: argv.includes('--distributions'),
    sample: Number(get('--sample') ?? 0),
    includeAllQueues: argv.includes('--all-queues')
  }
}

function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkJson(full))
    else if (entry.name.endsWith('.json')) out.push(full)
  }
  return out
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

// --- Rebuild the MatchStats payload the renderer would receive -------------
// This mirrors main/riot/matchStats.ts. It deliberately re-implements the
// subset the achievement engine reads rather than importing that module,
// which depends on Electron's `app` for cache paths and can't run here.

function buildStats(match: MatchDto, timeline: MatchTimelineDto | null, ownerPuuid: string): MatchStats {
  const frames = timeline?.info?.frames ?? []
  const hasTimeline = frames.length > 0
  const participants = match.info.participants ?? []

  const challengeOf = (p: (typeof participants)[number]): Record<string, number> | null =>
    (p.challenges as Record<string, number> | undefined) ?? null

  const statsParticipants = participants.map((p) => ({
    puuid: p.puuid,
    participantId: p.participantId,
    teamId: p.teamId,
    displayName: p.riotIdGameName ?? null,
    championName: p.championName,
    champLevel: p.champLevel ?? 0,
    teamPosition: p.teamPosition || p.individualPosition || '',
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    cs: p.totalMinionsKilled + p.neutralMinionsKilled,
    goldEarned: p.goldEarned,
    damageToChampions: p.totalDamageDealtToChampions ?? 0,
    damageTaken: p.totalDamageTaken ?? 0,
    damageSelfMitigated: p.damageSelfMitigated ?? 0,
    damageToObjectives: p.damageDealtToObjectives ?? 0,
    damageToTurrets: p.damageDealtToTurrets ?? 0,
    visionScore: p.visionScore ?? 0,
    wardsPlaced: p.wardsPlaced ?? 0,
    wardsKilled: p.wardsKilled ?? 0,
    controlWardsPlaced: p.detectorWardsPlaced ?? 0,
    turretKills: p.turretKills ?? 0,
    largestMultiKill: p.largestMultiKill ?? 0,
    largestKillingSpree: p.largestKillingSpree ?? 0,
    timeCCingOthers: p.timeCCingOthers ?? 0,
    totalHeal: p.totalHeal ?? 0,
    healsOnTeammates: p.totalHealsOnTeammates ?? 0,
    shieldedOnTeammates: p.totalDamageShieldedOnTeammates ?? 0,
    longestTimeSpentLiving: p.longestTimeSpentLiving ?? 0,
    totalTimeSpentDead: p.totalTimeSpentDead ?? 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
    summoner1Id: p.summoner1Id,
    summoner2Id: p.summoner2Id,
    perks: [],
    challenges: challengeOf(p),
    skillOrder: [],
    itemPurchases: []
  }))

  const byTeam = new Map<number, typeof participants>()
  for (const p of participants) {
    const list = byTeam.get(p.teamId) ?? []
    list.push(p)
    byTeam.set(p.teamId, list)
  }
  const teams = [...byTeam.entries()].map(([teamId, members]) => ({
    teamId,
    win: members[0]?.win ?? false,
    kills: members.reduce((s, p) => s + p.kills, 0),
    deaths: members.reduce((s, p) => s + p.deaths, 0),
    assists: members.reduce((s, p) => s + p.assists, 0),
    goldEarned: members.reduce((s, p) => s + p.goldEarned, 0)
  }))

  const focusId = participants.find((p) => p.puuid === ownerPuuid)?.participantId ?? 0

  const objectives: MatchStats['objectives'] = []
  if (hasTimeline) {
    for (const frame of frames) {
      for (const ev of frame.events ?? []) {
        if (ev.type !== 'ELITE_MONSTER_KILL' && ev.type !== 'BUILDING_KILL') continue
        const isMonster = ev.type === 'ELITE_MONSTER_KILL'
        const monster = (ev.monsterType ?? '').toUpperCase()
        const kind = isMonster
          ? monster === 'DRAGON'
            ? 'dragon'
            : monster === 'RIFTHERALD' || monster === 'HORDE'
              ? 'herald'
              : monster === 'BARON_NASHOR'
                ? 'baron'
                : monster === 'ATAKHAN'
                  ? 'atakhan'
                  : 'objective'
          : ev.buildingType === 'INHIBITOR_BUILDING'
            ? 'inhibitor'
            : 'turret'
        const assistIds = ev.assistingParticipantIds ?? []
        objectives.push({
          timestampMs: ev.timestamp,
          kind,
          label: kind,
          teamId: ev.teamId ?? 0,
          participated: ev.killerId === focusId || assistIds.includes(focusId)
        })
      }
    }
  }

  return {
    matchId: match.metadata?.matchId ?? '',
    gameDurationSeconds: match.info.gameDuration,
    gameMode: match.info.gameMode,
    gameVersion: match.info.gameVersion,
    hasTimeline,
    ownerPuuid,
    teams,
    participants: statsParticipants,
    frames: hasTimeline
      ? frames.map((f) => ({
          timestampMs: f.timestamp,
          participants: Object.values(f.participantFrames ?? {}).map((pf) => ({
            participantId: pf.participantId,
            totalGold: pf.totalGold ?? 0,
            xp: pf.xp ?? 0,
            cs: (pf.minionsKilled ?? 0) + (pf.jungleMinionsKilled ?? 0),
            level: pf.level ?? 0,
            damageToChampions: pf.damageStats?.totalDamageDoneToChampions ?? 0
          }))
        }))
      : [],
    // Heuristics need the timeline analyzer, which imports cleanly. Filled in
    // by the caller so this function stays dependency-light.
    heuristicsByParticipant: {},
    earlyPhaseByParticipant: hasTimeline ? earlyPhaseFromFrames(frames, statsParticipants.map((p) => p.participantId)) : {},
    objectives
  }
}

/** Mirrors extractEarlyPhase in main/riot/matchStats.ts. */
function earlyPhaseFromFrames(
  frames: MatchTimelineDto['info']['frames'],
  participantIds: number[]
): MatchStats['earlyPhaseByParticipant'] {
  const out: MatchStats['earlyPhaseByParticipant'] = {}
  for (const id of participantIds) out[id] = { kills: 0, deaths: 0, assists: 0 }
  for (const frame of frames) {
    for (const ev of frame.events ?? []) {
      if (ev.type !== 'CHAMPION_KILL' || ev.timestamp > 15 * 60 * 1000) continue
      const killerId = ev.killerId ?? 0
      if (killerId > 0 && out[killerId]) out[killerId].kills++
      if (ev.victimId && out[ev.victimId]) out[ev.victimId].deaths++
      for (const a of ev.assistingParticipantIds ?? []) if (out[a]) out[a].assists++
    }
  }
  return out
}

// --- Which account is "me" -------------------------------------------------
// Inferred rather than configured: the puuid appearing in the most cached
// matches is the owner, since the cache is built from their match history.

function inferOwnerPuuid(matches: MatchDto[]): string | null {
  const counts = new Map<string, number>()
  for (const m of matches) {
    for (const p of m.info.participants ?? []) {
      counts.set(p.puuid, (counts.get(p.puuid) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [puuid, count] of counts) {
    if (count > bestCount) {
      best = puuid
      bestCount = count
    }
  }
  return bestCount >= 2 ? best : null
}

// --- Stats helpers ---------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

function describeDistribution(label: string, values: number[]): string {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return `${label.padEnd(26)} no data`
  const f = (v: number): string => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1))
  return (
    `${label.padEnd(26)} n=${String(clean.length).padStart(4)}  ` +
    `p10=${f(percentile(clean, 10)).padStart(8)}  ` +
    `p25=${f(percentile(clean, 25)).padStart(8)}  ` +
    `p50=${f(percentile(clean, 50)).padStart(8)}  ` +
    `p75=${f(percentile(clean, 75)).padStart(8)}  ` +
    `p90=${f(percentile(clean, 90)).padStart(8)}  ` +
    `p95=${f(percentile(clean, 95)).padStart(8)}`
  )
}

// --- Main -----------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs()

  const matchPaths = walkJson(join(CACHE_ROOT, 'match'))
  if (matchPaths.length === 0) {
    console.error(`No cached matches found under ${CACHE_ROOT}`)
    process.exit(1)
  }
  console.log(`Reading ${matchPaths.length} cached matches from ${CACHE_ROOT}\n`)

  const matches: Array<{ match: MatchDto; path: string }> = []
  for (const path of matchPaths) {
    const match = readJson<MatchDto>(path)
    if (match?.info?.participants?.length) matches.push({ match, path })
  }

  const ownerPuuid = args.puuid ?? inferOwnerPuuid(matches.map((m) => m.match))
  if (!ownerPuuid) {
    console.error('Could not infer which account owns this cache. Pass --puuid.')
    process.exit(1)
  }

  // The teamfight analyzer is pure and importable, unlike matchStats.ts.
  const { analyzeAllParticipants } = await import('../src/main/riot/teamfightAnalyzer')

  const fired = new Map<string, number>()
  const factsList: MatchFacts[] = []
  const samples: string[] = []
  let evaluated = 0
  let skippedQueue = 0
  let skippedNoOwner = 0
  let skippedRemake = 0
  let noTimeline = 0
  let tileTotal = 0
  let positiveTotal = 0
  let negativeTotal = 0
  let emptyPanels = 0

  for (const { match, path } of matches) {
    const queueId = match.info.queueId
    if (!args.includeAllQueues && queueId !== undefined && !SUMMONERS_RIFT_QUEUES.has(queueId)) {
      skippedQueue++
      continue
    }

    // Remakes have no meaningful stats and would drag every distribution down.
    if (match.info.gameDuration < 300) {
      skippedRemake++
      continue
    }

    const me = match.info.participants.find((p) => p.puuid === ownerPuuid)
    if (!me) {
      skippedNoOwner++
      continue
    }

    const role = me.teamPosition || me.individualPosition || ''
    if (args.role && role !== args.role) continue
    if (args.champion && me.championName.toLowerCase() !== args.champion.toLowerCase()) continue

    const timelinePath = path.replace(`\\match\\`, `\\timeline\\`)
    const timeline = existsSync(timelinePath) ? readJson<MatchTimelineDto>(timelinePath) : null
    if (!timeline) noTimeline++

    const stats = buildStats(match, timeline, ownerPuuid)
    if (timeline?.info?.frames?.length) {
      stats.heuristicsByParticipant = analyzeAllParticipants(
        timeline.info.frames,
        stats.participants.map((p) => p.participantId)
      )
    }

    const focus = stats.participants.find((p) => p.puuid === ownerPuuid)
    if (!focus) continue

    const facts = buildMatchFacts({ stats, focus })
    factsList.push(facts)
    evaluated++

    // Tower dives come from stored tags, which this harness has no access to,
    // so that one rule can't be calibrated here. Noted in the output.
    const selection = selectAchievements(facts)
    tileTotal += selection.positive.length + selection.negative.length
    positiveTotal += selection.positive.length
    negativeTotal += selection.negative.length
    if (selection.totalEarned === 0) emptyPanels++

    for (const a of [...selection.positive, ...selection.negative]) {
      // Count what actually got DISPLAYED separately from what qualified.
      fired.set(`shown:${a.id}`, (fired.get(`shown:${a.id}`) ?? 0) + 1)
    }

    // Also count raw qualification, ignoring dedupe/caps, so a rule that is
    // permanently crowded out is still visible as "too loose".
    for (const def of ACHIEVEMENTS) {
      try {
        if (def.condition(facts, (await import('../src/renderer/src/lib/achievements')).THRESHOLDS)) {
          fired.set(def.id, (fired.get(def.id) ?? 0) + 1)
        }
      } catch {
        continue
      }
    }

    if (args.sample > 0 && samples.length < args.sample) {
      const lines = [
        `--- ${stats.matchId} | ${focus.championName} ${role} | ${facts.win ? 'WIN' : 'LOSS'} | ` +
          `${focus.kills}/${focus.deaths}/${focus.assists} | ${facts.csPerMinute.toFixed(1)} cs/m | ` +
          `${Math.round(facts.durationMinutes)}min`
      ]
      for (const a of selection.positive) lines.push(`   [+] ${a.title} -- ${a.description}`)
      for (const a of selection.negative) lines.push(`   [-] ${a.title} -- ${a.description}`)
      samples.push(lines.join('\n'))
    }
  }

  console.log(`Owner puuid: ${ownerPuuid.slice(0, 12)}...`)
  console.log(
    `Evaluated ${evaluated} matches` +
      (args.role ? ` (role ${args.role})` : '') +
      (args.champion ? ` (champion ${args.champion})` : '')
  )
  console.log(
    `Skipped: ${skippedQueue} non-SR queues, ${skippedRemake} remakes/short, ${skippedNoOwner} without owner`
  )
  console.log(`Missing timeline: ${noTimeline}`)
  console.log(
    `Average tiles shown: ${(tileTotal / Math.max(1, evaluated)).toFixed(2)} ` +
      `(${(positiveTotal / Math.max(1, evaluated)).toFixed(2)} positive, ` +
      `${(negativeTotal / Math.max(1, evaluated)).toFixed(2)} negative)`
  )
  console.log(`Matches with nothing at all: ${emptyPanels}\n`)

  // --- Firing rates -------------------------------------------------------
  const rows = ACHIEVEMENTS.map((def) => {
    const qualified = fired.get(def.id) ?? 0
    const shown = fired.get(`shown:${def.id}`) ?? 0
    return {
      id: def.id,
      title: def.title,
      category: def.category,
      qualifiedPct: (qualified / Math.max(1, evaluated)) * 100,
      shownPct: (shown / Math.max(1, evaluated)) * 100
    }
  })

  const flag = (pct: number): string => {
    if (pct === 0) return ' DEAD'
    if (pct >= 80) return ' TOO LOOSE'
    if (pct >= 60) return ' loose'
    if (pct < 2) return ' very rare'
    return ''
  }

  for (const category of ['positive', 'negative'] as const) {
    console.log(`=== ${category.toUpperCase()} rules: qualified % / shown % ===`)
    const list = rows.filter((r) => r.category === category).sort((a, b) => b.qualifiedPct - a.qualifiedPct)
    for (const r of list) {
      console.log(
        `${r.id.padEnd(22)} ${r.title.padEnd(26)} ` +
          `${r.qualifiedPct.toFixed(1).padStart(5)}%  ${r.shownPct.toFixed(1).padStart(5)}%` +
          flag(r.qualifiedPct)
      )
    }
    console.log('')
  }

  // --- Distributions ------------------------------------------------------
  if (args.distributions) {
    console.log('=== Stat distributions (for choosing thresholds) ===')
    const pick = (fn: (f: MatchFacts) => number | null): number[] =>
      factsList.map(fn).filter((v): v is number => v !== null && Number.isFinite(v))

    const lines = [
      describeDistribution('kills', pick((f) => f.kills)),
      describeDistribution('deaths', pick((f) => f.deaths)),
      describeDistribution('assists', pick((f) => f.assists)),
      describeDistribution('killParticipation', pick((f) => f.killParticipation)),
      describeDistribution('soloKills', pick((f) => f.soloKills)),
      describeDistribution('earlyKills (<15m)', pick((f) => f.earlyKills)),
      describeDistribution('earlyDeaths (<15m)', pick((f) => f.earlyDeaths)),
      describeDistribution('largestKillingSpree', pick((f) => f.largestKillingSpree)),
      describeDistribution('csPerMinute', pick((f) => f.csPerMinute)),
      describeDistribution('csAt10Min', pick((f) => f.csAt10Min)),
      describeDistribution('goldPerMinute', pick((f) => f.goldPerMinute)),
      describeDistribution('damageToChampions', pick((f) => f.damageToChampions)),
      describeDistribution('damagePerMinute', pick((f) => f.damagePerMinute)),
      describeDistribution('teamDamageShare', pick((f) => f.teamDamageShare)),
      describeDistribution('damageSelfMitigated', pick((f) => f.damageSelfMitigated)),
      describeDistribution('damageToTurrets', pick((f) => f.damageToTurrets)),
      describeDistribution('turretKills', pick((f) => f.turretKills)),
      describeDistribution('objectiveParticipations', pick((f) => f.objectiveParticipations)),
      describeDistribution('dragonTakedowns', pick((f) => f.dragonTakedowns)),
      describeDistribution('visionScore', pick((f) => f.visionScore)),
      describeDistribution('wardsPlaced', pick((f) => f.wardsPlaced)),
      describeDistribution('wardsKilled', pick((f) => f.wardsKilled)),
      describeDistribution('controlWardsPlaced', pick((f) => f.controlWardsPlaced)),
      describeDistribution('healsOnTeammates', pick((f) => f.healsOnTeammates)),
      describeDistribution('shieldedOnTeammates', pick((f) => f.shieldedOnTeammates)),
      describeDistribution('timeCCingOthers', pick((f) => f.timeCCingOthers)),
      describeDistribution('longestTimeSpentLiving', pick((f) => f.longestTimeSpentLiving)),
      describeDistribution('deadTimeShare', pick((f) => f.deadTimeShare)),
      describeDistribution('csDiffVsLaneOpp', pick((f) => f.csDiffVsLaneOpponent)),
      describeDistribution('goldDiffVsLaneOpp', pick((f) => f.goldDiffVsLaneOpponent)),
      describeDistribution('teamGoldDiff', pick((f) => f.teamGoldDiff)),
      describeDistribution('largestTeamGoldLead', pick((f) => f.largestTeamGoldLead)),
      describeDistribution('largestTeamGoldDeficit', pick((f) => f.largestTeamGoldDeficit)),
      describeDistribution('duelWinRate', pick((f) => f.duelWinRate)),
      describeDistribution('duelCount', pick((f) => f.duelCount)),
      describeDistribution('teamfightPartic.', pick((f) => f.teamfightParticipation)),
      describeDistribution('teamfightCount', pick((f) => f.teamfightCount)),
      describeDistribution('soloDeaths', pick((f) => f.soloDeaths)),
      describeDistribution('earlyCsPerMinute', pick((f) => f.earlyCsPerMinute)),
      describeDistribution('midCsPerMinute', pick((f) => f.midCsPerMinute)),
      describeDistribution(
        'csDropoff(early-mid)',
        factsList
          .filter((f) => f.earlyCsPerMinute !== null && f.midCsPerMinute !== null)
          .map((f) => (f.earlyCsPerMinute ?? 0) - (f.midCsPerMinute ?? 0))
      )
    ]
    for (const line of lines) console.log(line)
    console.log('')
  }

  // --- Role breakdown -----------------------------------------------------
  const roles = new Map<string, number>()
  for (const f of factsList) roles.set(f.role || 'UNKNOWN', (roles.get(f.role || 'UNKNOWN') ?? 0) + 1)
  console.log('=== Role mix in this sample ===')
  for (const [role, count] of [...roles.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${role.padEnd(10)} ${count} (${((count / evaluated) * 100).toFixed(1)}%)`)
  }
  console.log('')

  if (samples.length > 0) {
    console.log('=== Sample panels ===')
    for (const s of samples) console.log(s + '\n')
  }

  console.log('Note: tower_diver cannot be calibrated here -- it reads stored video tags.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
