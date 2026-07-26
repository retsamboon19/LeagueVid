# Requirements Document

## Introduction

This feature overhauls the three parts of LeagueVid's interface that currently get in the way of reviewing a VOD: the backfill progress banner (which can be dismissed into a dead end), the library match tile (which wastes horizontal space and overlaps its own text at small window sizes), and the video player page (which shows bookmarks but almost none of the match data LeagueVid already has on disk).

The centerpiece is a tabbed Match Stats panel on the player page, giving a U.GG / League-of-Graphs level of detail: full scoreboard, sortable performance table, rune performance values, skill order, item build timeline, over-time graphs, and grouped insight gauges.

A defining constraint: LeagueVid already downloads and permanently caches the **full** match DTO and **full** timeline DTO for every linked video in the `api_cache` table. Today the UI surfaces only a thin slice of that data. So this feature is overwhelmingly presentation over data already on disk and must not introduce new Riot API traffic.

Two honesty constraints are treated as first-class requirements rather than polish:

- A handful of headline stats (teamfight winrate, teamfight participation, duel winrate, solo deaths) are **not** provided by the Riot API and must be computed heuristically from timeline kill clustering. These must be visibly labeled as estimates.
- Rune performance values arrive from the API as unlabeled `var1`/`var2`/`var3` numbers. A hand-built per-rune label map is required, and anything unmapped must be shown raw rather than guessed at. Whether these fields are actually populated in the user's cached data must be verified against real cached matches *before* any UI is built on top of them.

**Delivery sequencing (user preference):** Requirement 1 (banner) and Requirements 2-4 (tile and library responsiveness) ship first, then Requirement 5 (player page layout), then the stats tabs incrementally. Every step leaves a working, visually verifiable UI.

## Glossary

- **LeagueVid**: The Electron desktop application as a whole.
- **Match_Cache**: The existing local cache of full Riot `match-v5` match DTOs and timeline DTOs, stored in the `api_cache` table and read through `getMatchCached` / `getMatchTimelineCached`, keyed by immutable match id.
- **Match_Stats_Service**: The main-process component that reads the Match_Cache and derives the stat structures consumed by the renderer.
- **Backfill_Banner**: The library-page status banner reporting background match-history download progress.
- **Match_Tile**: The library-page card representing one video and its linked match.
- **Library_View**: The library page, containing the filter sidebar and the list of Match_Tiles.
- **Player_View**: The video player page, containing the video player, the Match_Stats_Panel, and the bookmark list.
- **Match_Stats_Panel**: The tabbed panel on the Player_View that presents match data.
- **Scoreboard_Tab**, **Performance_Tab**, **Build_Tab**, **Graphs_Tab**, **Insights_Tab**: The five tabs of the Match_Stats_Panel.
- **Lane_Comparison_Strip**: The persistent strip above the Match_Stats_Panel tabs comparing the Focus_Player against the Lane_Opponent.
- **Objective_Timeline**: The component showing when epic monsters and turrets fell and whether the Focus_Player participated.
- **Focus_Player**: The one participant, of the 10 in a match, whose data the Build_Tab, Graphs_Tab, Insights_Tab, and Lane_Comparison_Strip currently present. Defaults to the account owner of the linked video.
- **Lane_Opponent**: The enemy participant sharing the Focus_Player's `teamPosition`, falling back to `individualPosition`.
- **Challenge_Field**: One of the ~150 Riot-computed values under `participant.challenges` in the match DTO (for example `killParticipation`, `damagePerMinute`, `soloKills`).
- **Rune_Variable**: One of the `var1`, `var2`, `var3` numbers attached to each entry in `perks.styles[].selections[]` in the match DTO.
- **Rune_Label_Map**: The hand-authored mapping from a rune's perk id to human-readable labels and formatting for that rune's Rune_Variables.
- **Rune_Var_Verification**: A one-off developer-run script that reports what Rune_Variable values exist in the user's real cached matches.
- **Teamfight_Analyzer**: The component that groups timeline kill events into teamfights and duels by time proximity and map position, and derives Heuristic_Stats from those groupings.
- **Heuristic_Stat**: A statistic LeagueVid computes itself because the Riot API does not provide it: teamfight winrate, teamfight participation, duel winrate, solo deaths.
- **Tile_Width**: The rendered content width of a single Match_Tile.
- **Wide_Layout**: Match_Tile presentation used when Tile_Width is 900 CSS pixels or greater.
- **Medium_Layout**: Match_Tile presentation used when Tile_Width is at least 640 and less than 900 CSS pixels.
- **Narrow_Layout**: Match_Tile presentation used when Tile_Width is less than 640 CSS pixels.

## Requirements

### Requirement 1: Always-visible backfill progress

**User Story:** As a user waiting on match history to download, I want the progress banner to reflect the actual download state at all times, so that I never lose visibility into progress with no way to get it back.

#### Acceptance Criteria

1. WHILE at least one linked account reports fewer downloaded matches than its known total, THE Backfill_Banner SHALL display the download progress on the Library_View.
2. WHEN every linked account reports a fully backfilled history, THE Backfill_Banner SHALL remove itself from the Library_View.
3. THE Backfill_Banner SHALL present the download progress with no user control that hides the Backfill_Banner.
4. THE Backfill_Banner SHALL determine visibility solely from the backfill status reported by the main process, independent of any previously stored dismissal value.
5. WHILE the total number of available matches is unknown, THE Backfill_Banner SHALL display a message stating that history availability is being checked.

### Requirement 2: U.GG-style match tile layout

**User Story:** As a user scanning my library, I want each match tile to use its full width with every piece of information in a predictable place, so that I can compare matches at a glance instead of reading around empty gaps.

#### Acceptance Criteria

1. THE Match_Tile SHALL arrange content into regions in this left-to-right order: result and duration, champion with runes and summoner spells, KDA block, item grid, team rosters, actions.
2. THE Match_Tile SHALL assign each region an explicit width track, with exactly one flexible track that absorbs leftover horizontal space.
3. THE Match_Tile SHALL render every layout region with a minimum width of 0 so that region content shrinks rather than overflowing its track.
4. WHILE Tile_Width is unchanged, THE Match_Tile SHALL keep each region's horizontal start position identical across every tile in the Library_View, so that regions align vertically down the list.
5. THE Match_Tile SHALL render the item grid as two rows of three slots plus a trinket slot in Wide_Layout and Medium_Layout.
6. THE Match_Tile SHALL render team rosters as two columns of five participants, allies first.
7. WHERE a video has no linked match, THE Match_Tile SHALL display the file name, the recording time, an unlinked indicator, and the actions region.

### Requirement 3: Match tile responsiveness

**User Story:** As a user who resizes the LeagueVid window and collapses the filter sidebar, I want tiles to adapt to the space they actually have, so that text never overlaps other text.

#### Acceptance Criteria

1. WHILE Tile_Width is 900 CSS pixels or greater, THE Match_Tile SHALL display all regions including the team rosters with participant display names.
2. WHILE Tile_Width is at least 640 and less than 900 CSS pixels, THE Match_Tile SHALL display the team rosters as champion icons without participant display names.
3. WHILE Tile_Width is less than 640 CSS pixels, THE Match_Tile SHALL hide the team rosters, render the item grid as a single wrapping row, and retain the result region and the KDA block.
4. THE Match_Tile SHALL select its layout from Tile_Width rather than from the browser window width, so that changes to the Library_View sidebar width change the layout.
5. FOR ALL Tile_Widths between 320 and 2560 CSS pixels, THE Match_Tile SHALL render with no overlap between the bounding boxes of any two sibling regions.
6. FOR ALL Tile_Widths between 320 and 2560 CSS pixels, THE Match_Tile SHALL keep rendered content within the Match_Tile bounds, truncating overflowing text with an ellipsis.
7. THE Match_Tile SHALL expose the untruncated text of any truncated participant name through a title attribute.

### Requirement 4: Library page responsiveness

**User Story:** As a user working in a small window, I want the filter sidebar to move out of the tiles' way, so that the tiles keep enough room to stay readable.

#### Acceptance Criteria

1. WHILE the Library_View content width is 1000 CSS pixels or greater, THE Library_View SHALL render the filter sidebar and the tile list as two side-by-side columns.
2. WHILE the Library_View content width is less than 1000 CSS pixels, THE Library_View SHALL render the filter sidebar as a full-width region positioned above the tile list.
3. FOR ALL Library_View content widths between 320 and 2560 CSS pixels, THE Library_View SHALL render without horizontal page scrolling.
4. WHEN the Library_View switches between the two-column and stacked arrangements, THE Library_View SHALL preserve the current filter selections.

### Requirement 5: Player page layout

**User Story:** As a user reviewing a VOD, I want the video, the match stats, and my bookmarks all on screen at once, so that I can study a moment without navigating away from it.

#### Acceptance Criteria

1. WHILE the Player_View content width is 1100 CSS pixels or greater, THE Player_View SHALL position the video player in the upper-left region, the Match_Stats_Panel in the upper-right region, and the bookmark list as a full-width region below both.
2. WHILE the Player_View content width is less than 1100 CSS pixels, THE Player_View SHALL position the Match_Stats_Panel below the video player and above the bookmark list, each occupying the full content width.
3. THE Player_View SHALL preserve the video element's aspect ratio at every content width.
4. WHILE the Match_Stats_Panel content exceeds the height of the video player, THE Match_Stats_Panel SHALL scroll its own content rather than growing the Player_View page height.
5. WHEN video playback is running and the user interacts with the Match_Stats_Panel, THE Player_View SHALL continue playback without interruption.
6. WHERE the video has no linked match, THE Player_View SHALL display the video player and the bookmark list, and SHALL replace the Match_Stats_Panel with a message stating that stats require a linked match.

### Requirement 6: Match stats panel navigation and focus player

**User Story:** As a user, I want to switch between kinds of match detail and choose whose stats I am looking at, so that I can review my own play and also study what an opponent or teammate did.

#### Acceptance Criteria

1. THE Match_Stats_Panel SHALL present five tabs labeled Scoreboard, Performance, Build, Graphs, and Insights.
2. WHEN the Player_View opens a linked video, THE Match_Stats_Panel SHALL select the Scoreboard_Tab and SHALL set the Focus_Player to the participant matching the linked account's puuid.
3. WHEN a user selects a tab, THE Match_Stats_Panel SHALL display that tab's content and SHALL retain the current Focus_Player.
4. WHEN a user selects a participant on the Scoreboard_Tab, THE Match_Stats_Panel SHALL set the Focus_Player to that participant.
5. WHEN the Focus_Player changes, THE Build_Tab, Graphs_Tab, Insights_Tab, and Lane_Comparison_Strip SHALL present data for the new Focus_Player.
6. THE Match_Stats_Panel SHALL display the Focus_Player's champion and display name alongside the tab controls.
7. WHILE the Focus_Player is a participant other than the linked account's participant, THE Match_Stats_Panel SHALL display an indicator that a different player is selected and a control that restores the linked account's participant as the Focus_Player.

### Requirement 7: Scoreboard tab

**User Story:** As a user, I want a full post-game scoreboard for all ten players, so that I can see how the whole game went, not just my own row.

#### Acceptance Criteria

1. THE Scoreboard_Tab SHALL display all 10 participants grouped into two teams, with the Focus_Player's team first.
2. THE Scoreboard_Tab SHALL display for each participant the champion icon, display name, kills, deaths, assists, creep score, gold earned, damage dealt to champions, and vision score.
3. THE Scoreboard_Tab SHALL display each team's win or loss result, total kills, and total gold.
4. THE Scoreboard_Tab SHALL visually distinguish the row of the linked account's participant from the other 9 rows.
5. THE Scoreboard_Tab SHALL visually distinguish the row of the current Focus_Player from the other 9 rows.
6. THE Scoreboard_Tab SHALL derive creep score as the sum of `totalMinionsKilled` and `neutralMinionsKilled`.
7. IF a participant's display name is absent from the cached match DTO, THEN THE Scoreboard_Tab SHALL display that participant's champion display name in place of the missing name.

### Requirement 8: Performance tab

**User Story:** As a user, I want to sort all ten players by any headline stat with the values shown as bars, so that I can immediately see who carried and where I ranked.

#### Acceptance Criteria

1. THE Performance_Tab SHALL display all 10 participants in a single table.
2. THE Performance_Tab SHALL provide sorting by kills, KDA ratio, damage dealt to champions, gold earned, wards placed, and creep score.
3. WHEN a user selects a sortable column header, THE Performance_Tab SHALL order rows by that column in descending order.
4. WHEN a user selects the header of the column already used for ordering, THE Performance_Tab SHALL reverse the current order direction.
5. THE Performance_Tab SHALL render each numeric cell with a bar whose filled width is proportional to that value's share of the highest value in the same column across all 10 participants.
6. WHERE the highest value in a column is 0, THE Performance_Tab SHALL render that column's bars with zero filled width.
7. THE Performance_Tab SHALL display the numeric value as text in every cell that renders a bar.
8. THE Performance_Tab SHALL derive KDA ratio as kills plus assists divided by deaths, and SHALL display the text "Perfect" where deaths equal 0.

### Requirement 9: Rune variable verification

**User Story:** As a developer, I want confirmation of what rune performance data actually exists in the real cached matches, so that the Build_Tab is built on verified data instead of an assumption.

#### Acceptance Criteria

1. THE Rune_Var_Verification SHALL read cached match DTOs from the Match_Cache without issuing Riot API requests.
2. THE Rune_Var_Verification SHALL report, for each `perks.styles[].selections[]` entry it finds, the perk id and the values of `var1`, `var2`, and `var3`.
3. THE Rune_Var_Verification SHALL report the count of cached matches inspected and the count of selection entries in which at least one Rune_Variable is non-zero.
4. IF no cached match DTO contains a non-zero Rune_Variable, THEN THE Rune_Var_Verification SHALL report that rune performance values are unavailable in the cached data.
5. THE Rune_Var_Verification SHALL run to completion before the Build_Tab's rune performance display is implemented.

### Requirement 10: Build tab

**User Story:** As a user, I want to see the runes, skill order, and item build with timings for the focus player, so that I can understand the choices behind the performance I just watched.

#### Acceptance Criteria

1. THE Build_Tab SHALL display the Focus_Player's primary and secondary rune trees with each selected rune's icon and display name, read from the cached match DTO's `perks` field.
2. WHERE a rune's perk id exists in the Rune_Label_Map, THE Build_Tab SHALL display that rune's non-zero Rune_Variables with the labels and formatting defined in the Rune_Label_Map.
3. WHERE a rune's perk id is absent from the Rune_Label_Map, THE Build_Tab SHALL display that rune's non-zero Rune_Variables as unlabeled numeric values marked as unlabeled.
4. THE Rune_Label_Map SHALL contain label definitions for every keystone rune of the current season.
5. WHERE every Rune_Variable for a rune equals 0, THE Build_Tab SHALL display that rune's icon and display name without numeric values.
6. THE Build_Tab SHALL display a skill order grid derived from the Focus_Player's `SKILL_LEVEL_UP` timeline events, showing the ability slot chosen at each level.
7. THE Build_Tab SHALL display an item purchase timeline derived from the Focus_Player's `ITEM_PURCHASED` timeline events, with each item's icon and its purchase time in minutes and seconds of game time.
8. THE Build_Tab SHALL exclude from the item purchase timeline any item whose purchase is reversed by an `ITEM_UNDO` timeline event.
9. THE Build_Tab SHALL group item purchase timeline entries that occur within the same shop visit into a single time-stamped group.
10. IF the cached timeline DTO is unavailable for the linked match, THEN THE Build_Tab SHALL display the rune section and a message stating that skill order and item timings require timeline data.

### Requirement 11: Graphs tab

**User Story:** As a user, I want to see gold, damage, XP, and CS develop over the course of the game, so that I can find the point where the game turned.

#### Acceptance Criteria

1. THE Graphs_Tab SHALL plot gold, damage dealt to champions, experience, and creep score against game time, using the per-minute frames of the cached timeline DTO.
2. WHEN the Graphs_Tab opens, THE Graphs_Tab SHALL plot the Focus_Player and the Lane_Opponent.
3. THE Graphs_Tab SHALL provide a control that adds or removes any of the 10 participants from the plotted set.
4. THE Graphs_Tab SHALL display a difference series between the Focus_Player and the Lane_Opponent for the selected metric.
5. THE Graphs_Tab SHALL label the horizontal axis in minutes of game time and the vertical axis with the selected metric's unit.
6. WHEN a user points at a position on a graph, THE Graphs_Tab SHALL display the plotted values at the nearest timeline frame.
7. IF the Lane_Opponent cannot be determined from position data, THEN THE Graphs_Tab SHALL plot the Focus_Player alone and SHALL display a message stating that no lane opponent was identified.
8. THE Graphs_Tab SHALL present the plotted data in a text form reachable by keyboard, so that graph values are available without pointer interaction.

### Requirement 12: Computed heuristic combat statistics

**User Story:** As a user, I want teamfight and duel statistics that the Riot API does not provide, and I want to know which numbers are estimates, so that I can use them without mistaking them for official values.

#### Acceptance Criteria

1. THE Teamfight_Analyzer SHALL group `CHAMPION_KILL` timeline events into teamfights using kill time proximity and kill map position proximity.
2. THE Teamfight_Analyzer SHALL classify a kill group involving two participants as a duel.
3. THE Teamfight_Analyzer SHALL derive teamfight winrate as the share of teamfights in which the Focus_Player's team recorded more kills than the opposing team.
4. THE Teamfight_Analyzer SHALL derive teamfight participation as the share of the Focus_Player's team's teamfights in which the Focus_Player recorded a kill, an assist, or a death.
5. THE Teamfight_Analyzer SHALL derive duel winrate as the share of duels involving the Focus_Player in which the Focus_Player was the killer.
6. THE Teamfight_Analyzer SHALL derive solo deaths as the count of the Focus_Player's deaths in kill groups involving exactly one enemy participant and no allied participant.
7. THE Match_Stats_Panel SHALL display an estimate marker adjacent to every Heuristic_Stat it presents.
8. THE Match_Stats_Panel SHALL provide an explanation, reachable from the estimate marker, stating that the value is computed by LeagueVid from timeline kill events and is not supplied by Riot.
9. WHERE a match records zero teamfights, THE Insights_Tab SHALL display the teamfight statistics as unavailable rather than as a zero percentage.

### Requirement 13: Insights tab

**User Story:** As a user, I want my performance summarized as grouped gauges, so that I can spot my weakest area for the game without reading a table.

#### Acceptance Criteria

1. THE Insights_Tab SHALL display gauges grouped into four sections labeled Fighting, Farming, Objectives, and Vision.
2. THE Insights_Tab SHALL populate the Fighting section from the Focus_Player's `killParticipation`, `teamDamagePercentage`, `soloKills`, and `damagePerMinute` Challenge_Fields, plus the Heuristic_Stats defined in Requirement 12.
3. THE Insights_Tab SHALL populate the Farming section from the Focus_Player's creep score per minute, `laneMinionsFirst10Minutes`, `maxCsAdvantageOnLaneOpponent`, and `goldPerMinute` Challenge_Fields.
4. THE Insights_Tab SHALL populate the Objectives section from the Focus_Player's `dragonTakedowns`, `riftHeraldTakedowns`, `baronTakedowns`, and `turretPlatesTaken` Challenge_Fields.
5. THE Insights_Tab SHALL populate the Vision section from the Focus_Player's `visionScore`, `visionScorePerMinute`, `controlWardsPlaced`, and `wardTakedowns` values.
6. THE Insights_Tab SHALL display each gauge with the metric name, the metric value, and a filled arc proportional to the value's position within that metric's displayed range.
7. WHERE a metric is expressed as a share of a team total, THE Insights_Tab SHALL display the value as a percentage.
8. IF a Challenge_Field required by a gauge is absent from the cached match DTO, THEN THE Insights_Tab SHALL display that gauge as unavailable.

### Requirement 14: Lane opponent comparison strip

**User Story:** As a user, I want my headline stats sitting next to my lane opponent's at all times, so that I always have the comparison that matters most in view.

#### Acceptance Criteria

1. THE Lane_Comparison_Strip SHALL display the Focus_Player's and the Lane_Opponent's creep score, gold earned, and damage dealt to champions.
2. THE Lane_Comparison_Strip SHALL display the signed difference between the Focus_Player's and the Lane_Opponent's value for each compared metric.
3. THE Lane_Comparison_Strip SHALL remain visible while any tab of the Match_Stats_Panel is selected.
4. THE Lane_Comparison_Strip SHALL display the champion icons of the Focus_Player and the Lane_Opponent.
5. IF the Lane_Opponent cannot be determined from position data, THEN THE Lane_Comparison_Strip SHALL display the Focus_Player's values and a message stating that no lane opponent was identified.
6. THE Lane_Comparison_Strip SHALL indicate the sign of each difference through text as well as color.

### Requirement 15: Objective participation timeline

**User Story:** As a user, I want to see when each objective was taken and whether I was there, so that I can tell whether I was in the right place during the game's key moments.

#### Acceptance Criteria

1. THE Objective_Timeline SHALL display each dragon, rift herald, baron, and turret takedown from the cached timeline DTO, positioned by game time.
2. THE Objective_Timeline SHALL display for each objective the taking team and the objective type.
3. THE Objective_Timeline SHALL mark each objective for which the Focus_Player is recorded as the killer or an assisting participant as participated.
4. THE Objective_Timeline SHALL mark each objective for which the Focus_Player is recorded neither as killer nor as assisting participant as not participated.
5. WHEN a user selects an objective on the Objective_Timeline, THE Player_View SHALL seek video playback to the video time corresponding to that objective's game time.

### Requirement 16: Bookmark and stats linkage

**User Story:** As a user, I want my bookmarks and the match stats to refer to each other, so that a moment in the video and the data describing it stay connected.

#### Acceptance Criteria

1. WHEN a user selects a bookmark whose type is a kill, a death, or an assist, THE Graphs_Tab SHALL mark the corresponding game time on every displayed graph.
2. WHEN a user selects a bookmark, THE Match_Stats_Panel SHALL mark the game time of that bookmark on the Objective_Timeline.
3. WHILE video playback is running, THE Graphs_Tab SHALL display a marker at the game time corresponding to the current video playback position.
4. THE Player_View SHALL derive the game time of a video position by subtracting the video's stored synchronization offset from the video position.
5. IF a video has no stored synchronization offset, THEN THE Player_View SHALL treat the synchronization offset as 0 milliseconds.

### Requirement 17: Cached-only data sourcing

**User Story:** As a user with a rate-limited Riot API key, I want the new stats views to run entirely from data already downloaded, so that browsing my own VODs never consumes API budget or waits on the network.

#### Acceptance Criteria

1. THE Match_Stats_Service SHALL read match and timeline data for a linked video from the Match_Cache without issuing Riot API requests.
2. WHILE the Player_View displays the Match_Stats_Panel, THE LeagueVid SHALL issue zero Riot API requests attributable to the Match_Stats_Panel.
3. IF the cached match DTO for a linked match is absent from the Match_Cache, THEN THE Match_Stats_Panel SHALL display a message stating that the match data has not been downloaded yet and that the background download will supply it.
4. IF the cached timeline DTO for a linked match is absent from the Match_Cache, THEN THE Match_Stats_Panel SHALL display the tabs that need only match DTO data and SHALL mark the tabs requiring timeline data as unavailable.
5. THE Match_Stats_Service SHALL retain Data Dragon assets as the source of champion, item, rune, and summoner spell icons and display names.
6. WHEN a stat's source field is absent from the cached data, THE Match_Stats_Panel SHALL display that stat as unavailable rather than as a zero value.
7. THE Match_Stats_Service SHALL produce the derived stat structures for a single match within 500 milliseconds on a match of 45 minutes' duration.

### Requirement 18: Accessibility of the new interface

**User Story:** As a user who navigates by keyboard and needs readable contrast, I want the new panels to be operable and legible, so that the overhaul does not lock me out of the app.

#### Acceptance Criteria

1. THE Match_Stats_Panel SHALL implement its tab controls with the `tab`, `tablist`, and `tabpanel` roles and the corresponding selected-state attributes.
2. WHEN a tab control has keyboard focus and the user presses an arrow key, THE Match_Stats_Panel SHALL move selection to the adjacent tab.
3. THE Scoreboard_Tab and Performance_Tab SHALL render tabular data using table semantics with column header cells.
4. WHEN a column is used for ordering on the Performance_Tab, THE Performance_Tab SHALL expose the current order direction on that column's header cell through the `aria-sort` attribute.
5. THE Insights_Tab SHALL expose each gauge's value with the `progressbar` role and the current, minimum, and maximum value attributes.
6. THE Backfill_Banner SHALL expose download progress with the `progressbar` role and the current, minimum, and maximum value attributes.
7. THE Match_Stats_Panel and the Match_Tile SHALL render text at a contrast ratio of at least 4.5 to 1 against the background behind that text.
8. THE Player_View SHALL make every interactive element of the Match_Stats_Panel reachable by keyboard in a focus order that follows the visual order.
9. THE Match_Stats_Panel SHALL convey win, loss, participation, and difference states through text or shape in addition to color.

### Requirement 19: Preservation of existing behavior

**User Story:** As an existing user, I want everything that already works to keep working after the overhaul, so that the redesign costs me no functionality.

#### Acceptance Criteria

1. THE Match_Tile SHALL retain the open, re-link, and remove actions with their existing behavior.
2. THE Match_Tile SHALL retain the suspicious-link warning indicator and the last-viewed indicator.
3. THE Player_View SHALL retain bookmark creation, bookmark deletion, bookmark jumping, and the lead-in, seek-step, and auto-play-on-jump player preferences.
4. THE Library_View SHALL retain the existing filter controls and their filtering behavior.
5. THE LeagueVid SHALL compile with no TypeScript errors reported by the project's typecheck task.
