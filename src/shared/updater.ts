export interface UpdateProgress {
  phase: 'downloading' | 'verifying' | 'launching'
  receivedBytes: number
  totalBytes: number | null
  fraction: number | null
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  sameVersionRefresh: boolean
  releaseName: string
  releaseNotes: string
  publishedAt: string
  installerSize: number
  releaseUrl: string
}

export interface UpdateInstallResult {
  success: boolean
  message: string
  finishedAt: string
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

export function updateIsAvailable(
  currentVersion: string,
  latestVersion: string,
  currentCommit: string,
  latestCommit: string
): { available: boolean; sameVersionRefresh: boolean } {
  const versionOrder = compareVersions(latestVersion, currentVersion)
  if (versionOrder > 0) return { available: true, sameVersionRefresh: false }
  if (versionOrder < 0) return { available: false, sameVersionRefresh: false }

  const refreshed = currentCommit !== 'development' && currentCommit !== latestCommit
  return { available: refreshed, sameVersionRefresh: refreshed }
}
