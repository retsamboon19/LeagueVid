# LeagueVid

A desktop app for reviewing your own League of Legends VODs. LeagueVid links your local recordings to your match history (via the Riot API), auto-tags key moments (kills, deaths, objectives, multikills) on the video timeline, and shows a full match stats panel (scoreboard, performance, build, graphs, insights) alongside the player.

Built with Electron + React + TypeScript.

## Features

- Auto-links local recordings to your Riot match history based on timestamps
- Auto-tags kills, deaths, assists, objectives, and multikills on the video timeline
- Manual bookmarking/tagging for your own highlights
- Match stats panel: scoreboard, sortable performance table, rune values, skill order, item timeline, and heuristic teamfight/duel stats
- Library view with filtering (champion, role, queue, favorites, etc.)
- Local SQLite-backed cache of Riot API data, so re-opening a match never re-hits the API

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- A Riot Games API key from the [Riot Developer Portal](https://developer.riotgames.com/)
- Your own League of Legends game recordings (LeagueVid links to recordings you already have; it doesn't record anything itself)

## Getting started

1. Clone the repository:

   ```bash
   git clone https://github.com/<your-username>/LeagueVid.git
   cd LeagueVid
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up your Riot API key. Copy `.env.example` to `.env` and fill in your key:

   ```bash
   cp .env.example .env
   ```

   ```
   RIOT_API_KEY=your-riot-api-key-here
   ```

   You can get a (personal, rate-limited) key from the [Riot Developer Portal](https://developer.riotgames.com/). Development keys expire after 24 hours -- you can also skip the `.env` file entirely and paste your key into the app's Settings screen instead, which lets you update it any time without restarting.

4. Run the app in dev mode:

   ```bash
   npm run dev
   ```

   On Windows you can also just double-click `run-dev.bat`.

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

- **"No Riot API key set"**: add a key via the Settings screen or in `.env` (see step 3 above).
- **Rate limit errors**: personal development keys have low rate limits. LeagueVid queues and throttles requests automatically, but large history backfills will still take a while on a dev key.
- **A recording won't link to a match**: check that the file's recorded timestamp roughly overlaps the match's actual play time; see `scripts/diagnose-video-sync.ts` for a deeper look.

## License

No license has been specified for this project. All rights reserved by the author unless stated otherwise.
