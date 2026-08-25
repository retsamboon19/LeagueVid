# Changelog

## v0.3.8 — Safe Match Detachment

- Changed the X action in Match History to detach only the associated
  recording, keeping the match and its stats visible while preserving the
  recording as an unlinked entry in Recordings.
- Added a Match History refresh control that checks Riot's recent matches,
  waits for missing data to cache, and then reloads the displayed history.

## v0.3.7 — Complete Match History

- Added a cache-backed match history to the Library so matches remain visible
  even when no LeagueVid recording exists.
- Added a full-width stats-only match view that removes recording controls and
  timeline jump actions instead of leaving empty video space.
- Kept linked recordings accessible from the same history while retaining a
  dedicated Recordings view for recording management.

## v0.3.6 — First-Run Account Setup

- Added focused first-run account onboarding so a new user is prompted to
  connect a Riot ID before entering the app.
- Added a clear `+ Add another account` path during onboarding and retained
  the existing multi-account support.
- Limited onboarding to genuinely fresh profiles; retained account settings
  skip it after reinstalling, and removing all accounts later does not bring it
  back unexpectedly.
- Added an opt-in private-beta installer build that can include the ignored
  local Riot API key without affecting standard or GitHub release builds.

## v0.3.5 — Official Drake Names

- Replaced Riot's internal Air, Fire, Earth, and Water dragon labels with the
  official Cloud, Infernal, Mountain, and Ocean Drake names.
- Standardized Hextech and Chemtech as Drakes while preserving Elder Dragon's
  official name in both live-event and match-history objective markers.

## v0.3.4 — Recording Reliability

- Avoided OBS Game Capture when RivaTuner or MSI Afterburner can leave an
  entire League recording frozen on one frame.
- Made the in-app installer handoff complete and reopen LeagueVid reliably.
- Published the fixes under a newer version so existing 0.3.3 installations
  can discover them through Check for Updates.

## v0.3.2 — VOD Theme Completion

- Extended the animated starfield and color-shifting background into the VOD
  viewer.
- Recolored match stats, achievements, tables, graphs, insights, objectives,
  and player highlights to match the purple-and-pink visual system.
- Corrected Conqueror's post-game rune statistic label from total damage to
  total healing.

## v0.3.0 — Visual Overhaul

- Fixed achievement catalog counts and recording filters so timeline-based and
  bookmark-based achievements match the recording details view.
- Reworked the Library and player interface with a dark-purple, neon-pink theme.
- Added an animated background while keeping the app header clear and readable.
- Updated the project overview to match the current recording, achievement, and
  match-analysis feature set.

## v0.2.1 — Pre-Visual Overhaul

- Preserved the original blue/dark-gray interface before the new theme landed.
- Includes the complete recording, match review, achievement, and gank-analysis
  feature set available at that point.
