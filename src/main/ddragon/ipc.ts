import { ipcMain } from 'electron'
import { getDDragonBundle } from './service'

export function registerDDragonHandlers(): void {
  ipcMain.handle('ddragon:getBundle', async () => {
    return getDDragonBundle()
  })
}
