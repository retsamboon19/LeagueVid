# Design Document

## Overview

Three areas of work, sequenced so each leaves a working UI:

1. **Backfill banner** — remove the dismiss control (R1).
2. **Responsive layout** — rebuild the match tile as an explicit grid with container-query breakpoints, and make the library's two-column layout collapse (R2–R4).
3. **Player page + Match Stats panel** — restructure the player page and add a five-tab stats panel over data already cached locally (R5–R18).

The defining architectural constraint (R17): the full match DTO and full timeline DTO for every linked video are **already** cached in `api_cache`. All new stats are derived from that cache. No new Riot API calls.

## Architecture

```
main process
  riot/matchCache.ts        getMatchCached / getMatchTimelineCached (existing)
  riot/matchStats.ts        NEW  derive all stat structures from cached DTOs
  riot/teamfightAnalyzer.ts NEW  cluster kill events -> heuristic stats
  riot/ipc.ts               NEW handler: riot:getMatchStats

preload
  window.api.riot.getMatchStats({ matchId, platform, puuid })

renderer
  views/VideoPlayer.tsx           restructured layout (player | stats panel / bookmarks)
  views/MatchStatsPanel.tsx       NEW  tab shell, focus player state, lane strip
  views/stats/ScoreboardTab.tsx   NEW
  views/stats/PerformanceTab.tsx  NEW
  views/stats/BuildTab.tsx        NEW
  views/stats/GraphsTab.tsx       NEW
  views/stats/InsightsTab.tsx     NEW
  views/stats/ObjectiveTimeline.tsx NEW
  lib/runeLabels.ts               NEW  Rune_Label_Map
```

### Why derive in the main process

The cached DTOs are large (a timeline is often 1–5 MB). Sending raw DTOs over IPC for every video open would be wasteful and slow. Instead `matchStats.ts` reads the cache and returns one compact `MatchStats` payload containing only what the panel renders. This also keeps the heuristic clustering (R12) out of the render path, satisfying the 500 ms budget (R17.7).

### Single payload, computed once

`riot:getMatchStats` returns everything for all five tabs in one call. Tabs are pure presentation over that payload, so switching tabs and changing Focus_Player never re-fetches. Focus_Player is renderer-side state that selects a slice of the already-delivered payload.

## Components and Interfaces

### `MatchStats` (shared/types.ts)

```ts
interface MatchStats {
  matchId: string
  gameDurationSeconds: number
  gameMode: string
  hasTimeline: boolean          // false -> timeline-dependent tabs unavailable (R17.4)
  teams: MatchStatsTeam[]       // 2 teams, win/loss/kills/gold totals
  participants: StatsParticipant[] // all 10, full stat set
  frames: TimelineFrame[]       // per-minute, all 10 -> Graphs tab
  ownerPuuid: string            // linked account's participant
}

interface StatsParticipant {
  puuid: string; participantId: number; teamId: number
  riotIdGameName: string | null; championName: string; champLevel: number
  kills: number; deaths: number; assists: number
  cs: number; goldEarned: number; damageToChampions: number
  damageTaken: number; damageSelfMitigated: number; damageToObjectives: number
  visionScore: number; wardsPlaced: number; wardsKilled: number
  controlWardsPlaced: number
  turretKills: number; largestMultiKill: number; largestKillingSpree: number
  timeCCingOthers: number; totalHeal: number; healsOnTeammates: number
  shieldedOnTeammates: number; longestTimeSpentLiving: number; totalTimeSpentDead: number
  items: number[]; summoner1Id: number; summoner2Id: number
  teamPosition: string
  perks: StatsPerkSelection[]   // with var1/var2/var3 (R10)
  challenges: Record<string, number> | null  // absent on old matches (R17.6)
  skillOrder: SkillLevelUp[]    // from timeline
  itemPurchases: ItemPurchaseGroup[] // from timeline, undo-corrected
  heuristics: HeuristicStats | null  // null when no timeline
}
```

`challenges` is typed as `Record<string, number> | null` rather than an exhaustive interface: Riot adds and removes challenge fields between patches, and R17.6/R13.8 require treating an absent field as "unavailable" rather than 0. A permissive record plus explicit presence checks is the honest representation.

### Rune variables (R9, R10)

`ParticipantDto.perks.styles[].selections[]` already types `var1/var2/var3`. Whether they are *populated* is unverified, so:

- `scripts/verify-rune-vars.ts` reads cached matches and reports perk ids with non-zero vars (R9). Run before building the rune UI.
- `lib/runeLabels.ts` maps perk id → `{ label, format }[]` for its vars. Unmapped perks render raw values with an "unlabeled" marker (R10.3), never a guessed label.

### Teamfight analyzer (R12)

Pure function over `CHAMPION_KILL` events:

1. Sort kills by timestamp. Start a group; extend it while the next kill is within `FIGHT_GAP_MS` (10 s) **and** within `FIGHT_RADIUS` (2000 map units) of the group centroid.
2. Distinct participants in a group (victims + killers + assisters) determine classification: exactly 2 → duel; 3+ → teamfight.
3. Derive winrate / participation / duel winrate / solo deaths per R12.3–R12.6.

Every value produced here is tagged `isEstimate: true` in the payload so the UI can render the marker required by R12.7 without the renderer having to know which stats are heuristic.

Constants are deliberately explicit and commented — they are judgment calls, not derived truth.

## Responsive strategy

### Match tile (R2, R3)

Current failures and their causes:

| Symptom | Cause | Fix |
|---|---|---|
| Empty space mid-tile | rosters pushed right with `justify-self: end`, middle tracks `auto` | explicit tracks, one `1fr` spacer |
| Text overlapping at small widths | grid children default `min-width: auto` | `min-width: 0` on every region |

Grid: `auto auto auto auto 1fr auto` for
`[result] [champ+loadout] [KDA] [items] [spacer→roster] [actions]`.

Breakpoints use **container queries** on the tile (`container-type: inline-size`), not media queries, because the library sidebar changes the tile's available width independently of the window (R3.4). Thresholds: Wide ≥ 900px, Medium 640–899px, Narrow < 640px.

Container queries are supported in the bundled Electron 33 (Chromium 130+), so no fallback is needed.

### Library (R4) and player page (R5)

Plain media queries suffice — these react to the window, not to a parent. Library stacks the sidebar above tiles below 1000px; the player page stacks the stats panel below the video below 1100px.

## Data flow: bookmark ↔ stats (R16)

Video time and game time differ by the stored sync offset. `VideoPlayer` already owns both `currentTimeMs` and `video.sync_offset_ms`, so it converts and passes `currentGameTimeMs` down to the panel. Graphs render a playback marker from it; selecting a bookmark or objective seeks the video by converting back.

```
gameTimeMs = videoTimeMs - (video.sync_offset_ms ?? 0)
videoTimeMs = gameTimeMs + (video.sync_offset_ms ?? 0)
```

## Error Handling

| Condition | Behavior | Req |
|---|---|---|
| No linked match | panel replaced with message | R5.6 |
| Match DTO not cached | message: not downloaded yet, background will supply | R17.3 |
| Timeline DTO not cached | match-only tabs render; Build/Graphs partially, Insights heuristics unavailable | R17.4, R10.10 |
| Lane opponent undeterminable | focus player alone + message | R11.7, R14.5 |
| Challenge field absent | gauge shows unavailable | R13.8 |
| Zero teamfights | teamfight stats unavailable, not 0% | R12.9 |

Absent data is always distinguished from zero data. That distinction is the direct lesson of the linking regression earlier in this project, where an empty result was treated as a confirmed answer.

## Testing Strategy

- `scripts/verify-rune-vars.ts` — verifies the R9 assumption against real cached data before dependent UI exists.
- Teamfight clustering is a pure function; verified against a known match by comparing derived teamfight count and participation to the timeline's kill list by hand.
- Responsive criteria (R3.5, R3.6, R4.3) are verified by resizing the app window through the 320–2560px range and confirming no overlap, no clipping, and no horizontal page scroll.
- `npm run typecheck` and `npm run build` must pass (R19.5).
