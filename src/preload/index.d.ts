import { ElectronAPI } from '@electron-toolkit/preload'
import type { LeagueVidApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: LeagueVidApi
  }
}
