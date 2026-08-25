import type { AppSettings } from '../../../shared/types'

// A missing row means this user profile has never completed account setup.
// An existing row -- even one with no accounts after the user removed them --
// is not first-run state and must not bring onboarding back after a reinstall.
export function shouldShowFirstRunOnboarding(settings: AppSettings | null): boolean {
  return settings === null
}
