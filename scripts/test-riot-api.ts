// Standalone end-to-end test of the Riot API integration, run outside Electron.
// Usage: npx tsx scripts/test-riot-api.ts <gameName> <tagLine> [platform]
//   e.g. npx tsx scripts/test-riot-api.ts "Faker" "KR1" kr
//
// Verifies: account lookup -> match history -> match + timeline fetch ->
// auto-tag event extraction, against the live Riot API.

import { config } from 'dotenv'
import { resolve } from 'path'
import { RiotClient, accountRegionForPlatform, matchRegionForPlatform } from '../src/main/riot/client'
import { extractPlayerEvents } from '../src/main/riot/extractEvents'
import type { PlatformRouting } from '../src/shared/types'

config({ path: resolve(__dirname, '../.env') })

const GAME_NAME = process.argv[2]
const TAG_LINE = process.argv[3]
const PLATFORM = (process.argv[4] ?? 'na1') as PlatformRouting

if (!GAME_NAME || !TAG_LINE) {
  console.error('Usage: npx tsx scripts/test-riot-api.ts <gameName> <tagLine> [platform]')
  console.error('  e.g. npx tsx scripts/test-riot-api.ts "Faker" "KR1" kr')
  process.exit(1)
}

async function main(): Promise<void> {
  const apiKey = process.env.RIOT_API_KEY
  if (!apiKey) {
    throw new Error('RIOT_API_KEY not found in .env')
  }

  const client = new RiotClient(apiKey)

  console.log(`\n[1/4] Looking up account ${GAME_NAME}#${TAG_LINE}...`)
  const accountRegion = accountRegionForPlatform(PLATFORM)
  const account = await client.getAccountByRiotId(accountRegion, GAME_NAME, TAG_LINE)
  console.log(`  -> puuid: ${account.puuid}`)
  console.log(`  -> gameName#tagLine: ${account.gameName}#${account.tagLine}`)

  console.log(`\n[2/4] Fetching recent match IDs...`)
  const matchRegion = matchRegionForPlatform(PLATFORM)
  const matchIds = await client.getMatchIdsByPuuid(matchRegion, account.puuid, { count: 5 })
  console.log(`  -> found ${matchIds.length} matches:`, matchIds)

  if (matchIds.length === 0) {
    console.log('\nNo matches found. Stopping here (nothing to test further).')
    return
  }

  const matchId = matchIds[0]
  console.log(`\n[3/4] Fetching match + timeline for ${matchId}...`)
  const [match, timeline] = await Promise.all([
    client.getMatch(matchRegion, matchId),
    client.getMatchTimeline(matchRegion, matchId)
  ])

  const participant = match.info.participants.find((p) => p.puuid === account.puuid)
  if (!participant) {
    throw new Error('Player not found in their own match -- something is wrong.')
  }

  console.log(`  -> champion: ${participant.championName}`)
  console.log(`  -> KDA: ${participant.kills}/${participant.deaths}/${participant.assists}`)
  console.log(`  -> result: ${participant.win ? 'Win' : 'Loss'}`)
  console.log(`  -> game mode: ${match.info.gameMode}, duration: ${match.info.gameDuration}s`)
  console.log(`  -> gameStartTimestamp (epoch ms): ${match.info.gameStartTimestamp}`)

  console.log(`\n[4/4] Extracting auto-tag events from timeline...`)
  const events = extractPlayerEvents(timeline, participant.participantId, match.info)
  console.log(`  -> extracted ${events.length} events:`)
  for (const ev of events) {
    const seconds = Math.round(ev.gameTimestampMs / 1000)
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    console.log(`     [${mm}:${ss}] ${ev.type.padEnd(14)} ${ev.label}`)
  }

  console.log('\nAll steps completed successfully.')
}

main().catch((err) => {
  console.error('\nTest failed:', err)
  process.exitCode = 1
})
