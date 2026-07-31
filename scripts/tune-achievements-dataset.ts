// Calibration harness for the achievement rules, driven by the standalone
// dataset in dataset/ (see scripts/build-dataset.ts) rather than the app's
// own riot-api-cache.
//
// The key difference from scripts/tune-achievements.ts: that script only
// ever evaluates the cache owner (one player, one role-heavy history). This
// one treats EVERY participant in every match as a focus in turn, so a
// single ranked SR match contributes up to 10 independent role-tagged
// samples instead of 1. That's what turns a few thousand of one player's
// games into real per-role coverage for JUNGLE/MIDDLE/BOTTOM/UTILITY, which
// were previously "derived" guesses -- see thresholds.ts.
//
// Read-only: touches nothing but dataset/, makes no API calls. Safe to run
// while scripts/build-dataset.ts is still fetching in the background --
// it just reads whatever's on disk at the moment it starts.
//
// Usage:
//   npx tsx scripts/tune-achievements-dataset.ts
//   npx tsx scripts/tune-achievements-dataset.ts --role UTILITY --distributions
//   npx tsx scripts/tune-achievements-dataset.ts --distributions --role JUNGLE

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { ACHIEVEMENTS, buildMatchFacts, selectAchievements, THRESHOLDS } from '../src/renderer/src/lib/achievements'
import type { MatchFacts } from '../src/renderer/src/lib/achievements'
import type { MatchDto, MatchTimelineDto } from '../src/main/riot/types'
import type { MatchStats } from '../src/shared/types'

const DATASET_ROOT = join(__dirname, '..', 'dataset')
const MATCH_ROOT = join(DATASET_ROOT, 'match')
const TIMELINE_ROOT = join(DATASET_ROOT, 'timeline')

const SUMMONERS_RIFT_QUEUES = new Set([400, 420, 430, 440, 700])
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const

interface Args {
  role: string | null
  distributions: boolean
  includeAllQueues: boolean
  maxMatches: number | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    role: get('--role')?.toUpperCase() ?? null,
    distributions: argv.includes('--distributions'),
    includeAllQueues: argv.includes('--all-queues'),
    maxMatches: get('--max-matches') ? Number(get('--max-matches')) : null
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
// Same approach as scripts/tune-achievements.ts: re-implements the subset of
// main/riot/matchStats.ts the achievement engine reads, since that module
// depends on Electron's `app` for cache paths and can't run standalone.
// `ownerPuuid` on the returned MatchStats is not meaningful here -- every
// participant is used as `focus` in turn by the caller, not just one.

function buildStats(match: MatchDto, timeline: MatchTimelineDto | null): MatchStats {
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

  // Objectives need a "participated" flag relative to some focus participant,
  // but that's recomputed per-focus below (participatedFor), so this shared
  // build leaves it false and per-participant facts don't rely on it here.
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
          participated: false, // overridden per-focus in objectivesFor()
          // stash raw ids for participatedFor() to re-derive per focus
          // (not part of the public type, so kept alongside via closure below)
          ...( { __killerId: ev.killerId ?? 0, __assistIds: assistIds } as unknown as Record<string, never>)
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
    ownerPuuid: '',
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
    heuristicsByParticipant: {},
    gankByParticipant: {},
    earlyPhaseByParticipant: {},
    objectives
  }
}

/**
 * Rebuilds the objectives list's `participated` flag for one focus
 * participant. buildStats() stashes the raw killer/assist ids on each
 * objective (outside the public MatchStats.objectives shape) specifically so
 * this can be redone cheaply per participant without re-walking timeline
 * frames each time.
 */
function objectivesFor(objectives: MatchStats['objectives'], focusParticipantId: number): MatchStats['objectives'] {
  return objectives.map((o) => {
    const raw = o as unknown as { __killerId?: number; __assistIds?: number[] }
    const participated =
      raw.__killerId === focusParticipantId || (raw.__assistIds ?? []).includes(focusParticipantId)
    return { ...o, participated }
  })
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
    `${label.padEnd(26)} n=${String(clean.length).padStart(5)}  ` +
    `p10=${f(percentile(clean, 10)).padStart(8)}  ` +
    `p25=${f(percentile(clean, 25)).padStart(8)}  ` +
    `p50=${f(percentile(clean, 50)).padStart(8)}  ` +
    `p75=${f(percentile(clean, 75)).padStart(8)}  ` +
    `p90=${f(percentile(clean, 90)).padStart(8)}  ` +
    `p95=${f(percentile(clean, 95)).padStart(8)}`
  )
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs()

  const matchPaths = walkJson(MATCH_ROOT)
  if (matchPaths.length === 0) {
    console.error(`No matches found under ${MATCH_ROOT}. Run scripts/build-dataset.ts first.`)
    process.exit(1)
  }

  const limited = args.maxMatches ? matchPaths.slice(0, args.maxMatches) : matchPaths
  console.log(`Reading ${limited.length} of ${matchPaths.length} dataset matches from ${DATASET_ROOT}\n`)

  const { analyzeAllParticipants } = await import('../src/main/riot/teamfightAnalyzer')
  const { analyzeGanks } = await import('../src/main/riot/gankAnalyzer')

  const fired = new Map<string, number>()
  // Per-role firing counts, so a rule's rarity can be read per role instead
  // of blended across a role mix that doesn't match production usage.
  const firedByRole = new Map<string, Map<string, number>>()
  const evaluatedByRole = new Map<string, number>()
  const factsList: MatchFacts[] = []

  let matchesRead = 0
  let matchesSkippedQueue = 0
  let matchesSkippedRemake = 0
  let matchesNoTimeline = 0
  let participantsEvaluated = 0
  let tileTotal = 0
  let positiveTotal = 0
  let negativeTotal = 0

  for (const matchPath of limited) {
    const match = readJson<MatchDto>(matchPath)
    if (!match?.info?.participants?.length) continue
    matchesRead++

    const queueId = match.info.queueId
    if (!args.includeAllQueues && queueId !== undefined && !SUMMONERS_RIFT_QUEUES.has(queueId)) {
      matchesSkippedQueue++
      continue
    }
    if (match.info.gameDuration < 300) {
      matchesSkippedRemake++
      continue
    }

    const relPath = relative(MATCH_ROOT, matchPath)
    const timelinePath = join(TIMELINE_ROOT, relPath)
    const timeline = existsSync(timelinePath) ? readJson<MatchTimelineDto>(timelinePath) : null
    if (!timeline) matchesNoTimeline++

    const stats = buildStats(match, timeline)
    const participantIds = stats.participants.map((p) => p.participantId)

    if (timeline?.info?.frames?.length) {
      stats.heuristicsByParticipant = analyzeAllParticipants(timeline.info.frames, participantIds)
      stats.earlyPhaseByParticipant = earlyPhaseFromFrames(timeline.info.frames, participantIds)
      // Gank stats are Summoner's Rift only, matching computeGankStats in
      // main/riot/matchStats.ts -- CLASSIC is the gameMode for SR.
      if (match.info.gameMode === 'CLASSIC') {
        stats.gankByParticipant = analyzeGanks(
          timeline.info.frames,
          match.info.participants.map((p) => ({
            participantId: p.participantId,
            teamId: p.teamId,
            role: p.teamPosition || p.individualPosition || ''
          }))
        )
      }
    }

    // Every participant becomes a focus in turn -- this is the whole point:
    // one match yields up to 10 role-tagged samples instead of 1.
    for (const focus of stats.participants) {
      const role = focus.teamPosition || ''
      if (args.role && role !== args.role) continue

      const statsForFocus: MatchStats = {
        ...stats,
        objectives: objectivesFor(stats.objectives, focus.participantId)
      }

      let facts: MatchFacts
      try {
        facts = buildMatchFacts({ stats: statsForFocus, focus })
      } catch {
        continue
      }

      factsList.push(facts)
      participantsEvaluated++
      evaluatedByRole.set(role, (evaluatedByRole.get(role) ?? 0) + 1)

      const selection = selectAchievements(facts)
      tileTotal += selection.positive.length + selection.negative.length
      positiveTotal += selection.positive.length
      negativeTotal += selection.negative.length

      for (const a of [...selection.positive, ...selection.negative]) {
        fired.set(`shown:${a.id}`, (fired.get(`shown:${a.id}`) ?? 0) + 1)
      }

      const roleMap = firedByRole.get(role) ?? new Map<string, number>()
      for (const def of ACHIEVEMENTS) {
        try {
          if (def.condition(facts, THRESHOLDS)) {
            fired.set(def.id, (fired.get(def.id) ?? 0) + 1)
            roleMap.set(def.id, (roleMap.get(def.id) ?? 0) + 1)
          }
        } catch {
          continue
        }
      }
      firedByRole.set(role, roleMap)
    }
  }

  console.log(
    `Matches read: ${matchesRead}  ` +
      `(skipped ${matchesSkippedQueue} non-SR queue, ${matchesSkippedRemake} remakes/short)`
  )
  console.log(`Matches missing a timeline: ${matchesNoTimeline}`)
  console.log(`Participant-games evaluated: ${participantsEvaluated}` + (args.role ? ` (role ${args.role})` : ''))
  console.log(
    `Average tiles shown: ${(tileTotal / Math.max(1, participantsEvaluated)).toFixed(2)} ` +
      `(${(positiveTotal / Math.max(1, participantsEvaluated)).toFixed(2)} positive, ` +
      `${(negativeTotal / Math.max(1, participantsEvaluated)).toFixed(2)} negative)\n`
  )

  console.log('=== Sample size per role ===')
  for (const role of ROLES) {
    console.log(`${role.padEnd(10)} ${evaluatedByRole.get(role) ?? 0}`)
  }
  const unknownCount = [...evaluatedByRole.entries()].filter(([r]) => !ROLES.includes(r as never)).reduce((s, [, c]) => s + c, 0)
  if (unknownCount > 0) console.log(`${'UNKNOWN'.padEnd(10)} ${unknownCount}`)
  console.log('')

  // --- Firing rates, overall -------------------------------------------------
  const rows = ACHIEVEMENTS.map((def) => {
    const qualified = fired.get(def.id) ?? 0
    const shown = fired.get(`shown:${def.id}`) ?? 0
    return {
      id: def.id,
      title: def.title,
      category: def.category,
      isFiller: def.isFiller ?? false,
      qualifiedPct: (qualified / Math.max(1, participantsEvaluated)) * 100,
      shownPct: (shown / Math.max(1, participantsEvaluated)) * 100
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
    console.log(`=== ${category.toUpperCase()} rules: qualified % / shown % (all roles blended) ===`)
    const list = rows
      .filter((r) => r.category === category && !r.isFiller)
      .sort((a, b) => b.qualifiedPct - a.qualifiedPct)
    for (const r of list) {
      console.log(
        `${r.id.padEnd(22)} ${r.title.padEnd(26)} ` +
          `${r.qualifiedPct.toFixed(1).padStart(5)}%  ${r.shownPct.toFixed(1).padStart(5)}%` +
          flag(r.qualifiedPct)
      )
    }
    console.log('')
  }

  // --- Firing rates, per role (this is the whole point of this harness) -----
  console.log('=== Qualified % by role, role-scaled rules only (uses forRole()) ===')
  // Every rule id whose condition actually calls forRole() -- generated via
  // `Select-String -Pattern 'forRole\(' src/renderer/src/lib/achievements/definitions.ts`
  // and matched back to its containing rule. Keep this in sync if
  // definitions.ts adds/removes a forRole() call.
  const roleScaledRuleIds = [
    'crowd_control',
    'damage_dealer',
    'iron_wall',
    'cs_machine',
    'early_farmer',
    'out_farmed_them',
    'gold_hoarder',
    'dragon_tamer',
    'ward_hunter',
    'visionary',
    'ward_provider',
    'control_freak',
    'survivor',
    'assist_king',
    'team_player',
    'fight_anchor',
    'steady_farm',
    'some_vision',
    'rough_game',
    'early_deaths',
    'low_vision',
    'low_cs',
    'cs_deficit',
    'low_participation',
    'absent_fights',
    'low_damage'
  ]
  for (const ruleId of roleScaledRuleIds) {
    const def = ACHIEVEMENTS.find((d) => d.id === ruleId)
    if (!def) continue
    const perRole = ROLES.map((role) => {
      const n = evaluatedByRole.get(role) ?? 0
      const c = firedByRole.get(role)?.get(ruleId) ?? 0
      const pct = n > 0 ? (c / n) * 100 : NaN
      return `${role.slice(0, 3)}=${Number.isFinite(pct) ? pct.toFixed(1) : '--'}% (n=${n})`
    })
    console.log(`${ruleId.padEnd(20)} ${perRole.join('  ')}`)
  }
  console.log('')

  // --- Per-role stat distributions, for updating thresholds.ts's RoleScaled tables
  if (args.distributions) {
    console.log('=== Per-role stat distributions (for updating RoleScaled thresholds) ===')
    const rolesToShow = args.role ? [args.role] : [...ROLES]
    for (const role of rolesToShow) {
      const roleFacts = factsList.filter((f) => f.role === role)
      console.log(`\n--- ${role} (n=${roleFacts.length}) ---`)
      const pick = (fn: (f: MatchFacts) => number | null): number[] =>
        roleFacts.map(fn).filter((v): v is number => v !== null && Number.isFinite(v))

      const lines = [
        describeDistribution('kills', pick((f) => f.kills)),
        describeDistribution('soloKills', pick((f) => f.soloKills)),
        describeDistribution('earlyKills (<15m)', pick((f) => f.earlyKills)),
        describeDistribution('earlyDeaths (<15m)', pick((f) => f.earlyDeaths)),
        describeDistribution('largestKillingSpree', pick((f) => f.largestKillingSpree)),
        describeDistribution('killParticipation', pick((f) => f.killParticipation)),
        describeDistribution('teamfightParticipation', pick((f) => f.teamfightParticipation)),
        describeDistribution('teamfightCount', pick((f) => f.teamfightCount)),
        describeDistribution('duelWinRate', pick((f) => f.duelWinRate)),
        describeDistribution('duelCount', pick((f) => f.duelCount)),
        describeDistribution('ccSeconds', pick((f) => f.timeCCingOthers)),
        describeDistribution('deaths', pick((f) => f.deaths)),
        describeDistribution('longestLifeSeconds', pick((f) => f.longestTimeSpentLiving)),
        describeDistribution('deadTimeShare', pick((f) => f.deadTimeShare)),
        describeDistribution('damageToChampions', pick((f) => f.damageToChampions)),
        describeDistribution('damagePerMinute', pick((f) => f.damagePerMinute)),
        describeDistribution('teamDamageShare', pick((f) => f.teamDamageShare)),
        describeDistribution('damageSelfMitigated', pick((f) => f.damageSelfMitigated)),
        describeDistribution('csPerMinute', pick((f) => f.csPerMinute)),
        describeDistribution('csAt10Min', pick((f) => f.csAt10Min)),
        describeDistribution('csDiffVsLaneOpp', pick((f) => f.csDiffVsLaneOpponent)),
        describeDistribution('goldPerMinute', pick((f) => f.goldPerMinute)),
        describeDistribution('goldDiffVsLaneOpp', pick((f) => f.goldDiffVsLaneOpponent)),
        describeDistribution('teamGoldDiff', pick((f) => f.teamGoldDiff)),
        describeDistribution('largestTeamGoldLead', pick((f) => f.largestTeamGoldLead)),
        describeDistribution('largestTeamGoldDeficit', pick((f) => f.largestTeamGoldDeficit)),
        describeDistribution('turretKills', pick((f) => f.turretKills)),
        describeDistribution('damageToTurrets', pick((f) => f.damageToTurrets)),
        describeDistribution('objectiveParticipations', pick((f) => f.objectiveParticipations)),
        describeDistribution('dragonTakedowns', pick((f) => f.dragonTakedowns)),
        describeDistribution('baronTakedowns', pick((f) => f.baronTakedowns)),
        describeDistribution('visionScore', pick((f) => f.visionScore)),
        describeDistribution('wardsKilled', pick((f) => f.wardsKilled)),
        describeDistribution('controlWardsPlaced', pick((f) => f.controlWardsPlaced)),
        describeDistribution('wardsPlaced', pick((f) => f.wardsPlaced)),
        describeDistribution('healsOnTeammates', pick((f) => f.healsOnTeammates)),
        describeDistribution('shieldedOnTeammates', pick((f) => f.shieldedOnTeammates)),
        describeDistribution('assists', pick((f) => f.assists)),
        describeDistribution(
          'csDropoff(early-mid)',
          roleFacts
            .filter((f) => f.earlyCsPerMinute !== null && f.midCsPerMinute !== null)
            .map((f) => (f.earlyCsPerMinute ?? 0) - (f.midCsPerMinute ?? 0))
        )
      ]
      for (const line of lines) console.log(line)
    }
    console.log('')

    // Flat (non-role-scaled) thresholds are calibrated against the blended
    // sample across all roles -- this mirrors how they're actually applied
    // in definitions.ts (no forRole() call).
    console.log(`\n--- ALL ROLES BLENDED (n=${factsList.length}), for flat thresholds ---`)
    const pickAll = (fn: (f: MatchFacts) => number | null): number[] =>
      factsList.map(fn).filter((v): v is number => v !== null && Number.isFinite(v))
    const blendedLines = [
      describeDistribution('kills', pickAll((f) => f.kills)),
      describeDistribution('largestKillingSpree', pickAll((f) => f.largestKillingSpree)),
      describeDistribution('soloKills', pickAll((f) => f.soloKills)),
      describeDistribution('earlyKills (<15m)', pickAll((f) => f.earlyKills)),
      describeDistribution('teamDamageShare', pickAll((f) => f.teamDamageShare)),
      describeDistribution('damageSelfMitigated', pickAll((f) => f.damageSelfMitigated)),
      describeDistribution('turretKills', pickAll((f) => f.turretKills)),
      describeDistribution('damageToTurrets', pickAll((f) => f.damageToTurrets)),
      describeDistribution('objectiveParticipations', pickAll((f) => f.objectiveParticipations)),
      describeDistribution('baronTakedowns', pickAll((f) => f.baronTakedowns)),
      describeDistribution('csLead(csDiffVsLaneOpp, >0)', pickAll((f) => f.csDiffVsLaneOpponent)),
      describeDistribution('goldDiffVsLaneOpp', pickAll((f) => f.goldDiffVsLaneOpponent)),
      describeDistribution('teamGoldDiff', pickAll((f) => f.teamGoldDiff)),
      describeDistribution('largestTeamGoldLead', pickAll((f) => f.largestTeamGoldLead)),
      describeDistribution('largestTeamGoldDeficit', pickAll((f) => f.largestTeamGoldDeficit)),
      describeDistribution('longestLifeSeconds', pickAll((f) => f.longestTimeSpentLiving)),
      describeDistribution('deadTimeShare', pickAll((f) => f.deadTimeShare)),
      describeDistribution('soloDeaths', pickAll((f) => f.soloDeaths)),
      describeDistribution('duelWinRate', pickAll((f) => f.duelWinRate)),
      describeDistribution('duelCount', pickAll((f) => f.duelCount)),
      describeDistribution(
        'csDropoff(early-mid)',
        factsList
          .filter((f) => f.earlyCsPerMinute !== null && f.midCsPerMinute !== null)
          .map((f) => (f.earlyCsPerMinute ?? 0) - (f.midCsPerMinute ?? 0))
      )
    ]
    for (const line of blendedLines) console.log(line)
    console.log('')
  }

  console.log(
    'Note: tower_diver cannot be calibrated here -- it reads stored video tags, not Riot match data.'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
