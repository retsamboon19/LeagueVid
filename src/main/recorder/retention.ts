// Chooses which recordings a retention sweep would delete.
//
// This is the one genuinely destructive behaviour in the whole feature, so it is
// constrained three ways: off unless the user turns it on, scoped to files
// LeagueVid recorded itself and never marked as favourites, and previewable
// before anything happens.
//
// Pure on purpose. The preview and the sweep call this same function with the
// same inputs, which is what makes "the preview lists exactly what will be
// deleted" a property of the code rather than a promise -- two separate
// implementations agreeing today would drift tomorrow, and the cost of drift
// here is deleted footage.

export interface RetentionCandidate {
  videoId: number
  filePath: string
  fileName: string
  /** Bytes on disk. */
  sizeBytes: number
  /** When the game was played; falls back to when the row was created. */
  recordedAt: number
  isFavorite: boolean
  /** 'recorded' | 'imported' | null for rows predating the column. */
  source: string | null
}

export interface RetentionLimits {
  enabled: boolean
  /** Total size across all recordings, in GB. Null means no size limit. */
  maxGb: number | null
  /** Delete recordings older than this. Null means no age limit. */
  maxAgeDays: number | null
}

export interface RetentionPlan {
  /** Videos that would be deleted, oldest first. */
  toDelete: RetentionCandidate[]
  /** Videos kept, for the readout. */
  kept: RetentionCandidate[]
  totalBytes: number
  reclaimedBytes: number
  /** Why each deletion was chosen, keyed by videoId. */
  reasons: Record<number, string>
}

const BYTES_PER_GB = 1024 ** 3

/**
 * Files a sweep is allowed to consider at all.
 *
 * Two exclusions, both structural rather than incidental:
 *
 * - Anything not marked 'recorded'. A file the user imported is theirs; a
 *   retention rule they set for LeagueVid's own recordings must never reach it.
 *   A null source (a row written before the column existed) is treated as
 *   imported, which is the safe reading.
 * - Favourites. Marking something a favourite is the user saying "keep this",
 *   and no size limit outranks that.
 */
export function isEligibleForRetention(candidate: RetentionCandidate): boolean {
  if (candidate.source !== 'recorded') return false
  if (candidate.isFavorite) return false
  return true
}

/**
 * Builds the delete list.
 *
 * Age is applied first, then size, because they answer different questions: age
 * is "I don't care about old games", size is "don't use more than this much
 * disk". Applying size first could delete a recent recording while leaving an
 * old one the age rule would have removed anyway.
 *
 * Within the size pass, oldest goes first -- the most recent games are the ones
 * a person is most likely to still want.
 */
export function planRetention(
  candidates: RetentionCandidate[],
  limits: RetentionLimits,
  now = Date.now()
): RetentionPlan {
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0)

  const empty: RetentionPlan = {
    toDelete: [],
    kept: candidates,
    totalBytes,
    reclaimedBytes: 0,
    reasons: {}
  }

  // Disabled, or enabled with no limits set, deletes nothing. An enabled sweep
  // with no rules must not be read as "delete everything".
  if (!limits.enabled) return empty
  if (limits.maxGb == null && limits.maxAgeDays == null) return empty

  const eligible = candidates
    .filter(isEligibleForRetention)
    .sort((a, b) => a.recordedAt - b.recordedAt)

  const toDelete: RetentionCandidate[] = []
  const reasons: Record<number, string> = {}
  const deleted = new Set<number>()

  if (limits.maxAgeDays != null) {
    const cutoff = now - limits.maxAgeDays * 24 * 60 * 60 * 1000
    for (const candidate of eligible) {
      if (candidate.recordedAt >= cutoff) continue
      toDelete.push(candidate)
      deleted.add(candidate.videoId)
      const ageDays = Math.floor((now - candidate.recordedAt) / (24 * 60 * 60 * 1000))
      reasons[candidate.videoId] = `${ageDays} days old (limit ${limits.maxAgeDays})`
    }
  }

  if (limits.maxGb != null) {
    const limitBytes = limits.maxGb * BYTES_PER_GB
    // Only what survives the age pass counts toward the size budget.
    let remaining = eligible
      .filter((candidate) => !deleted.has(candidate.videoId))
      .reduce((sum, candidate) => sum + candidate.sizeBytes, 0)

    // Files the sweep may not touch still occupy the disk, so they count against
    // the budget. Ignoring them would let an untouchable library of favourites
    // sit above the limit while the sweep deleted everything it could reach and
    // still failed to get under it.
    remaining += candidates
      .filter((candidate) => !isEligibleForRetention(candidate))
      .reduce((sum, candidate) => sum + candidate.sizeBytes, 0)

    for (const candidate of eligible) {
      if (remaining <= limitBytes) break
      if (deleted.has(candidate.videoId)) continue

      toDelete.push(candidate)
      deleted.add(candidate.videoId)
      remaining -= candidate.sizeBytes
      reasons[candidate.videoId] = `over the ${limits.maxGb} GB limit`
    }
  }

  // Oldest first, so the preview reads in the order the sweep acts.
  toDelete.sort((a, b) => a.recordedAt - b.recordedAt)

  return {
    toDelete,
    kept: candidates.filter((candidate) => !deleted.has(candidate.videoId)),
    totalBytes,
    reclaimedBytes: toDelete.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    reasons
  }
}

export function formatRetentionSummary(plan: RetentionPlan): string {
  if (plan.toDelete.length === 0) {
    return 'Nothing would be deleted.'
  }
  const gb = plan.reclaimedBytes / BYTES_PER_GB
  const size = gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(plan.reclaimedBytes / 1024 ** 2)} MB`
  return `${plan.toDelete.length} recording(s) would be deleted, freeing ${size}.`
}
