const OFFICIAL_DRAKE_NAMES: Record<string, string> = {
  air: 'Cloud Drake',
  cloud: 'Cloud Drake',
  fire: 'Infernal Drake',
  infernal: 'Infernal Drake',
  earth: 'Mountain Drake',
  mountain: 'Mountain Drake',
  water: 'Ocean Drake',
  ocean: 'Ocean Drake',
  hextech: 'Hextech Drake',
  chemtech: 'Chemtech Drake',
  elder: 'Elder Dragon'
}

/** Converts Riot's internal dragon subtype into its official display name. */
export function dragonDisplayName(subtype: string | undefined): string {
  if (!subtype) return 'Dragon'

  const normalized = subtype.trim().replace(/_DRAGON$/i, '').toLowerCase()
  const officialName = OFFICIAL_DRAKE_NAMES[normalized]
  if (officialName) return officialName

  const readable = normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
  return readable ? `${readable} Drake` : 'Dragon'
}
