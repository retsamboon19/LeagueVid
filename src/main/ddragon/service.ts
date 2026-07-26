import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DDragonBundle } from '../../shared/types'

const DDRAGON_BASE = 'https://ddragon.leagueoflegends.com'
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // refetch at most once a day

// Bump this whenever buildBundle()'s data-mapping logic changes in a way
// that would make an old cached bundle silently wrong (not just incomplete).
// e.g. summoner spells were previously indexed by the wrong field, which
// isValidBundle()'s shape check alone wouldn't have caught.
// v3: runes now include every rune in every slot (plus the style rows),
// not only keystones -- an older cached bundle would leave the Build tab's
// minor runes nameless.
const CACHE_SCHEMA_VERSION = 3

interface CacheFile {
  fetchedAt: number
  schemaVersion: number
  bundle: DDragonBundle
}

let memoryCache: DDragonBundle | null = null

function cachePath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'ddragon-cache.json')
}

function readDiskCache(): CacheFile | null {
  try {
    const path = cachePath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as CacheFile
  } catch {
    return null
  }
}

function writeDiskCache(bundle: DDragonBundle): void {
  try {
    const payload: CacheFile = {
      fetchedAt: Date.now(),
      schemaVersion: CACHE_SCHEMA_VERSION,
      bundle
    }
    writeFileSync(cachePath(), JSON.stringify(payload), 'utf-8')
  } catch {
    // Non-fatal: worst case we refetch next launch.
  }
}

interface RawChampionData {
  data: Record<string, { id: string; key: string; name: string }>
}

interface RawItemData {
  data: Record<string, { name: string; image: { full: string } }>
}

interface RawSummonerSpellData {
  data: Record<string, { id: string; key: string; name: string; image: { full: string } }>
}

interface RawRuneSlot {
  runes: Array<{ id: number; key: string; icon: string; name: string }>
}

interface RawRuneStyle {
  id: number
  key: string
  icon: string
  name: string
  slots: RawRuneSlot[]
}

type RawRunesReforged = RawRuneStyle[]

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Data Dragon request failed (${res.status}): ${url}`)
  }
  return res.json() as Promise<T>
}

async function fetchLatestVersion(): Promise<string> {
  const versions = await fetchJson<string[]>(`${DDRAGON_BASE}/api/versions.json`)
  if (!versions[0]) throw new Error('Data Dragon returned no versions.')
  return versions[0]
}

async function buildBundle(version: string): Promise<DDragonBundle> {
  const [championData, itemData, summonerData, runesData] = await Promise.all([
    fetchJson<RawChampionData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/champion.json`),
    fetchJson<RawItemData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/item.json`),
    fetchJson<RawSummonerSpellData>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/summoner.json`),
    fetchJson<RawRunesReforged>(`${DDRAGON_BASE}/cdn/${version}/data/en_US/runesReforged.json`)
  ])

  const champions: DDragonBundle['champions'] = {}
  for (const champ of Object.values(championData.data)) {
    champions[champ.id] = { id: champ.id, key: champ.key, name: champ.name }
  }

  const items: DDragonBundle['items'] = {}
  for (const [itemId, item] of Object.entries(itemData.data)) {
    items[itemId] = { name: item.name, image: item.image.full }
  }

  // summoner.json's top-level key and `id` field are both the string form
  // (e.g. "SummonerFlash"); the numeric id match-v5 actually returns in
  // summoner1Id/summoner2Id is in the `key` field (e.g. "4"). Index by that
  // for O(1) lookup from the renderer.
  const summonerSpells: DDragonBundle['summonerSpells'] = {}
  for (const spell of Object.values(summonerData.data)) {
    summonerSpells[spell.key] = { name: spell.name, image: spell.image.full }
  }

  // Index EVERY rune, not just keystones. Keystones alone were enough for
  // the library's "keystone" filter, but the player page's Build tab shows a
  // player's whole rune page -- with only keystones indexed, minor runes had
  // no name or icon and rendered as "Rune 8446" (Demolish), "Rune 8473"
  // (Bone Plating) and so on. Data Dragon supplies all of them; there's no
  // need to hand-tag anything.
  const runes: DDragonBundle['runes'] = {}
  for (const style of runesData) {
    // The style itself (Precision, Domination, ...) also has an id/icon and
    // is worth indexing, since a rune page references its tree.
    runes[String(style.id)] = { name: style.name, icon: style.icon }
    for (const slot of style.slots) {
      for (const rune of slot.runes) {
        runes[String(rune.id)] = { name: rune.name, icon: rune.icon }
      }
    }
  }

  return {
    version,
    championIconBase: `${DDRAGON_BASE}/cdn/${version}/img/champion`,
    itemIconBase: `${DDRAGON_BASE}/cdn/${version}/img/item`,
    summonerSpellIconBase: `${DDRAGON_BASE}/cdn/${version}/img/spell`,
    runeIconBase: `${DDRAGON_BASE}/cdn/img`,
    champions,
    items,
    summonerSpells,
    runes
  }
}

// Guards against loading a disk cache written by an older version of this
// app that predates a field being added to DDragonBundle (e.g. `runes` was
// added after `championIconBase` etc. already existed) -- an incomplete
// cached bundle would otherwise crash consumers expecting the full shape.
function isValidBundle(bundle: unknown): bundle is DDragonBundle {
  if (!bundle || typeof bundle !== 'object') return false
  const b = bundle as Partial<DDragonBundle>
  return (
    typeof b.version === 'string' &&
    typeof b.championIconBase === 'string' &&
    typeof b.itemIconBase === 'string' &&
    typeof b.summonerSpellIconBase === 'string' &&
    typeof b.runeIconBase === 'string' &&
    typeof b.champions === 'object' &&
    typeof b.items === 'object' &&
    typeof b.summonerSpells === 'object' &&
    typeof b.runes === 'object' &&
    b.champions !== null &&
    b.items !== null &&
    b.summonerSpells !== null &&
    b.runes !== null
  )
}

function isFreshAndCompatible(disk: CacheFile): boolean {
  return (
    isValidBundle(disk.bundle) &&
    disk.schemaVersion === CACHE_SCHEMA_VERSION &&
    Date.now() - disk.fetchedAt < CACHE_MAX_AGE_MS
  )
}

export async function getDDragonBundle(): Promise<DDragonBundle> {
  if (memoryCache) return memoryCache

  const disk = readDiskCache()
  if (disk && isFreshAndCompatible(disk)) {
    memoryCache = disk.bundle
    return memoryCache
  }

  try {
    const version = await fetchLatestVersion()
    const bundle = await buildBundle(version)
    memoryCache = bundle
    writeDiskCache(bundle)
    return bundle
  } catch (err) {
    // Fall back to a stale disk cache rather than failing outright if we're
    // offline or Data Dragon is unreachable -- but only if it's actually
    // usable and built with the current schema (see isValidBundle).
    if (disk && isValidBundle(disk.bundle) && disk.schemaVersion === CACHE_SCHEMA_VERSION) {
      memoryCache = disk.bundle
      return memoryCache
    }
    throw err
  }
}
