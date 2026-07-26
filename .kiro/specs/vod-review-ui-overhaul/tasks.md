# Implementation Plan

- [x] 1. Remove the backfill banner's dismiss control
  - Delete the dismiss button, the `dismissed` state, and the `DISMISSED_KEY` sessionStorage read/write from `BackfillStatusBanner.tsx`
  - Keep the existing auto-hide on completion and the `progressbar` semantics
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 18.6_

- [x] 2. Rebuild the match tile layout
- [x] 2.1 Restructure `MatchTile.tsx` into the fixed region order
  - Emit regions in order: result/duration, champion + loadout, KDA, items, rosters, actions
  - Add `title` attributes to truncatable participant names
  - Preserve open/re-link/remove actions, suspicious-link and last-viewed indicators, unlinked state
  - _Requirements: 2.1, 2.5, 2.6, 2.7, 3.7, 19.1, 19.2_
- [x] 2.2 Rewrite the tile CSS as an explicit grid with container queries
  - Explicit tracks with a single `1fr` spacer; `min-width: 0` on every region
  - `container-type: inline-size` on the tile; `@container` rules at 900px and 640px
  - Wide: rosters with names. Medium: roster icons only. Narrow: rosters hidden, items wrap
  - _Requirements: 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Make the library page responsive
  - Stack the filter sidebar above the tile list below 1000px content width
  - Prevent horizontal page scroll across 320–2560px
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 4. Verify rune variables against real cached data
  - Add `scripts/verify-rune-vars.ts` reading cached match DTOs from the DB, no API calls
  - Report perk ids with their var1/var2/var3, matches inspected, and count of selections with a non-zero var
  - Run it and record the outcome before implementing rune performance UI
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 5. Build the match stats derivation layer
- [x] 5.1 Add `MatchStats` and supporting types to `src/shared/types.ts`
  - Type `challenges` permissively and mark heuristic values with an estimate flag
  - _Requirements: 17.6, 12.7_
- [x] 5.2 Extend `ParticipantDto` in `src/main/riot/types.ts` with the fields the panel needs
  - Add `challenges`, vision/damage/heal/CC fields, `riotIdGameName`
  - _Requirements: 7.2, 8.2, 13.2, 13.3, 13.4, 13.5_
- [x] 5.3 Implement `src/main/riot/teamfightAnalyzer.ts`
  - Cluster `CHAMPION_KILL` events by time and position; classify duels vs teamfights
  - Derive teamfight winrate, participation, duel winrate, solo deaths
  - Return unavailable rather than 0 when there are no qualifying groups
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.9_
- [x] 5.4 Implement `src/main/riot/matchStats.ts`
  - Read cached match + timeline only; never call Riot
  - Derive participants, team totals, per-minute frames, skill order, undo-corrected item purchase groups, heuristics
  - Report `hasTimeline: false` and degrade rather than fail when the timeline is missing
  - _Requirements: 17.1, 17.2, 17.4, 17.7, 10.6, 10.7, 10.8, 10.9, 11.1, 7.6_
- [x] 5.5 Add the `riot:getMatchStats` IPC handler and preload binding
  - _Requirements: 17.1, 17.3_

- [x] 6. Restructure the player page layout
  - Player upper-left, stats panel upper-right, bookmarks full-width below
  - Stack the panel below the video under 1100px; panel scrolls its own overflow
  - Show a message in place of the panel when the video has no linked match
  - Preserve all existing bookmark and player-preference behavior
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 19.3_

- [x] 7. Build the stats panel shell
  - Five tabs with `tablist`/`tab`/`tabpanel` roles and arrow-key navigation
  - Focus_Player state defaulting to the linked account's participant, with an indicator and reset control when another player is selected
  - Handle the not-cached and no-timeline states
  - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 17.3, 17.4, 18.1, 18.2, 18.8_

- [x] 8. Implement the Scoreboard tab
  - All 10 participants grouped by team, focus player's team first
  - Per-participant champion, name, K/D/A, CS, gold, damage, vision; team win/loss, kills, gold
  - Distinguish the owner row and the focus row; clicking a row sets Focus_Player
  - Fall back to champion name when a display name is missing
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 6.4, 6.5, 18.3, 18.9_

- [x] 9. Implement the Performance tab
  - Sortable table over all 10 by kills, KDA, damage, gold, wards, CS
  - Descending on first click, reverse on repeat click, `aria-sort` on the active column
  - In-cell proportional bars against the column maximum, with the numeric value shown as text
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 18.3, 18.4_

- [x] 10. Implement the Build tab and rune label map
  - `lib/runeLabels.ts` covering current-season keystones
  - Rune trees with labeled vars where mapped, raw values marked unlabeled otherwise, icon-only when all vars are 0
  - Skill order grid and grouped item purchase timeline with minute:second stamps
  - Message when timeline data is absent
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10_

- [x] 11. Implement the Graphs tab
  - Plot gold, damage, XP, CS against game time from timeline frames
  - Default to focus player + lane opponent; allow toggling any of the 10
  - Difference series, labeled axes, hover readout at the nearest frame
  - Keyboard-reachable text equivalent of the plotted values
  - Handle an undeterminable lane opponent
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8_

- [x] 12. Implement the Insights tab
  - Fighting / Farming / Objectives / Vision gauge groups from challenges plus heuristics
  - Estimate marker and explanation on every heuristic stat
  - Unavailable rather than zero for absent challenge fields and zero-teamfight matches
  - `progressbar` semantics on each gauge
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 12.7, 12.8, 12.9, 18.5_

- [x] 13. Implement the lane comparison strip
  - Focus player vs lane opponent CS, gold, damage with signed differences
  - Visible across all tabs; champion icons; sign conveyed in text as well as color
  - Message when no lane opponent is identified
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

- [x] 14. Implement the objective participation timeline
  - Dragon, herald, baron, turret takedowns positioned by game time with taking team and type
  - Mark focus player participation; selecting an objective seeks the video
  - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 15. Wire bookmark and stats linkage
  - Pass current game time (video time minus sync offset, treating a missing offset as 0) into the panel
  - Playback marker on graphs; selecting a bookmark marks graphs and the objective timeline
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

- [ ] 16. Verify the whole feature (typecheck/build done; visual + resize checks need a run of the app)
  - Run `npm run typecheck` and `npm run build`
  - Resize through 320–2560px checking for overlap, clipping, and horizontal scroll on the library and player pages
  - Confirm no Riot requests are issued while the stats panel is open
  - Confirm existing tile actions, bookmarks, preferences, and filters still work
  - _Requirements: 3.5, 3.6, 4.3, 17.2, 19.1, 19.2, 19.3, 19.4, 19.5_
