import { sdk } from './sdk'
import { appVersion, servicePort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: await sdk.SubContainer.of(
      effects,
      { imageId: 'main' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint: '/app/data',
        readonly: false,
      }),
      'hashrate-autopilot-sub',
    ),
    exec: {
      command: ['node', 'packages/daemon/dist/main.js'] as [string, ...string[]],
      env: {
        NODE_ENV: 'production',
        HTTP_HOST: '0.0.0.0',
        HTTP_PORT: String(servicePort),
        DB_PATH: '/app/data/state.db',
        DASHBOARD_STATIC: 'packages/dashboard/dist',
        APP_VERSION: appVersion,
        BHA_BITCOIND_RPC_URL: 'http://bitcoind.startos:8332',
        BHA_DATUM_API_URL: 'http://datum.startos:7152',
        BHA_ELECTRS_HOST: 'electrs.startos',
        BHA_ELECTRS_PORT: '50001',
        BHA_PAYOUT_SOURCE: 'electrs',
      },
    },
    ready: {
      display: 'Dashboard',
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, servicePort, {
          successMessage: 'Dashboard is ready',
          errorMessage: 'Dashboard is not responding',
        }),
    },
    requires: [],
  })
})
