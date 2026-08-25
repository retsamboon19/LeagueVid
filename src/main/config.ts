import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import dotenv from 'dotenv'
import { getRiotApiKeyOverride } from './db/repository'

declare const __LEAGUEVID_BUNDLED_RIOT_API_KEY__: string

// Load .env from the project root in dev, or alongside the packaged app in prod.
const envPath = app.isPackaged
  ? join(process.resourcesPath, '.env')
  : join(__dirname, '../../.env')

if (existsSync(envPath)) {
  dotenv.config({ path: envPath })
} else {
  dotenv.config()
}

export function getRiotApiKey(): string {
  // A key saved from the Settings screen (stored in the local DB) always
  // wins over .env -- that's what lets someone swap keys (e.g. upgrading
  // from a development key to a personal key) without editing files or
  // rebuilding the app.
  const override = getRiotApiKeyOverride()
  if (override) return override

  const key = process.env.RIOT_API_KEY
  if (key) return key

  const bundledKey = getBundledRiotApiKey()
  if (!bundledKey) {
    throw new Error(
      'No Riot API key set. Add one from Settings, or set RIOT_API_KEY in your .env file.'
    )
  }
  return bundledKey
}

/** Present only in an explicitly built private-beta installer. */
export function getBundledRiotApiKey(): string | null {
  const key = __LEAGUEVID_BUNDLED_RIOT_API_KEY__.trim()
  return key || null
}

function readVersion(): string {
  try {
    const pkgPath = app.isPackaged
      ? join(process.resourcesPath, 'app.asar', 'package.json')
      : join(__dirname, '../../package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const appVersion = readVersion()
