import { memo, useMemo } from 'react'
import {
  Award,
  Castle,
  Clock,
  Coins,
  Crosshair,
  Crown,
  Eye,
  EyeOff,
  Flame,
  Hammer,
  Heart,
  HeartPulse,
  Shield,
  Skull,
  Snowflake,
  Sparkles,
  Sunrise,
  Sword,
  Swords,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
  Wheat,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { MatchStats, StatsParticipant, TagRow } from '../../../../shared/types'
import { buildMatchFacts, selectAchievements, type EarnedAchievement } from '../../lib/achievements'

interface AchievementsTabProps {
  stats: MatchStats
  focus: StatsParticipant
  /** Auto-tags for the linked video, used for tower-dive counts. */
  tags?: TagRow[]
}

// Icon keys are strings in the rule definitions so that definitions.ts stays
// free of React imports. Resolution happens here.
const ICONS: Record<string, LucideIcon> = {
  award: Award,
  clock: Clock,
  coins: Coins,
  crosshair: Crosshair,
  crown: Crown,
  eye: Eye,
  'eye-off': EyeOff,
  flame: Flame,
  hammer: Hammer,
  heart: Heart,
  'heart-pulse': HeartPulse,
  shield: Shield,
  skull: Skull,
  snowflake: Snowflake,
  sparkles: Sparkles,
  sunrise: Sunrise,
  sword: Sword,
  swords: Swords,
  target: Target,
  tower: Castle,
  'trending-down': TrendingDown,
  'trending-up': TrendingUp,
  users: Users,
  wheat: Wheat,
  zap: Zap
}

const ESTIMATE_EXPLANATION =
  'LeagueVid works this out itself by grouping timeline kill events that happened close together in time and place. Riot does not provide this number, so treat it as an estimate.'

function AchievementRow({ item }: { item: EarnedAchievement }): JSX.Element {
  const Icon = ICONS[item.icon] ?? Trophy

  return (
    <li className={`achievement achievement--${item.category}`}>
      <span className="achievement-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="achievement-text">
        <span className="achievement-title">
          {item.title}
          {item.isEstimate && (
            <span className="gauge-estimate" title={ESTIMATE_EXPLANATION}>
              est.
            </span>
          )}
        </span>
        <span className="achievement-desc">{item.description}</span>
      </div>
    </li>
  )
}

function AchievementsTab({ stats, focus, tags }: AchievementsTabProps): JSX.Element {
  const selection = useMemo(
    () => selectAchievements(buildMatchFacts({ stats, focus, tags })),
    [stats, focus, tags]
  )

  const nothingEarned = selection.positive.length === 0 && selection.negative.length === 0

  return (
    <div className="stats-tab-body">
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
