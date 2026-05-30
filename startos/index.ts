import { buildManifest } from '@start9labs/start-sdk'
import { manifest as sdkManifest } from './manifest'
import { versionGraph } from './install/versionGraph'

export { createBackup } from './backups'
export { main } from './main'
export { init, uninit } from './init'

export const manifest = buildManifest(versionGraph, sdkManifest)
