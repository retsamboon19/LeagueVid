import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
import {
  ACHIEVEMENTS,
  TIER_META,
  TIER_ORDER,
  byTierThenPriority,
  tierForDefinition,
  type AchievementCategory,
  type AchievementTier
} from '../lib/achievements'
import { achievementIcon } from './stats/achievementIcons'

interface AchievementCatalogPopupProps {
  onClose: () => void
  /** Ids currently filtered on, so the list can show what's picked. */
  selectedIds: string[]
  /** Adds or removes an id from the recordings filter. */
  onToggle: (id: string) => void
  onClearSelection: () => void
  /**
   * How many of the user's recordings earned each achievement.
   *
   * Turns the list from a catalogue into something answerable: picking one shows
   * up front whether it will return anything, instead of silently filtering to
   * an empty list. Also the honest way to handle the achievements the library
   * can't evaluate -- they show no count rather than promising a match.
   */
  earnedCounts: Map<string, number>
  /** Linked recordings the counts were taken over. Zero means "nothing to count". */
  countedRecordings: number
  /** False while timeline/tag-backed results are still being filled in. */
  countsComplete: boolean
}

/** One catalog entry: everything the list needs, and nothing match-specific. */
interface CatalogEntry {
  id: string
  title: string
  hint: string
  category: AchievementCategory
  tier: AchievementTier
  priority: number
  icon: string
}

// Built once at module load rather than per open. The rule set is static data,
// so there is nothing here that could change between openings, and the sort is
// wasted work to repeat.
const CATALOG: CatalogEntry[] = ACHIEVEMENTS.map((def) => ({
  id: def.id,
  title: def.title,
  hint: def.hint,
  category: def.category,
  tier: tierForDefinition(def),
  priority: def.priority,
  icon: def.icon
})).sort(byTierThenPriority)

type CategoryFilter = 'all' | AchievementCategory

const CATEGORY_FILTERS: Array<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'positive', label: 'Achievements' },
  { key: 'negative', label: 'Things to improve' }
]

/**
 * The full list of achievements that exist, browsable before earning any.
 *
 * Descriptions here are deliberately vague (see AchievementDefinition.hint):
 * they say what each one recognises, never the number it takes. Publishing the
 * bars would turn the list into something to farm rather than something to
 * find, and the bars move whenever the rules are recalibrated anyway.
 *
 * Doubles as the picker for the recordings list's achievement filter, because
 * "what achievements are there" and "which one do I want to filter by" are the
 * same question asked twice.
 */
function AchievementCatalogPopup({
  onClose,
  selectedIds,
  onToggle,
  onClearSelection,
  earnedCounts,
  countedRecordings,
  countsComplete
}: AchievementCatalogPopupProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [tierFilter, setTierFilter] = useState<AchievementTier | 'all'>('all')

  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  // Focus goes to the search box on open and back where it came from on close.
  // aria-modal="true" is a promise that focus is actually confined to the
  // dialog; making that claim without moving focus leaves a screen reader user
  // tabbing through the page behind it.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    searchRef.current?.focus()
    return () => previouslyFocused?.focus?.()
  }, [])

  // Escape closes, Tab cycles within the dialog. Nothing else in the app traps
  // focus yet, but this is the first modal long enough that tabbing out of it by
  // accident loses your place in a seventy-item list.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return CATALOG.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false
      if (tierFilter !== 'all' && entry.tier !== tierFilter) return false
      if (!q) return true
      return entry.title.toLowerCase().includes(q) || entry.hint.toLowerCase().includes(q)
    })
  }, [query, category, tierFilter])

  const countsByTier = useMemo(() => {
    const counts = new Map<AchievementTier, number>()
    for (const entry of CATALOG) counts.set(entry.tier, (counts.get(entry.tier) ?? 0) + 1)
    return counts
  }, [])

  return (
    <div className="settings-panel-overlay" onClick={onClose}>
      <div
        className="achv-catalog-panel"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="All achievements"
      >
        <div className="settings-panel-header">
          <h3>All achievements</h3>
          <button className="link-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="subtitle achv-catalog-intro">
          Every achievement LeagueVid looks for, and roughly what each one is about. The exact bar
          is left out on purpose -- these are meant to be found in your own games, not farmed. Pick
          any of them to filter your recordings down to the games that earned it.
        </p>

        <div className="achv-catalog-controls">
          <div className="achv-catalog-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search achievements"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search achievements"
            />
            {query && (
              <button className="link-button" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="insight-group-tabs" role="group" aria-label="Category">
            {CATEGORY_FILTERS.map((c) => (
              <button
                key={c.key}
                className={`graph-metric-btn ${category === c.key ? 'graph-metric-btn--active' : ''}`}
                onClick={() => setCategory(c.key)}
                aria-pressed={category === c.key}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="insight-group-tabs" role="group" aria-label="Rarity">
            <button
              className={`graph-metric-btn ${tierFilter === 'all' ? 'graph-metric-btn--active' : ''}`}
              onClick={() => setTierFilter('all')}
              aria-pressed={tierFilter === 'all'}
            >
              All tiers
            </button>
            {TIER_ORDER.map((tier) => (
              <button
                key={tier}
                className={`graph-metric-btn achv-tier-btn achv-tier-btn--${tier.toLowerCase()} ${
                  tierFilter === tier ? 'graph-metric-btn--active' : ''
                }`}
                onClick={() => setTierFilter(tier)}
                aria-pressed={tierFilter === tier}
                title={TIER_META[tier].blurb}
              >
                {TIER_META[tier].label}
                <span className="achv-tab-count">{countsByTier.get(tier) ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="achv-catalog-body">
          {visible.length === 0 ? (
            <p className="subtitle">No achievements match that search.</p>
          ) : (
            TIER_ORDER.map((tier) => {
              const items = visible.filter((entry) => entry.tier === tier)
              if (items.length === 0) return null
              return (
                <section
                  key={tier}
                  className={`achv-catalog-section achv-catalog-section--${tier.toLowerCase()}`}
                >
                  <h4 className="achievement-heading achievement-heading--tier">
                    <span className={`achv-tier achv-tier--${tier.toLowerCase()}`}>
                      {TIER_META[tier].label}
                    </span>
                    <span>{TIER_META[tier].name}</span>
                    <span className="achievement-heading-count">{items.length}</span>
                  </h4>
                  <p className="achv-catalog-blurb">{TIER_META[tier].blurb}</p>

                  <ul className="achv-catalog-list">
                    {items.map((entry) => {
                      const Icon = achievementIcon(entry.icon)
                      const isSelected = selected.has(entry.id)
                      const count = earnedCounts.get(entry.id) ?? 0
                      return (
                        <li key={entry.id}>
                          <button
                            className={`achv-catalog-card achv-catalog-card--${entry.category} achv-catalog-card--tier-${tier.toLowerCase()} ${
                              isSelected ? 'achv-catalog-card--selected' : ''
                            } ${countsComplete && count === 0 ? 'achv-catalog-card--unearned' : ''}`}
                            onClick={() => onToggle(entry.id)}
                            aria-pressed={isSelected}
                            title={
                              isSelected
                                ? 'Remove from the recordings filter'
                                : 'Filter recordings to games that earned this'
                            }
                          >
                            <span className="achievement-icon" aria-hidden="true">
                              <Icon size={18} />
                            </span>
                            <span className="achv-catalog-card-text">
                              <span className="achievement-title">
                                {entry.title}
                                {(countedRecordings > 0 || !countsComplete) && (
                                  <span
                                    className={`achv-catalog-count ${
                                      countsComplete && count === 0
                                        ? 'achv-catalog-count--zero'
                                        : ''
                                    }`}
                                  >
                                    {!countsComplete
                                      ? 'checking...'
                                      : count === 0
                                      ? 'none yet'
                                      : `${count} recording${count === 1 ? '' : 's'}`}
                                  </span>
                                )}
                              </span>
                              <span className="achievement-desc">{entry.hint}</span>
                            </span>
                            <span className="achv-catalog-card-check" aria-hidden="true">
                              {isSelected && <Check size={14} />}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })
          )}
        </div>

        {!countsComplete ? (
          <p className="achv-catalog-blurb achv-catalog-note">
            Checking the full match details for timeline and bookmark-based achievements. Counts
            and filters update as soon as that finishes.
          </p>
        ) : countedRecordings > 0 ? (
          <p className="achv-catalog-blurb achv-catalog-note">
            Counts come from the {countedRecordings} linked recording
            {countedRecordings === 1 ? '' : 's'} in your library, using the same full match details
            as each recording&apos;s Achievements tab.
          </p>
        ) : null}

        <div className="settings-panel-footer achv-catalog-footer">
          <span className="subtitle">
            {selectedIds.length > 0
              ? `${selectedIds.length} picked for the recordings filter`
              : `${CATALOG.length} achievements in total`}
          </span>
          <div className="achv-catalog-footer-actions">
            {selectedIds.length > 0 && (
              <button className="secondary" onClick={onClearSelection}>
                Clear picks
              </button>
            )}
            <button onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default AchievementCatalogPopup
