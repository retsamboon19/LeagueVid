import { Filter, Star, Trophy, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import Autocomplete from '../components/Autocomplete'
import { ACHIEVEMENTS, tierForDefinition, type AchievementTier } from '../lib/achievements'
import {
  useDDragon,
  summonerSpellIconUrl,
  championOptions,
  runeOptions,
  championDisplayName
} from '../lib/useDDragon'
import { MULTIKILL_FILTER_TYPES, MULTIKILL_LABELS, type MultikillFilterType } from '../../../shared/types'

export interface ThresholdFilter {
  value: string
  comparison: 'gte' | 'lte'
}

// Riot queue ids worth a quick-pick button. Anything else the user played
// (customs, other event modes) just won't match any of these -- there's no
// "other" bucket since it would be indistinguishable from "not selected".
export const QUEUE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: '420', label: 'Ranked Solo' },
  { id: '440', label: 'Ranked Flex' },
  { id: '400', label: 'Normal Draft' },
  { id: '430', label: 'Normal Blind' },
  { id: '450', label: 'ARAM' }
]

export const ROLE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'TOP', label: 'Top' },
  { id: 'JUNGLE', label: 'Jungle' },
  { id: 'MIDDLE', label: 'Mid' },
  { id: 'BOTTOM', label: 'Bot' },
  { id: 'UTILITY', label: 'Support' }
]

// Achievement ids as picker options, keyed by title. Static data, so built once
// at module load rather than per render.
const ACHIEVEMENT_OPTIONS = ACHIEVEMENTS.map((def) => ({
  value: def.id,
  label: def.title
})).sort((a, b) => a.label.localeCompare(b.label))

const ACHIEVEMENT_META = new Map<
  string,
  { title: string; tier: AchievementTier; category: 'positive' | 'negative' }
>(
  ACHIEVEMENTS.map((def) => [
    def.id,
    { title: def.title, tier: tierForDefinition(def), category: def.category }
  ])
)

export interface MatchFilters {
  // Multiple champions OR'd together -- "any of these" rather than one.
  championsPlayed: string[]
  /**
   * Achievement ids the recording must have earned, OR'd together like
   * championsPlayed -- a recording matches if it earned ANY of them.
   *
   * Evaluated in the renderer against the library's bulk stats rather than
   * stored anywhere, since achievements are derived data and the rules change
   * between releases; a persisted list would go stale the first time a
   * threshold moved. See Library's achievementsByVideo.
   */
  achievementIds: string[]
  enemyLaner: string
  kills: ThresholdFilter
  deaths: ThresholdFilter
  csPerMin: ThresholdFilter
  goldDiff: ThresholdFilter
  summonerSpell: string
  keystone: string
  // Which multikill tiers to require (OR'd -- a video matches if it has any
  // of the selected tiers). Empty means no multikill filtering at all.
  multikillTiers: MultikillFilterType[]
  // Requires the multikill to have happened with no ally assisting on any
  // kill in the streak. Only meaningful once at least one tier is selected --
  // "solo" on its own doesn't identify a tier to check for soloness in, so
  // the UI disables this until a tier is picked (see FilterPanel below).
  multikillSolo: boolean
  // "Comeback": behind by at least leadSwingGoldThreshold at leadSwingMinute,
  // ahead by game end. "Throw": the reverse. Inactive (no matches excluded)
  // whenever leadSwingGoldThreshold is empty -- the minute/direction fields
  // are meaningless without a threshold to check, same "modifier needs a
  // primary field" relationship as multikillSolo/multikillTiers above.
  leadSwingDirection: 'comeback' | 'throw'
  leadSwingMinute: string
  leadSwingGoldThreshold: string
  winLoss: 'any' | 'win' | 'loss'
  role: string // '' = any, else one of ROLE_OPTIONS ids
  queueId: string // '' = any, else one of QUEUE_OPTIONS ids
  favoritesOnly: boolean
}

export const EMPTY_FILTERS: MatchFilters = {
  championsPlayed: [],
  achievementIds: [],
  enemyLaner: '',
  kills: { value: '', comparison: 'gte' },
  deaths: { value: '', comparison: 'gte' },
  csPerMin: { value: '', comparison: 'gte' },
  goldDiff: { value: '', comparison: 'gte' },
  summonerSpell: '',
  keystone: '',
  multikillTiers: [],
  multikillSolo: false,
  leadSwingDirection: 'comeback',
  leadSwingMinute: '15',
  leadSwingGoldThreshold: '',
  winLoss: 'any',
  role: '',
  queueId: '',
  favoritesOnly: false
}

const PRESETS_STORAGE_KEY = 'leaguevid:filterPresets'

export interface FilterPreset {
  name: string
  filters: MatchFilters
}

/**
 * Fills in fields a stored filter set predates.
 *
 * Presets are JSON in localStorage, so one saved before a filter existed
 * deserializes without that key -- and the array fields are read with `.length`
 * by both isFilterActive and the library's predicate, which would throw on
 * undefined. Merging over EMPTY_FILTERS means an old preset loads as "that
 * filter isn't set" rather than breaking the panel.
 */
export function normalizeFilters(raw: unknown): MatchFilters {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  // Copies known keys only rather than spreading. A preset saved by an older
  // build can carry a filter field that has since been renamed or removed, and
  // isFilterActive walks whatever keys it finds -- an unrecognised leftover
  // would read as an active filter, leaving "Clear" showing with nothing to
  // clear and no way to make it go away.
  const next: MatchFilters = { ...EMPTY_FILTERS }
  for (const key of Object.keys(EMPTY_FILTERS)) {
    if (key in stored) {
      ;(next as unknown as Record<string, unknown>)[key] = stored[key]
    }
  }

  const asArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  next.championsPlayed = asArray(stored.championsPlayed)
  next.multikillTiers = asArray(stored.multikillTiers).filter((t): t is MultikillFilterType =>
    (MULTIKILL_FILTER_TYPES as readonly string[]).includes(t)
  )
  // Achievement ids are dropped when the rule behind them no longer exists, so a
  // preset from an older build filters on what it still can rather than on an id
  // nothing will ever match.
  next.achievementIds = asArray(stored.achievementIds).filter((id) => ACHIEVEMENT_META.has(id))

  return next
}

function loadPresets(): FilterPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((p): p is FilterPreset => !!p && typeof p.name === 'string')
      .map((p) => ({ name: p.name, filters: normalizeFilters(p.filters) }))
  } catch {
    return []
  }
}

function savePresets(presets: FilterPreset[]): void {
  window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets))
}

interface FilterPanelProps {
  filters: MatchFilters
  onChange: (filters: MatchFilters) => void
  /**
   * Opens the browse-all achievement catalog, which doubles as a richer picker
   * for the achievement filter (tiers, descriptions, search) than a typeahead
   * in a narrow sidebar can be. Owned by the library, since the same catalog is
   * reachable from the page header.
   */
  onBrowseAchievements: () => void
}

const MULTIKILL_ICONS: Record<MultikillFilterType, string> = {
  doublekill: '\u2694\uFE0F',
  triplekill: '\uD83D\uDD25',
  quadrakill: '\u26A1',
  pentakill: '\uD83D\uDC51'
}

// Common summoner spells shown as quick-select icons (typed search would be
// overkill for a list this short, and icons make it instantly recognizable).
const COMMON_SPELL_IDS = [4, 21, 11, 14, 3, 6, 7, 12, 32, 13]

function ThresholdInput({
  label,
  value,
  onChange,
  step
}: {
  label: string
  value: ThresholdFilter
  onChange: (v: ThresholdFilter) => void
  step?: string
}): JSX.Element {
  return (
    <div className="filter-row">
      <label>{label}</label>
      <div className="filter-threshold">
        <select
          value={value.comparison}
          onChange={(e) => onChange({ ...value, comparison: e.target.value as 'gte' | 'lte' })}
        >
          <option value="gte">&ge; at least</option>
          <option value="lte">&le; at most</option>
        </select>
        <input
          type="number"
          min={0}
          step={step}
          placeholder="any"
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      </div>
    </div>
  )
}

/** True if any filter field would actually exclude something. */
export function isFilterActive(filters: MatchFilters): boolean {
  return Object.entries(filters).some(([key, v]) => {
    if (key === 'enemyLaner' || key === 'summonerSpell' || key === 'keystone' || key === 'role' || key === 'queueId') {
      return !!v
    }
    if (key === 'championsPlayed') return (v as string[]).length > 0
    if (key === 'achievementIds') return (v as string[]).length > 0
    if (key === 'multikillTiers') return (v as string[]).length > 0
    if (key === 'multikillSolo') return false // never "active" on its own, always paired with a tier
    if (key === 'leadSwingDirection' || key === 'leadSwingMinute') return false // paired with the threshold below
    if (key === 'leadSwingGoldThreshold') return !!v
    if (key === 'winLoss') return v !== 'any'
    if (key === 'favoritesOnly') return !!v
    return !!(v as ThresholdFilter).value
  })
}

function FilterPanel({ filters, onChange, onBrowseAchievements }: FilterPanelProps): JSX.Element {
  const ddragon = useDDragon()
  const hasActiveFilters = isFilterActive(filters)

  const champOptions = useMemo(() => (ddragon ? championOptions(ddragon) : []), [ddragon])
  const runeOpts = useMemo(() => (ddragon ? runeOptions(ddragon) : []), [ddragon])

  const [champPickerText, setChampPickerText] = useState('')
  const [achievementPickerText, setAchievementPickerText] = useState('')
  const [presets, setPresets] = useState<FilterPreset[]>(loadPresets)
  const [presetNameInput, setPresetNameInput] = useState('')
  const [showSavePreset, setShowSavePreset] = useState(false)

  function addChampion(championId: string): void {
    if (!championId || filters.championsPlayed.includes(championId)) {
      setChampPickerText('')
      return
    }
    onChange({ ...filters, championsPlayed: [...filters.championsPlayed, championId] })
    setChampPickerText('')
  }

  function removeChampion(championId: string): void {
    onChange({
      ...filters,
      championsPlayed: filters.championsPlayed.filter((c) => c !== championId)
    })
  }

  function addAchievement(achievementId: string): void {
    if (!achievementId || filters.achievementIds.includes(achievementId)) {
      setAchievementPickerText('')
      return
    }
    onChange({ ...filters, achievementIds: [...filters.achievementIds, achievementId] })
    setAchievementPickerText('')
  }

  function removeAchievement(achievementId: string): void {
    onChange({
      ...filters,
      achievementIds: filters.achievementIds.filter((a) => a !== achievementId)
    })
  }

  function handleSavePreset(): void {
    const name = presetNameInput.trim()
    if (!name) return
    const next = [...presets.filter((p) => p.name !== name), { name, filters }]
    setPresets(next)
    savePresets(next)
    setPresetNameInput('')
    setShowSavePreset(false)
  }

  function handleDeletePreset(name: string): void {
    const next = presets.filter((p) => p.name !== name)
    setPresets(next)
    savePresets(next)
  }

  return (
    <div className="filter-panel">
      <div className="filter-panel-header">
        <span>
          <Filter size={15} /> Filters
        </span>
        {hasActiveFilters && (
          <button className="link-button" onClick={() => onChange(EMPTY_FILTERS)}>
            <X size={13} /> Clear
          </button>
        )}
      </div>

      <div className="filter-panel-body">
        <div className="filter-row">
          <label>Result</label>
          <div className="filter-toggle-row">
            {(['any', 'win', 'loss'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                className={`filter-toggle-btn ${filters.winLoss === opt ? 'filter-toggle-btn--active' : ''}`}
                onClick={() => onChange({ ...filters, winLoss: opt })}
              >
                {opt === 'any' ? 'Any' : opt === 'win' ? 'Wins' : 'Losses'}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label>
            <button
              type="button"
              className={`filter-favorite-toggle ${filters.favoritesOnly ? 'filter-favorite-toggle--active' : ''}`}
              onClick={() => onChange({ ...filters, favoritesOnly: !filters.favoritesOnly })}
            >
              <Star size={14} fill={filters.favoritesOnly ? 'currentColor' : 'none'} /> Favorites only
            </button>
          </label>
        </div>

        <div className="filter-row">
          <label htmlFor="filter-champ-played">Champion(s) I played</label>
          <Autocomplete
            id="filter-champ-played"
            placeholder="Add a champion..."
            value={champPickerText}
            options={champOptions}
            onChange={(value) => addChampion(value)}
          />
          {filters.championsPlayed.length > 0 && (
            <div className="filter-chip-row">
              {filters.championsPlayed.map((champId) => (
                <span key={champId} className="filter-chip">
                  {ddragon ? championDisplayName(ddragon, champId) : champId}
                  <button
                    type="button"
                    className="filter-chip-remove"
                    onClick={() => removeChampion(champId)}
                    aria-label={`Remove ${champId}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Achievement filter. The typeahead is the quick path when you already
            know the name; the catalog button is the discoverable one, and the
            only place the tiers and descriptions have room to be shown. */}
        <div className="filter-row">
          <label htmlFor="filter-achievement">Achievements earned</label>
          <Autocomplete
            id="filter-achievement"
            placeholder="Add an achievement..."
            value={achievementPickerText}
            options={ACHIEVEMENT_OPTIONS}
            onChange={(value) => addAchievement(value)}
          />
          <button
            type="button"
            className="secondary filter-browse-achievements"
            onClick={onBrowseAchievements}
          >
            <Trophy size={14} /> Browse all achievements
          </button>
          {filters.achievementIds.length > 0 && (
            <div className="filter-chip-row">
              {filters.achievementIds.map((id) => {
                const meta = ACHIEVEMENT_META.get(id)
                return (
                  <span
                    key={id}
                    className={`filter-chip filter-chip--achievement filter-chip--${
                      meta?.category ?? 'positive'
                    } filter-chip--tier-${(meta?.tier ?? 'R').toLowerCase()}`}
                  >
                    {meta?.title ?? id}
                    <button
                      type="button"
                      className="filter-chip-remove"
                      onClick={() => removeAchievement(id)}
                      aria-label={`Remove ${meta?.title ?? id}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                )
              })}
            </div>
          )}
        </div>

        <div className="filter-row">
          <label>Role</label>
          <div className="filter-toggle-row">
            {ROLE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`filter-toggle-btn ${filters.role === opt.id ? 'filter-toggle-btn--active' : ''}`}
                onClick={() => onChange({ ...filters, role: filters.role === opt.id ? '' : opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label>Queue</label>
          <div className="filter-toggle-row">
            {QUEUE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`filter-toggle-btn ${filters.queueId === opt.id ? 'filter-toggle-btn--active' : ''}`}
                onClick={() =>
                  onChange({ ...filters, queueId: filters.queueId === opt.id ? '' : opt.id })
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          <label htmlFor="filter-enemy-laner">Enemy laner</label>
          <Autocomplete
            id="filter-enemy-laner"
            placeholder="e.g. Sion"
            value={filters.enemyLaner}
            displayValue={
              ddragon && filters.enemyLaner
                ? championDisplayName(ddragon, filters.enemyLaner)
                : undefined
            }
            options={champOptions}
            onChange={(value) => onChange({ ...filters, enemyLaner: value })}
          />
        </div>

        <div className="filter-row">
          <label htmlFor="filter-keystone">Keystone rune</label>
          <Autocomplete
            id="filter-keystone"
            placeholder="e.g. Grasp"
            value={filters.keystone}
            displayValue={
              ddragon && filters.keystone ? ddragon.runes[filters.keystone]?.name : undefined
            }
            options={runeOpts}
            onChange={(value) => onChange({ ...filters, keystone: value })}
          />
        </div>

        <ThresholdInput
          label="Kills"
          value={filters.kills}
          onChange={(v) => onChange({ ...filters, kills: v })}
        />
        <ThresholdInput
          label="Deaths"
          value={filters.deaths}
          onChange={(v) => onChange({ ...filters, deaths: v })}
        />
        {/* CS per minute rather than raw CS: total CS mostly reflects how
            long the game ran, so it's a poor thing to compare across games.
            Accepts decimals since a useful threshold is like 7.5. */}
        <ThresholdInput
          label="CS per minute"
          value={filters.csPerMin}
          onChange={(v) => onChange({ ...filters, csPerMin: v })}
          step="0.1"
        />
        <ThresholdInput
          label="Gold diff vs. laner"
          value={filters.goldDiff}
          onChange={(v) => onChange({ ...filters, goldDiff: v })}
        />

        <div className="filter-row">
          <label>Summoner spell</label>
          <div className="filter-spell-grid">
            {ddragon &&
              COMMON_SPELL_IDS.map((id) => {
                const url = summonerSpellIconUrl(ddragon, id)
                const active = filters.summonerSpell === String(id)
                return (
                  <button
                    key={id}
                    type="button"
                    className={`filter-spell-btn ${active ? 'filter-spell-btn--active' : ''}`}
                    onClick={() =>
                      onChange({ ...filters, summonerSpell: active ? '' : String(id) })
                    }
                    title={ddragon.summonerSpells[String(id)]?.name}
                  >
                    {url && <img src={url} alt="" />}
                  </button>
                )
              })}
          </div>
        </div>

        <div className="filter-row">
          <label>Multikills</label>
          <div className="filter-multikill-grid">
            {MULTIKILL_FILTER_TYPES.map((tier) => {
              const active = filters.multikillTiers.includes(tier)
              return (
                <button
                  key={tier}
                  type="button"
                  className={`filter-multikill-btn filter-multikill-btn--${tier} ${
                    active ? 'filter-multikill-btn--active' : ''
                  }`}
                  onClick={() => {
                    const nextTiers = active
                      ? filters.multikillTiers.filter((t) => t !== tier)
                      : [...filters.multikillTiers, tier]
                    onChange({
                      ...filters,
                      multikillTiers: nextTiers,
                      // Deselecting the last tier leaves "Solo" checking for
                      // nothing in particular, so it's cleared along with it.
                      multikillSolo: nextTiers.length === 0 ? false : filters.multikillSolo
                    })
                  }}
                  title={MULTIKILL_LABELS[MULTIKILL_FILTER_TYPES.indexOf(tier) + 2]}
                >
                  <span aria-hidden="true">{MULTIKILL_ICONS[tier]}</span>
                  {MULTIKILL_LABELS[MULTIKILL_FILTER_TYPES.indexOf(tier) + 2]}
                </button>
              )
            })}
            <button
              type="button"
              className={`filter-multikill-btn filter-multikill-btn--solo ${
                filters.multikillSolo ? 'filter-multikill-btn--active' : ''
              }`}
              disabled={filters.multikillTiers.length === 0}
              onClick={() => onChange({ ...filters, multikillSolo: !filters.multikillSolo })}
              title={
                filters.multikillTiers.length === 0
                  ? 'Select a multikill tier above first'
                  : 'Only multikills with no ally assisting on any kill in the streak'
              }
            >
              Solo
            </button>
          </div>
        </div>

        <div className="filter-row">
          <label>Lead swing vs. laner</label>
          <div className="filter-leadswing">
            <div className="filter-leadswing-direction">
              <button
                type="button"
                className={`filter-toggle-btn ${
                  filters.leadSwingDirection === 'comeback' ? 'filter-toggle-btn--active' : ''
                }`}
                onClick={() => onChange({ ...filters, leadSwingDirection: 'comeback' })}
                title="Behind at the chosen minute, ahead by the end of the game"
              >
                Comeback
              </button>
              <button
                type="button"
                className={`filter-toggle-btn ${
                  filters.leadSwingDirection === 'throw' ? 'filter-toggle-btn--active' : ''
                }`}
                onClick={() => onChange({ ...filters, leadSwingDirection: 'throw' })}
                title="Ahead at the chosen minute, behind by the end of the game"
              >
                Threw the lead
              </button>
            </div>
            <div className="filter-leadswing-fields">
              <div className="filter-leadswing-field">
                <span>at minute</span>
                <input
                  type="number"
                  min={1}
                  placeholder="15"
                  value={filters.leadSwingMinute}
                  onChange={(e) => onChange({ ...filters, leadSwingMinute: e.target.value })}
                />
              </div>
              <div className="filter-leadswing-field">
                <span>by at least</span>
                <input
                  type="number"
                  min={0}
                  placeholder="gold"
                  value={filters.leadSwingGoldThreshold}
                  onChange={(e) =>
                    onChange({ ...filters, leadSwingGoldThreshold: e.target.value })
                  }
                />
                <span>gold</span>
              </div>
            </div>
          </div>
        </div>

        <div className="filter-row filter-presets-row">
          <label>Saved filters</label>
          {presets.length > 0 && (
            <div className="filter-preset-list">
              {presets.map((preset) => (
                <span key={preset.name} className="filter-chip filter-chip--preset">
                  <button
                    type="button"
                    className="filter-preset-load-btn"
                    onClick={() => onChange(normalizeFilters(preset.filters))}
                    title={`Load "${preset.name}"`}
                  >
                    {preset.name}
                  </button>
                  <button
                    type="button"
                    className="filter-chip-remove"
                    onClick={() => handleDeletePreset(preset.name)}
                    aria-label={`Delete preset ${preset.name}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {showSavePreset ? (
            <div className="filter-preset-save-row">
              <input
                type="text"
                placeholder="Preset name"
                value={presetNameInput}
                onChange={(e) => setPresetNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSavePreset()
                  if (e.key === 'Escape') setShowSavePreset(false)
                }}
                autoFocus
              />
              <button type="button" onClick={handleSavePreset} disabled={!presetNameInput.trim()}>
                Save
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowSavePreset(false)
                  setPresetNameInput('')
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="secondary filter-preset-save-toggle"
              onClick={() => setShowSavePreset(true)}
              disabled={!hasActiveFilters}
              title={
                hasActiveFilters
                  ? 'Save the current filter combination for quick reuse'
                  : 'Set at least one filter first'
              }
            >
              Save current filters...
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default FilterPanel
