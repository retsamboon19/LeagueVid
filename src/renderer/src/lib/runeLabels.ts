// Labels for rune performance values (Rune_Label_Map).
//
// Riot's match data attaches three numbers to every rune a player took --
// var1, var2, var3 -- and those hold the same values the League client shows
// on its post-game rune panel (Press the Attack's total damage, Triumph's
// health restored, and so on). What Riot does NOT provide is any indication
// of what each number MEANS. There is no official mapping, so this table is
// hand-written.
//
// The perk ids and value shapes below were confirmed against real cached
// match data using `npx tsx scripts/verify-rune-vars.ts`, which reported
// 91.8% of ~44,600 rune selections carrying non-zero values across 744
// matches. Where a rune isn't listed here, the UI shows its raw numbers
// marked as unlabeled rather than guessing at a label -- a wrong label is
// worse than an honest unknown.
//
// Some runes legitimately report all zeros (Cosmic Insight, perk 8347, never
// reported a value in any of the 744 matches inspected). Those render as
// icon + name only.

export type RuneVarFormat = 'number' | 'seconds' | 'percent'

export interface RuneVarLabel {
  label: string
  format?: RuneVarFormat
}

/**
 * perk id -> labels for [var1, var2, var3].
 * A null entry means that slot carries nothing meaningful for this rune.
 */
const RUNE_VAR_LABELS: Record<number, Array<RuneVarLabel | null>> = {
  // --- Precision ---
  8005: [{ label: 'Total damage' }, { label: 'Bonus damage' }, null], // Press the Attack
  8008: [{ label: 'Total damage' }, { label: 'Bonus damage' }, null], // Lethal Tempo
  8021: [{ label: 'Total damage' }, null, null], // Fleet Footwork
  8010: [{ label: 'Total healing' }, null, null], // Conqueror
  9101: [{ label: 'Health overhealed' }, null, null], // Overheal
  9111: [{ label: 'Health restored' }, { label: 'Bonus gold' }, null], // Triumph
  8009: [{ label: 'Mana restored' }, null, null], // Presence of Mind
  9104: [{ label: 'Attack speed gained', format: 'percent' }, { label: 'Stacks' }, null], // Legend: Alacrity
  9105: [{ label: 'Tenacity gained', format: 'percent' }, { label: 'Stacks' }, null], // Legend: Haste
  9103: [{ label: 'Life steal gained', format: 'percent' }, { label: 'Stacks' }, null], // Legend: Bloodline
  8014: [{ label: 'Bonus damage' }, null, null], // Coup de Grace
  8017: [{ label: 'Bonus damage' }, null, null], // Cut Down
  8299: [{ label: 'Bonus damage' }, null, null], // Last Stand

  // --- Domination ---
  8112: [{ label: 'Total damage' }, null, null], // Electrocute
  8128: [{ label: 'Total damage' }, { label: 'Souls collected' }, null], // Dark Harvest
  9923: [{ label: 'Total damage' }, { label: 'Procs' }, null], // Hail of Blades
  8126: [{ label: 'Total damage' }, null, null], // Cheap Shot
  8143: [{ label: 'Total damage' }, null, null], // Sudden Impact
  8137: [{ label: 'Bounty stacks' }, null, null], // Sixth Sense
  8140: [{ label: 'Gold earned' }, null, null], // Grisly Mementos
  8141: [{ label: 'Bounty gold' }, null, null], // Deep Ward / bounty tracking
  8135: [{ label: 'Gold earned' }, { label: 'Takedowns' }, null], // Treasure Hunter
  8136: [{ label: 'Adaptive force' }, { label: 'Wards collected' }, null], // Zombie Ward
  8120: [{ label: 'Stacks' }, { label: 'Move speed' }, { label: 'Vision granted' }], // Ghost Poro
  8105: [{ label: 'Move speed gained' }, { label: 'Stacks' }, null], // Relentless Hunter
  8106: [{ label: 'Stacks' }, { label: 'Ability haste' }, null], // Ultimate Hunter
  8138: [{ label: 'Adaptive force' }, { label: 'Stacks' }, null], // Eyeball Collection

  // --- Sorcery ---
  8214: [{ label: 'Total damage' }, { label: 'Total shielding' }, null], // Summon Aery
  8229: [{ label: 'Total damage' }, null, null], // Arcane Comet
  8230: [{ label: 'Move speed procs' }, null, null], // Phase Rush
  8224: [{ label: 'Procs' }, { label: 'Damage shielded' }, null], // Nullifying Orb
  8226: [{ label: 'Mana restored' }, { label: 'Max mana gained' }, null], // Manaflow Band
  8210: [{ label: 'Ability haste' }, null, null], // Transcendence
  8234: [{ label: 'Total damage' }, null, null], // Celerity / Axiom Arcanist
  8233: [{ label: 'Health restored' }, { label: 'Procs' }, null], // Absorb Life
  8237: [{ label: 'Total damage' }, null, null], // Scorch
  8236: [{ label: 'Adaptive force' }, null, null], // Gathering Storm
  8232: [{ label: 'Procs' }, null, null], // Waterwalking
  8275: [{ label: 'Procs' }, null, null], // Nimbus Cloak

  // --- Resolve ---
  8437: [{ label: 'Total damage' }, { label: 'Health gained' }, null], // Grasp of the Undying
  8439: [{ label: 'Damage mitigated' }, { label: 'Resistances gained' }, null], // Aftershock
  8465: [{ label: 'Damage shielded' }, null, null], // Guardian
  8446: [{ label: 'Turret damage' }, null, null], // Demolish
  8463: [{ label: 'Healing to allies' }, null, null], // Font of Life
  8401: [{ label: 'Damage shielded' }, null, null], // Shield Bash
  8429: [{ label: 'Armor gained' }, { label: 'Magic resist gained' }, { label: 'Procs' }], // Conditioning
  8444: [{ label: 'Health restored' }, null, null], // Second Wind
  8473: [{ label: 'Damage blocked' }, null, null], // Bone Plating
  8451: [{ label: 'Bonus health' }, null, null], // Overgrowth
  8453: [{ label: 'Healing increased' }, { label: 'Shielding increased' }, null], // Revitalize
  8242: [{ label: 'Tenacity gained', format: 'percent' }, null, null], // Unflinching

  // --- Inspiration ---
  8351: [{ label: 'Slows applied' }, { label: 'Total damage' }, null], // Glacial Augment
  8360: [{ label: 'Spells swapped' }, null, null], // Unsealed Spellbook
  8369: [{ label: 'Gold earned' }, { label: 'Bonus damage' }, null], // First Strike
  8306: [{ label: 'Flash casts' }, null, null], // Hextech Flashtraption
  8304: [{ label: 'Gold saved' }, { label: 'Move speed' }, null], // Magical Footwear
  8313: [{ label: 'Potions gained' }, null, null], // Triple Tonic / Perfect Timing
  8321: [{ label: 'Gold gained' }, null, null], // Cash Back / Future's Market
  8316: [{ label: 'Minions dematerialized' }, { label: 'Bonus damage', format: 'percent' }, null], // Minion Dematerializer
  8345: [{ label: 'Biscuits received' }, null, { label: 'Mana restored' }], // Biscuit Delivery
  8347: [], // Cosmic Insight -- never reports values, icon + name only
  8410: [{ label: 'Move speed procs' }, null, null], // Approach Velocity
  8352: [null, { label: 'Healing gained' }, null], // Time Warp Tonic
  8992: [{ label: 'Total damage' }, null, null] // Ingenious/Legend variant
}

export interface LabeledRuneVar {
  /** Present when this rune's slot has a known meaning. */
  label: string | null
  value: number
  format: RuneVarFormat
}

/**
 * Turns a rune's three raw values into displayable entries, dropping zeros.
 *
 * Returns `{ mapped: false }` when this perk isn't in the table, so the UI
 * can mark the numbers as unlabeled instead of presenting a guess as fact.
 */
export function labelRuneVars(
  perkId: number,
  vars: [number, number, number]
): { mapped: boolean; entries: LabeledRuneVar[] } {
  const labels = RUNE_VAR_LABELS[perkId]
  const mapped = labels !== undefined

  const entries: LabeledRuneVar[] = []
  vars.forEach((value, index) => {
    if (!value) return // zero means the rune had no measurable effect here
    const labelDef = mapped ? labels[index] : undefined
    entries.push({
      label: labelDef?.label ?? null,
      value,
      format: labelDef?.format ?? 'number'
    })
  })

  return { mapped, entries }
}

export function formatRuneVar(entry: LabeledRuneVar): string {
  if (entry.format === 'percent') return `${entry.value}%`
  if (entry.format === 'seconds') {
    const mm = Math.floor(entry.value / 60)
    const ss = Math.round(entry.value % 60)
    return `${mm}:${String(ss).padStart(2, '0')}`
  }
  return entry.value.toLocaleString()
}

// Stat shards (the three small rows below the rune trees). Data Dragon's
// runesReforged.json genuinely does not include these -- it only covers the
// five rune trees -- so unlike actual runes, these do have to be named by
// hand. The id set is small and stable.
const STAT_SHARD_NAMES: Record<number, string> = {
  5001: 'Health',
  5002: 'Armor',
  5003: 'Magic Resist',
  5005: 'Attack Speed',
  5007: 'Ability Haste',
  5008: 'Adaptive Force',
  5010: 'Move Speed',
  5011: 'Health Scaling',
  5013: 'Tenacity'
}

/**
 * Display name for a perk id, preferring Data Dragon (which covers every
 * real rune) and falling back to the hand-written stat shard names. Returns
 * null when neither knows it, so callers can decide how to present that.
 */
export function runeDisplayName(
  perkId: number,
  ddragonRuneName: string | undefined
): string | null {
  if (ddragonRuneName) return ddragonRuneName
  return STAT_SHARD_NAMES[perkId] ?? null
}
