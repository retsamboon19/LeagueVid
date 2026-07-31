import { memo, useMemo, useState } from 'react'
import type { MatchStats, StatsParticipant, TagRow } from '../../../../shared/types'
import {
  TIER_META,
  TIER_ORDER,
  buildMatchFacts,
  byTierThenPriority,
  dedupeEarnedByGroup,
  evaluateAchievements,
  selectFromEarned,
  type AchievementTier,
  type EarnedAchievement
} from '../../lib/achievements'
import { ESTIMATE_EXPLANATION, achievementIcon } from './achievementIcons'

interface AchievementsTabProps {
  stats: MatchStats
  focus: StatsParticipant
  /** Auto-tags for the linked video, used for tower-dive counts. */
  tags?: TagRow[]
}

// Two views of the same evaluation.
//
// Highlights is the trimmed set the panel has always shown -- six tiles, mixed
// good and bad, chosen to read as a summary of the game. That trimming is the
// point of it, but it also means a good game hides most of what it earned,
// which the second tab exists to show. Same rules, no cap, grouped by rarity.
type SubTab = 'highlights' | 'all'

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'highlights', label: 'Highlights' },
  { key: 'all', label: 'Everything earned' }
]

function TierBadge({ tier }: { tier: AchievementTier }): JSX.Element {
  return (
    <span
      className={`achv-tier achv-tier--${tier.toLowerCase()}`}
      title={TIER_META[tier].blurb}
      aria-label={`${TIER_META[tier].label} tier`}
    >
      {TIER_META[tier].label}
    </span>
  )
}

function AchievementRow({
  item,
  /** True when this one also made the trimmed Highlights set. */
  inHighlights
}: {
  item: EarnedAchievement
  inHighlights?: boolean
}): JSX.Element {
  const Icon = achievementIcon(item.icon)

  return (
    <li
      className={`achievement achievement--${item.category} achievement--tier-${item.tier.toLowerCase()} ${
        item.isFiller ? 'achievement--filler' : ''
      } ${inHighlights ? 'achievement--in-highlights' : ''}`}
    >
      <span className="achievement-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="achievement-text">
        <span className="achievement-title">
          {item.title}
          <TierBadge tier={item.tier} />
          {item.isEstimate && (
            <span className="gauge-estimate" title={ESTIMATE_EXPLANATION}>
              est.
            </span>
          )}
          {inHighlights && (
            <span className="achievement-flag" title="Also shown under Highlights">
              highlight
            </span>
          )}
        </span>
        <span className="achievement-desc">{item.description}</span>
      </div>
    </li>
  )
}

function AchievementsTab({ stats, focus, tags }: AchievementsTabProps): JSX.Element {
  const [subTab, setSubTab] = useState<SubTab>('highlights')

  // Evaluated once, read twice. Highlights is a trim of this same list rather
  // than a second run of the rule set (see selectFromEarned).
  const facts = useMemo(() => buildMatchFacts({ stats, focus, tags }), [stats, focus, tags])
  const earned = useMemo(() => evaluateAchievements(facts), [facts])
  const selection = useMemo(() => selectFromEarned(earned, facts), [earned, facts])

  const highlightIds = useMemo(
    () => new Set([...selection.positive, ...selection.negative].map((a) => a.id)),
    [selection]
  )

  // Group-suppressed even though nothing is capped here: a deathless game
  // satisfies Flawless, Survivor, Untouchable and Held On, and listing all four
  // is one fact restated four times, not four achievements.
  const allEarned = useMemo(() => dedupeEarnedByGroup(earned), [earned])

  // Rarity sections for the full list. Positives are grouped by tier so the
  // rare ones lead; negatives stay together under their own heading regardless
  // of tier -- a rare criticism is still a criticism, and filing it under a
  // rarity showcase would read as congratulating the player for it.
  const { positivesByTier, negatives } = useMemo(() => {
    const byTier = new Map<AchievementTier, EarnedAchievement[]>()
    const bad: EarnedAchievement[] = []

    for (const item of allEarned) {
      if (item.category === 'negative') {
        bad.push(item)
        continue
      }
      const bucket = byTier.get(item.tier)
      if (bucket) bucket.push(item)
      else byTier.set(item.tier, [item])
    }

    for (const bucket of byTier.values()) bucket.sort(byTierThenPriority)
    bad.sort(byTierThenPriority)

    return { positivesByTier: byTier, negatives: bad }
  }, [allEarned])

  const nothingEarned = selection.positive.length === 0 && selection.negative.length === 0

  return (
    <div className="stats-tab-body">
      <div className="insight-group-tabs" role="group" aria-label="Achievement view">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            className={`graph-metric-btn ${subTab === t.key ? 'graph-metric-btn--active' : ''}`}
            onClick={() => setSubTab(t.key)}
            aria-pressed={subTab === t.key}
          >
            {t.label}
            {t.key === 'all' && allEarned.length > 0 && (
              <span className="achv-tab-count">{allEarned.length}</span>
            )}
          </button>
        ))}
      </div>

      {subTab === 'highlights' ? (
        <>
          {nothingEarned && (
            <p className="subtitle">
              Nothing stood out either way in this game -- a steady, unremarkable one.
            </p>
          )}

          {selection.positive.length > 0 && (
            <section className="achievement-section">
              <h4 className="achievement-heading achievement-heading--good">Your achievements</h4>
              <ul className="achievement-list">
                {selection.positive.map((item) => (
                  <AchievementRow key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}

          {selection.negative.length > 0 && (
            <section className="achievement-section">
              <h4 className="achievement-heading achievement-heading--bad">Things to improve</h4>
              <ul className="achievement-list">
                {selection.negative.map((item) => (
                  <AchievementRow key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )}

          {/* Counts the same list the other tab renders, so the number here and
              the badge on the tab agree. */}
          {allEarned.length > selection.positive.length + selection.negative.length && (
            <p className="settings-row-hint">
              This game earned {allEarned.length} achievements in total. Switch to Everything earned
              to see the rest.
            </p>
          )}
        </>
      ) : (
        <>
          {allEarned.length === 0 ? (
            <p className="subtitle">This game didn&apos;t earn any achievements.</p>
          ) : (
            <>
              {TIER_ORDER.map((tier) => {
                const items = positivesByTier.get(tier)
                if (!items || items.length === 0) return null
                return (
                  <section
                    key={tier}
                    className={`achievement-section achievement-section--tier-${tier.toLowerCase()}`}
                  >
                    <h4 className="achievement-heading achievement-heading--tier">
                      <TierBadge tier={tier} />
                      <span>{TIER_META[tier].name}</span>
                      <span className="achievement-heading-count">{items.length}</span>
                    </h4>
                    <ul className="achievement-list">
                      {items.map((item) => (
                        <AchievementRow
                          key={item.id}
                          item={item}
                          inHighlights={highlightIds.has(item.id)}
                        />
                      ))}
                    </ul>
                  </section>
                )
              })}

              {negatives.length > 0 && (
                <section className="achievement-section">
                  <h4 className="achievement-heading achievement-heading--bad">
                    Things to improve
                    <span className="achievement-heading-count">{negatives.length}</span>
                  </h4>
                  <ul className="achievement-list">
                    {negatives.map((item) => (
                      <AchievementRow
                        key={item.id}
                        item={item}
                        inHighlights={highlightIds.has(item.id)}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      {!stats.hasTimeline && (
        <p className="settings-row-hint">
          Some achievements need the match timeline, which hasn&apos;t been downloaded for this game
          yet, so a few may be missing.
        </p>
      )}
    </div>
  )
}

export default memo(AchievementsTab)
