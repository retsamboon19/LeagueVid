// Calibrates the gank-ATTEMPT rule: a third-party enemy crosses into the
// player's lane corridor while the player is present there.
//
// This differs from probe-gank-attempts.ts in three ways, all from the spec:
//   - any enemy counts, not just the jungler (a roaming mid ganks too)
//   - the PLAYER must also be in the corridor, so a jungler wandering through
//     an empty lane while the player is dead or backed does not count
//   - "in the presence of" is read as proximity, so the two must be near each
//     other rather than merely inside the same long corridor
//
// The point is to pick the corridor half-width and the proximity radius on
// evidence. The measure used is lift: how much more likely a gank death
// becomes when the rule fires, versus when it does not. A rule with no lift
// is detecting nothing, however plausible it sounds.
//
// Frames are 60s apart and a gank lasts ~10s, so this can only ever SAMPLE
// attempts. Lift is what says whether the sample carries information.
//
// Read-only, no Riot API calls.
//
// Usage: npx tsx scripts/probe-gank-copresence.ts [matchLimit]

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { EARLY_MS, type Pt, distToLane, expectedOpponentRoles, laneForRole } from './lib/laneGeometry'

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

const DEATH_WINDOW_MS = 45_000

const HALF_WIDTHS = [1000, 1250, 1500, 2000]
const PROXIMITIES = [1500, 2000, 2500, 3000, Infinity]

interface Cell {
  fired: number
  firedWithGankDeath: number
  quiet: number
  quietWithGankDeath: number
  /** Distinct episodes after merging consecutive frames. */
  episodes: number
  episodesWithGankDeath: number
}

function emptyCell(): Cell {
  return {
    fired: 0,
    firedWithGankDeath: 0,
    quiet: 0,
    quietWithGankDeath: 0,
    episodes: 0,
    episodesWithGankDeath: 0
  }
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 1000)
  const matches = readKind<any>('match', limit)
  const timelines = readKind<any>('timeline', limit)

  const grid = new Map<string, Cell>()
  const key = (w: number, p: number): string => `${w}|${p}`
  for (const w of HALF_WIDTHS) for (const p of PROXIMITIES) grid.set(key(w, p), emptyCell())

  // Attempts per laner-game at the chosen setting, for threshold picking.
  const CHOSEN_W = 1500
  const CHOSEN_P = 2500
  const attemptsPerGame: number[] = []
  const survivedPerGame: number[] = []
  let matchesUsed = 0
  let lanerGames = 0
  // Which roles do the gankers turn out to be?
  const gankerRoles = new Map<string, number>()

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

    const frames: Array<{ timestampMs: number; positions: Map<number, Pt> }> = []
    const kills: Array<{ timestampMs: number; victimId: number; enemies: number[]; position: Pt }> =
      []

    for (const frame of timeline.info?.frames ?? []) {
      const positions = new Map<number, Pt>()
      for (const pf of Object.values(frame.participantFrames ?? {}) as any[]) {
        if (pf.position) positions.set(pf.participantId, pf.position)
      }
      frames.push({ timestampMs: frame.timestamp, positions })

      for (const ev of (frame.events ?? []) as any[]) {
        if (ev.type !== 'CHAMPION_KILL' || ev.timestamp > EARLY_MS) continue
        if (!ev.victimId || !ev.position) continue
        const victimTeam = teamById.get(ev.victimId)
        const enemies = [ev.killerId ?? 0, ...(ev.assistingParticipantIds ?? [])].filter(
          (id: number) => id > 0 && teamById.get(id) !== victimTeam
        )
        kills.push({
          timestampMs: ev.timestamp,
          victimId: ev.victimId,
          enemies,
          position: ev.position
        })
      }
    }

    for (const p of participants) {
      const role = roleById.get(p.participantId) ?? ''
      const lane = laneForRole(role)
      if (!lane) continue
      lanerGames++
      const expected = expectedOpponentRoles(role)
      const myTeam = p.teamId

      // Third-party enemies: everyone on the other team who is not part of the
      // normal lane matchup. Not limited to the jungler.
      const thirdParties = participants
        .filter((q: any) => q.teamId !== myTeam)
        .map((q: any) => q.participantId)
        .filter((id: number) => !expected.includes(roleById.get(id) ?? ''))

      const gankDeaths = kills.filter((k) => {
        if (k.victimId !== p.participantId) return false
        if (distToLane(k.position, lane) > CHOSEN_W) return false
        return k.enemies.some((id) => !expected.includes(roleById.get(id) ?? ''))
      })

      for (const w of HALF_WIDTHS) {
        for (const prox of PROXIMITIES) {
          const cell = grid.get(key(w, prox))!
          let prevFired = false
          for (const frame of frames) {
            if (frame.timestampMs > EARLY_MS || frame.timestampMs === 0) continue
            const myPos = frame.positions.get(p.participantId)
            if (!myPos) continue

            // The player must be in their own lane corridor.
            const meInLane = distToLane(myPos, lane) <= w
            let fired = false
            let firedRole = ''
            if (meInLane) {
              for (const id of thirdParties) {
                const ePos = frame.positions.get(id)
                if (!ePos) continue
                if (distToLane(ePos, lane) > w) continue
                if (Math.hypot(ePos.x - myPos.x, ePos.y - myPos.y) > prox) continue
                fired = true
                firedRole = roleById.get(id) ?? ''
                break
              }
            }

            const gankDeathNear = gankDeaths.some(
              (k) => Math.abs(k.timestampMs - frame.timestampMs) <= DEATH_WINDOW_MS
            )

            if (fired) {
              cell.fired++
              if (gankDeathNear) cell.firedWithGankDeath++
              if (!prevFired) {
                cell.episodes++
                if (gankDeathNear) cell.episodesWithGankDeath++
              }
              if (w === CHOSEN_W && prox === CHOSEN_P && firedRole) {
                gankerRoles.set(firedRole, (gankerRoles.get(firedRole) ?? 0) + 1)
              }
            } else {
              cell.quiet++
              if (gankDeathNear) cell.quietWithGankDeath++
            }
            prevFired = fired
          }
        }
      }

      // Per-game counts at the chosen setting, using merged episodes.
      {
        const w = CHOSEN_W
        const prox = CHOSEN_P
        let episodes = 0
        let survived = 0
        let prevFired = false
        for (const frame of frames) {
          if (frame.timestampMs > EARLY_MS || frame.timestampMs === 0) continue
          const myPos = frame.positions.get(p.participantId)
          if (!myPos) continue
          let fired = false
          if (distToLane(myPos, lane) <= w) {
            for (const id of thirdParties) {
              const ePos = frame.positions.get(id)
              if (!ePos) continue
              if (distToLane(ePos, lane) > w) continue
              if (Math.hypot(ePos.x - myPos.x, ePos.y - myPos.y) > prox) continue
              fired = true
              break
            }
          }
          if (fired && !prevFired) {
            episodes++
            const died = gankDeaths.some(
              (k) => Math.abs(k.timestampMs - frame.timestampMs) <= DEATH_WINDOW_MS
            )
            if (!died) survived++
          }
          prevFired = fired
        }
        attemptsPerGame.push(episodes)
        survivedPerGame.push(survived)
      }
    }
  }

  console.log(`matches used: ${matchesUsed}   laner-games: ${lanerGames}`)
  console.log(`\ndeath attribution window: ${DEATH_WINDOW_MS / 1000}s around the sampled frame`)

  console.log('\n--- rule calibration (lift = how much the rule raises gank-death odds) ---')
  console.log('  corridor  proximity   frames fired   P(gank death | fired)   baseline   lift')
  for (const w of HALF_WIDTHS) {
    for (const prox of PROXIMITIES) {
      const c = grid.get(key(w, prox))!
      const pFired = c.fired > 0 ? c.firedWithGankDeath / c.fired : 0
      const pQuiet = c.quiet > 0 ? c.quietWithGankDeath / c.quiet : 0
      const lift = pQuiet > 0 ? pFired / pQuiet : 0
      const proxLabel = prox === Infinity ? 'any' : String(prox)
      console.log(
        `  ${String(w).padStart(8)}  ${proxLabel.padStart(9)}   ${String(c.fired).padStart(12)}   ${pct(c.firedWithGankDeath, c.fired).padStart(21)}   ${pct(c.quietWithGankDeath, c.quiet).padStart(8)}   ${lift.toFixed(1)}x`
      )
    }
  }

  const chosen = grid.get(key(CHOSEN_W, CHOSEN_P))!
  console.log(`\n--- chosen setting: corridor ${CHOSEN_W}, proximity ${CHOSEN_P} ---`)
  console.log(`frames fired                    : ${chosen.fired}`)
  console.log(`distinct episodes (merged)      : ${chosen.episodes}`)
  console.log(
    `episodes followed by a gank death: ${chosen.episodesWithGankDeath}  ${pct(chosen.episodesWithGankDeath, chosen.episodes)}`
  )

  console.log('\n  who is doing the ganking (role of the third party that fired the rule):')
  const totalRoles = [...gankerRoles.values()].reduce((a, b) => a + b, 0)
  for (const [role, n] of [...gankerRoles].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${role.padEnd(10)} ${String(n).padStart(7)}   ${pct(n, totalRoles)}`)
  }

  const dist = (arr: number[], cap: number): void => {
    const d: Record<number, number> = {}
    for (const v of arr) d[Math.min(v, cap)] = (d[Math.min(v, cap)] ?? 0) + 1
    for (const k of Object.keys(d).sort((a, b) => Number(a) - Number(b))) {
      console.log(`    ${k}: ${String(d[Number(k)]).padStart(6)}   ${pct(d[Number(k)], arr.length)}`)
    }
  }

  console.log('\n  gank attempts per laner-game (capped at 6):')
  dist(attemptsPerGame, 6)
  const meanA = attemptsPerGame.reduce((a, b) => a + b, 0) / (attemptsPerGame.length || 1)
  console.log(`  mean: ${meanA.toFixed(2)}`)

  console.log('\n  attempts SURVIVED per laner-game (capped at 6):')
  dist(survivedPerGame, 6)
  const meanS = survivedPerGame.reduce((a, b) => a + b, 0) / (survivedPerGame.length || 1)
  console.log(`  mean: ${meanS.toFixed(2)}`)

  // Cumulative tail, for achievement thresholds.
  console.log('\n  survived >= N (achievement threshold candidates):')
  for (const n of [2, 3, 4, 5, 6]) {
    const c = survivedPerGame.filter((v) => v >= n).length
    console.log(`    >= ${n}: ${String(c).padStart(6)}   ${pct(c, survivedPerGame.length)}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
