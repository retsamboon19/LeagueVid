# LeagueVid

A desktop app for reviewing your own League of Legends VODs. LeagueVid records your games, links them to your match history (via the Riot API), auto-tags key moments (kills, deaths, objectives, multikills) on the video timeline, and shows a full match stats panel (scoreboard, performance, build, graphs, insights) alongside the player. Recordings you already have can be imported the same way.

Built with Electron + React + TypeScript.

## Features

- **Records your games on its own.** LeagueVid notices when a game starts, records it at a quality you choose, stops when the game ends, and drops the file into your library already linked to the right match. It runs in the tray, so you can close the window and still come back to finished recordings. Capture is screen duplication through ffmpeg -- nothing is injected into the game and the game process is never touched.
- **Bookmarks on recordings it made are exact, not estimated.** Because the recorder knows the wall-clock moment its own first frame landed and can read the in-game clock, the offset between video time and game time is measured rather than inferred from a filename. Imported files still use the older filename-and-search approach, which is what makes this difference visible.
- **Auto-links your recordings to your real match history.** Point LeagueVid at the folder(s) where your recordings live and it matches each file to the right game by timestamp, no manual searching. If a filename date is off, or auto-match picks the wrong game, a manual re-link lets you filter your downloaded match history by champion, kills, deaths, or lane opponent to find the right one instead.
- **Auto-tags kills, deaths, assists, objectives, and multikills directly on the video timeline**, so you can jump straight to the action instead of scrubbing through a 40-minute VOD. Add your own manual bookmarks on top for anything the auto-tagger doesn't catch.
- **A deep filtering system for your library, not just "champion + date".** Stack filters like champion(s) played (OR'd, so "Yorick or Sion games"), enemy laner, role, queue type, win/loss, and favorites, plus statistical thresholds like kills, deaths, CS/min, and gold diff vs. your lane opponent. Search for specific moments too: pick a multikill tier (double/triple/quadra/penta) and even require it be a solo multikill with no assists, or hunt down comeback/throw games by setting a gold-lead swing between a chosen minute and the final result (e.g. "down 2000+ gold at 15 but won"). Save any combination as a named preset to reuse later.
- **A full match stats panel next to the player**: scoreboard, sortable performance table, rune choices and skill order, item timeline, and an objective timeline, all synced to the video.
- **An "Insights" tab with stats Riot doesn't give you** -- teamfight winrate, teamfight participation, duel winrate, and solo deaths, computed by grouping timeline kill events that happen close together in time and space (clearly marked as estimates, not official Riot numbers).
- **Built-in clip exporting.** Trim any moment into a standalone MP4 right from a visual timeline editor (zoomable, shows an "action density" curve plus your bookmarks so you can find the fight fast). Drag to trim, slide the whole selection, or nudge frame-by-frame. Export with the bundled ffmpeg in either instant lossless "fast" mode or frame-accurate "exact" mode -- no external video editor needed.
- **Background match history downloads.** LeagueVid gradually pulls your full Riot match history in the background after you link an account, with a status banner showing progress (e.g. "842 of 910 matches saved") so you're never stuck waiting on it before doing anything else.
- **Everything cached locally in SQLite.** Once a match is pulled from the Riot API it's cached, so reopening it later never re-hits the API or rate limit.
- **Multi-account support**, if you play on more than one League account.
- **Per-player settings**, like how many seconds to rewind before jumping to a bookmark, playback skip step, and autoplay-on-jump.
- **Privacy-first.** All your videos, tags, and cached match data stay on your machine. Nothing leaves except direct calls to Riot's API.

## Requirements

- A Riot Games API key -- free, takes about a minute to grab from the [Riot Developer Portal](https://developer.riotgames.com/) (just log in with your Riot account)
- Windows 10 or later for recording. Capture uses the Desktop Duplication API, which is Windows-only; the rest of the app (importing, linking, stats, clipping) works anywhere Electron does.
- Disk space for the footage. LeagueVid shows an estimate for your chosen quality and refuses to start a recording without room for an hour plus conversion headroom. Roughly 5-8 GB per hour at 1440p60, less at 1080p.
- A GPU with a hardware video encoder is strongly preferred (NVENC, Quick Sync, or AMF). LeagueVid tests what your machine actually supports and falls back to software encoding, which works but spends CPU the game is also using -- the built-in ten-second test will tell you whether your settings are sustainable.
- Recordings you already have work too: point LeagueVid at the folder(s) they live in and it will import and link them.

### About recording and anti-cheat

LeagueVid captures your screen, not the game. It never injects code into League of Legends, never reads the game's memory, and never modifies a game file -- it only talks to League over the local HTTP endpoints Riot provides for this purpose. Screen duplication is a deliberate choice over the graphics-hook approach some capture tools use, precisely because hooking is what anti-cheat objects to.

You do **not** need to know how to code to use LeagueVid. The steps below are copy-paste and click-through -- no terminal commands required beyond what the setup script runs for you.

## Getting started (the easy way)

1. Download this project: click the green **Code** button near the top of this page → **Download ZIP**, then extract it anywhere (e.g. your Desktop).
2. Open the extracted `LeagueVid` folder and double-click **`setup.bat`**.
   - This checks whether you have Node.js installed, and opens the download page for you if you don't (just install it with the default options and re-run `setup.bat`).
   - It then installs everything LeagueVid needs automatically -- this can take a couple of minutes, that's normal.
   - It walks you through pasting in a Riot API key (it'll open the Riot Developer Portal for you). If you'd rather skip this step, just press Enter -- you can paste a key into the app's Settings screen later instead.
3. When setup finishes, it offers to launch the app right away. From then on, just double-click **`run-dev.bat`** any time you want to open LeagueVid.
4. In the app, go to **Settings** to link your Riot account (Riot ID + tag line, and your region), then point LeagueVid at the folder(s) where your recordings live.

That's it -- LeagueVid will start matching your recordings to your match history in the background.

> **Note on the Riot API key:** a personal ("development") key from the Riot Developer Portal expires every 24 hours and has a low rate limit. That's normal for a hobby project like this -- just grab a fresh one from the portal and paste it into Settings when the old one stops working. LeagueVid queues and throttles requests automatically either way.

## Getting started (manual / other OS)

1. Install [Node.js](https://nodejs.org/) 18 or newer.
2. Clone or download the repository, then in a terminal:

   ```bash
   cd LeagueVid
   npm install
   ```

3. Set up your Riot API key. Copy `.env.example` to `.env` and fill in your key:

   ```bash
   cp .env.example .env
   ```

   ```
   RIOT_API_KEY=your-riot-api-key-here
   ```

   You can skip this and paste your key into the app's Settings screen instead, which lets you update it any time without restarting.

4. Run the app in dev mode:

   ```bash
   npm run dev
   ```

5. In the app, go to **Settings** to link your Riot account (Riot ID + tag line, and your region), then point LeagueVid at the folder(s) where your recordings live.

## Building a distributable

```bash
npm run build
```

This produces a packaged build under `out/`.

## Project structure

```
src/
  main/       Electron main process: Riot API client, SQLite DB, video/clip handling
  preload/    IPC bridge exposed to the renderer
  renderer/   React UI (library, player, stats panel, settings)
  shared/     Types shared across processes
scripts/      Standalone diagnostic/dev scripts (run with npx tsx scripts/<name>.ts)
```

## Notes on data and privacy

- All data (your linked videos, tags, and cached Riot API responses) stays local on your machine in Electron's userData folder -- nothing is sent anywhere except direct requests to the Riot API.
- Your `.env` file (and any API key) is git-ignored and never committed.

## Troubleshooting

- **`setup.bat` says Node.js wasn't found, even after installing it**: close and reopen the folder (or restart your PC) so Windows picks up the new install, then run `setup.bat` again.
- **"No Riot API key set"**: add a key via the Settings screen or in `.env` (see step 3 above).
- **Rate limit errors**: personal development keys have low rate limits. LeagueVid queues and throttles requests automatically, but large history backfills will still take a while on a dev key.
- **A recording won't link to a match**: check that the file's recorded timestamp roughly overlaps the match's actual play time; see `scripts/diagnose-video-sync.ts` for a deeper look.

## License

No license has been specified for this project. All rights reserved by the author unless stated otherwise.
