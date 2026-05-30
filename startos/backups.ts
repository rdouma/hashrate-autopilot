import { sdk } from './sdk'

export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects: _effects }) => sdk.Backups.ofVolumes('main'),
)
