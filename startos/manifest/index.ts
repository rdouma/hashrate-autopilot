import { setupManifest } from '@start9labs/start-sdk'
import { appVersion } from '../utils'
import { short, long } from './i18n'

export const manifest = setupManifest({
  id: 'hashrate-autopilot-9',
  title: 'Hashrate-Autopilot-9',
  license: 'MIT',
  packageRepo: 'https://github.com/rdouma/hashrate-autopilot',
  upstreamRepo: 'https://github.com/rdouma/hashrate-autopilot',
  marketingUrl: 'https://github.com/rdouma/hashrate-autopilot',
  donationUrl: null,
  docsUrls: [
    'https://github.com/rdouma/hashrate-autopilot',
    'https://github.com/rdouma/hashrate-autopilot/blob/main/docs/configuration.md',
  ],
  description: { short, long },
  volumes: ['main'],
  images: {
    main: {
      source: {
        dockerBuild: {
          dockerfile: './Dockerfile',
          workdir: '.',
          buildArgs: {
            APP_VERSION: appVersion,
          },
        },
      },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: {
    install:
      'Hashrate Autopilot can place and edit live Braiins marketplace bids after you enable LIVE mode. Complete setup in DRY-RUN first and verify your pool destination before enabling LIVE mode.',
    update: null,
    uninstall:
      'Uninstalling deletes the StartOS data volume, including configuration, secrets, tick history, bid history, and alerts.',
    restore: null,
    start: null,
    stop: null,
  },
  dependencies: {
    bitcoin: {
      description:
        'Provides a local Bitcoin node for Datum Gateway and optional BIP 110 block-header checks.',
      optional: false,
      s9pk: null,
    },
    electrs: {
      description:
        'Provides Electrum lookups for Ocean payout tracking and historical payout backfill.',
      optional: false,
      s9pk: null,
    },
    datum: {
      description:
        'Receives rented hashrate and exposes Datum Gateway statistics for the dashboard.',
      optional: false,
      s9pk: null,
    },
  },
})
