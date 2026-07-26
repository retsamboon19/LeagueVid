import { memo } from 'react'
import type { DDragonBundle, StatsParticipant } from '../../../../shared/types'
import { itemIconUrl, runeIconUrl } from '../../lib/useDDragon'
import { formatRuneVar, labelRuneVars, runeDisplayName } from '../../lib/runeLabels'
import { SKILL_SLOT_LABELS, formatGameClock } from './statsFormat'

interface BuildTabProps {
  participant: StatsParticipant
  hasTimeline: boolean
  ddragon: DDragonBundle | null
}

const MAX_CHAMP_LEVEL = 18

function RuneRow({
  perk,
  vars,
  ddragon
}: {
  perk: number
  vars: [number, number, number]
  ddragon: DDragonBundle | null
}): JSX.Element {
  const { mapped, entries } = labelRuneVars(perk, vars)
  const runeName = runeDisplayName(perk, ddragon?.runes[String(perk)]?.name) ?? `Rune ${perk}`
  const iconUrl = ddragon ? runeIconUrl(ddragon, perk) : null

  return (
    <div className="rune-row">
      <div className="rune-row-head">
        {iconUrl ? (
          <img className="rune-row-icon" src={iconUrl} alt="" />
        ) : (
          <div className="rune-row-icon rune-row-icon--placeholder" />
        )}
        <span className="rune-row-name">{runeName}</span>
      </div>

      {/* Three cases, deliberately distinct:
          - all values zero: this rune had no measurable effect, show nothing
          - mapped perk: show labelled values
          - unmapped perk: show the raw numbers, marked as unlabelled, rather
            than inventing a label that might be wrong */}
      {entries.length === 0 ? (
        <span className="rune-row-empty">No recorded effect</span>
      ) : (
        <div className="rune-row-vars">
          {entries.map((entry, i) => (
            <span key={i} className="rune-var">
              {entry.label ? (
                <>
                  <span className="rune-var-label">{entry.label}</span>{' '}
                  <span className="rune-var-value">{formatRuneVar(entry)}</span>
                </>
              ) : (
                <>
                  <span className="rune-var-value">{formatRuneVar(entry)}</span>{' '}
                  <span
                    className="rune-var-unlabeled"
                    title="Riot reports this number without saying what it measures, so LeagueVid shows it unlabelled rather than guessing."
                  >
                    unlabelled
                  </span>
                </>
              )}
            </span>
          ))}
          {!mapped && (
            <span
              className="rune-var-unlabeled"
              title="This rune isn't in LeagueVid's label map yet, so its values are shown raw."
            >
              (raw values)
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function SkillOrderGrid({ participant }: { participant: StatsParticipant }): JSX.Element {
  const byLevel = new Map(participant.skillOrder.map((s) => [s.level, s.skillSlot]))

  return (
    <div className="skill-order">
      {[1, 2, 3, 4].map((slot) => (
        <div key={slot} className="skill-order-row">
          <span className="skill-order-key">{SKILL_SLOT_LABELS[slot]}</span>
          <div className="skill-order-cells">
            {Array.from({ length: MAX_CHAMP_LEVEL }, (_, i) => {
              const level = i + 1
              const taken = byLevel.get(level) === slot
              return (
                <span
                  key={level}
                  className={`skill-order-cell ${taken ? 'skill-order-cell--taken' : ''}`}
                  title={taken ? `${SKILL_SLOT_LABELS[slot]} at level ${level}` : undefined}
                >
                  {taken ? level : ''}
                </span>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function BuildTab({ participant, hasTimeline, ddragon }: BuildTabProps): JSX.Element {
  const primary = participant.perks.filter((p) => p.isPrimaryTree)
  const secondary = participant.perks.filter((p) => !p.isPrimaryTree)

  return (
    <div className="stats-tab-body">
      <section className="stats-section">
        <h4 className="stats-section-title">Runes</h4>
        <div className="rune-trees">
          <div className="rune-tree">
            <span className="rune-tree-label">Primary</span>
            {primary.map((p, i) => (
              <RuneRow key={`${p.perk}-${i}`} perk={p.perk} vars={p.vars} ddragon={ddragon} />
            ))}
          </div>
          <div className="rune-tree">
            <span className="rune-tree-label">Secondary &amp; shards</span>
            {secondary.map((p, i) => (
              <RuneRow key={`${p.perk}-${i}`} perk={p.perk} vars={p.vars} ddragon={ddragon} />
            ))}
          </div>
        </div>
      </section>

      {!hasTimeline ? (
        <p className="subtitle">
          Skill order and item timings come from the match timeline, which hasn&apos;t been
          downloaded for this game yet. The background download will supply it.
        </p>
      ) : (
        <>
          <section className="stats-section">
            <h4 className="stats-section-title">Skill order</h4>
            {participant.skillOrder.length === 0 ? (
              <p className="subtitle">No skill level-ups recorded for this player.</p>
            ) : (
              <SkillOrderGrid participant={participant} />
            )}
          </section>

          <section className="stats-section">
            <h4 className="stats-section-title">Item build</h4>
            {participant.itemPurchases.length === 0 ? (
              <p className="subtitle">No item purchases recorded for this player.</p>
            ) : (
              <div className="item-build">
                {participant.itemPurchases.map((group, i) => (
                  <div key={i} className="item-build-group">
                    <div className="item-build-icons">
                      {group.itemIds.map((itemId, j) => {
                        const url = ddragon ? itemIconUrl(ddragon, itemId) : null
                        return (
                          <div key={j} className="item-build-slot">
                            {url && (
                              <img
                                src={url}
                                alt={ddragon?.items[String(itemId)]?.name ?? ''}
                                title={ddragon?.items[String(itemId)]?.name ?? undefined}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <span className="item-build-time">{formatGameClock(group.timestampMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default memo(BuildTab)
