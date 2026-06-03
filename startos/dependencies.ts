import { sdk } from './sdk'

export const setDependencies = sdk.setupDependencies(async ({ effects: _effects }) => {
  return {
    bitcoind: {
      kind: 'running' as const,
      versionRange: '>=0.0.0',
      healthChecks: [],
    },
    electrs: {
      kind: 'running' as const,
      versionRange: '>=0.0.0',
      healthChecks: [],
    },
    datum: {
      kind: 'running' as const,
      versionRange: '>=0.0.0',
      healthChecks: [],
    },
  }
})
