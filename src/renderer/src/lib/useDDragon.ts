import { useEffect, useState } from 'react'
import type { DDragonBundle } from '../../../shared/types'

let cachedBundle: DDragonBundle | null = null
let inFlight: Promise<DDragonBundle> | null = null

function loadBundle(): Promise<DDragonBundle> {
  if (cachedBundle) return Promise.resolve(cachedBundle)
  if (!inFlight) {
    inFlight = window.api.ddragon.getBundle().then((bundle) => {
      cachedBundle = bundle
      return bundle
    })
  }
  return inFlight
}

export function useDDragon(): DDragonBundle | null {
  const [bundle, setBundle] = useState<DDragonBundle | null>(cachedBundle)

  useEffect(() => {
    if (!bundle) {
      loadBundle().then(setBundle)
    }
  }, [bundle])

  return bundle
}

export function championIconUrl(bundle: DDragonBundle, championName: string): string | null {
  const champ = bundle.champions[championName]
  if (!champ) return null
  return `${bundle.championIconBase}/${champ.id}.png`
}

export function itemIconUrl(bundle: DDragonBundle, itemId: number): string | null {
  if (!itemId) return null
  const item = bundle.items[String(itemId)]
  if (!item) return null
  return `${bundle.itemIconBase}/${item.image}`
}

export function summonerSpellIconUrl(bundle: DDragonBundle, spellId: number): string | null {
  const spell = bundle.summonerSpells[String(spellId)]
  if (!spell) return null
  return `${bundle.summonerSpellIconBase}/${spell.image}`
}

export function runeIconUrl(bundle: DDragonBundle, runeId: number): string | null {
  const rune = bundle.runes[String(runeId)]
  if (!rune) return null
  return `${bundle.runeIconBase}/${rune.icon}`
}

/** All champions as autocomplete options, sorted alphabetically by display name. */
export function championOptions(
  bundle: DDragonBundle
): { value: string; label: string; iconUrl: string }[] {
  if (!bundle?.champions) return []
  return Object.values(bundle.champions)
    .map((c) => ({ value: c.id, label: c.name, iconUrl: `${bundle.championIconBase}/${c.id}.png` }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** All keystone runes as autocomplete options, sorted alphabetically by name. */
export function runeOptions(
  bundle: DDragonBundle
): { value: string; label: string; iconUrl: string }[] {
  if (!bundle?.runes) return []
  return Object.entries(bundle.runes)
    .map(([id, rune]) => ({
      value: id,
      label: rune.name,
      iconUrl: `${bundle.runeIconBase}/${rune.icon}`
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Fuzzy-matches free-typed champion name input against Data Dragon's
 * champion list. Matches by lowercase substring against both the display
 * name (e.g. "Wukong") and the internal id (e.g. "MonkeyKing"), so typing
 * "wukong" or "monkey" both work. Returns matching champion ids -- the form
 * Riot's match API actually stores in championName (e.g. "MonkeyKing", not
 * "Wukong"; "DrMundo", not "Dr. Mundo").
 */
export function findChampionIdsByQuery(bundle: DDragonBundle, query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return Object.values(bundle.champions)
    .filter((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    .map((c) => c.id)
}

/** Display name for a stored championName (which is really Riot's internal id). */
export function championDisplayName(bundle: DDragonBundle, championId: string): string {
  return bundle.champions[championId]?.name ?? championId
}

/**
 * Returns true if a video's stored championName (Riot's internal id form)
 * matches free-typed user input, resolved through Data Dragon so typing a
 * display name like "Wukong" matches a stored value of "MonkeyKing".
 */
export function championMatchesQuery(
  bundle: DDragonBundle | null,
  championName: string,
  query: string
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (championName.toLowerCase().includes(q)) return true
  if (!bundle) return false
  const displayName = championDisplayName(bundle, championName)
  return displayName.toLowerCase().includes(q)
}
