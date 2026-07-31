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

// Icon keys are plain strings in the rule definitions so definitions.ts stays
// free of React imports (it's also loaded by the calibration scripts, which run
// under plain tsx with no renderer around). Resolution happens here, shared by
// the achievements panel and the browse-all catalog so a new icon key only
// needs registering once.

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

/** Component for an icon key, falling back to a trophy for unknown keys. */
export function achievementIcon(key: string): LucideIcon {
  return ICONS[key] ?? Trophy
}

export const ESTIMATE_EXPLANATION =
  'LeagueVid works this out itself by grouping timeline kill events that happened close together in time and place. Riot does not provide this number, so treat it as an estimate.'
