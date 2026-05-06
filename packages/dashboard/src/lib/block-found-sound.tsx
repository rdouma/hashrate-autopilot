/**
 * Block-found audible cue (#88).
 *
 * Polls /api/ocean on a 60s interval and rings the operator's
 * configured sound once when a new pool block appears in
 * `recent_blocks[]`. Operator's stated intent: hear a cue every
 * time Ocean finds a block (3-ish per day at Ocean's typical
 * share), NOT when an on-chain payout to their address confirms
 * (which is what `reward_events` tracks - rare, and a wallet
 * already notifies on those).
 *
 * Tracking key is `height` (monotonically increasing across the
 * Bitcoin chain), persisted to localStorage so a tab refresh
 * doesn't re-fire on previously-seen blocks. The first poll after
 * cold boot establishes a baseline silently rather than ringing
 * for the entire backlog.
 *
 * Browser autoplay restrictions: modern browsers block sound played
 * before any user gesture on the page. The login click counts as
 * that gesture, so by the time this hook runs (post-auth) audio is
 * unlocked. We still .catch() the rejected promise quietly for the
 * occasional case where a tab is woken by a notification before any
 * gesture lands.
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, type AppConfig } from './api';

// Separate key from the legacy reward-event-id one - different
// units (block height vs reward event id) and different semantics
// (pool block found vs on-chain payout confirmed). Using a fresh
// key also re-baselines silently on first poll for existing
// operators upgrading past this commit.
const STORAGE_KEY = 'braiins.lastSeenOceanBlockHeight';
const POLL_INTERVAL_MS = 60_000;

/**
 * URL the dashboard's <audio> element should play for the operator's
 * current `block_found_sound` choice. Bundled choices live under
 * /sounds/<name>.mp3; 'custom' resolves to the daemon endpoint that
 * streams the uploaded blob.
 */
export function blockFoundSoundUrl(choice: AppConfig['block_found_sound']): string | null {
  switch (choice) {
    case 'off':
      return null;
    case 'custom':
      return '/api/config/block-found-sound';
    case 'cartoon-cowbell':
    case 'glass-drop-and-roll':
    case 'metallic-clank-1':
    case 'metallic-clank-2':
      return `/sounds/${choice}.mp3`;
  }
}

function getStoredMaxId(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function setStoredMaxId(id: number): void {
  window.localStorage.setItem(STORAGE_KEY, String(id));
}

/**
 * Mount once at the dashboard root. Reads the user's
 * block_found_sound choice from the supplied config and arms a
 * polling subscription. No UI - it just plays audio.
 */
export function useBlockFoundSound(choice: AppConfig['block_found_sound'] | undefined): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Track whether this is the first poll of the session so we
  // baseline silently instead of ringing for the entire backlog.
  const firstPollDoneRef = useRef(false);

  // Build / rebuild the Audio object whenever the choice changes.
  // Custom sounds live behind an auth-gated /api route; HTML5 <audio>
  // doesn't include Basic Auth, so we fetch via the authenticated
  // request path and hand the element a blob: URL. Bundled cues are
  // static under /sounds/* and don't need this dance.
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    if (!choice || choice === 'off') {
      audioRef.current = null;
      return;
    }
    if (choice === 'custom') {
      void api.blockFoundSoundBlobUrl().then((url) => {
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (!url) {
          audioRef.current = null;
          return;
        }
        objectUrl = url;
        audioRef.current = new Audio(url);
        audioRef.current.preload = 'auto';
      }).catch(() => {
        // Custom sound fetch failed (e.g. no blob on the daemon
        // yet). Silently fall through - audioRef stays null and
        // the play() guard later is a no-op.
        audioRef.current = null;
      });
    } else {
      const url = blockFoundSoundUrl(choice);
      if (!url) {
        audioRef.current = null;
        return;
      }
      audioRef.current = new Audio(url);
      audioRef.current.preload = 'auto';
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [choice]);

  const enabled = !!choice && choice !== 'off';
  const query = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    // Inherits the global refetchOnWindowFocus = true so the dashboard
    // catches up instantly when the operator returns to the tab.
    enabled,
  });

  // When the tab transitions hidden -> visible (operator returns
  // after a coffee break / laptop wake / browser unsuspend), reset
  // the "first poll" flag so the next data tick is treated as a
  // baseline and does NOT ring for blocks that landed while the tab
  // was away. The operator's "now I found a block" signal must not
  // become "here are all the blocks you missed yesterday."
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        firstPollDoneRef.current = false;
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const blocks = query.data?.recent_blocks;
    if (!blocks || blocks.length === 0) return;
    // Take the max height across the list rather than indexing by
    // position - Ocean returns recent blocks but the array order is
    // not contractually newest-first or newest-last; height is the
    // unambiguous monotonic key.
    let newestHeight: number | null = null;
    for (const b of blocks) {
      if (typeof b.height === 'number' && Number.isFinite(b.height)) {
        if (newestHeight === null || b.height > newestHeight) {
          newestHeight = b.height;
        }
      }
    }
    if (newestHeight === null) return;

    if (!firstPollDoneRef.current) {
      // Establish baseline silently so the operator does not get a
      // burst of sounds for the existing backlog on first load.
      const stored = getStoredMaxId();
      if (stored === null || newestHeight > stored) {
        setStoredMaxId(newestHeight);
      }
      firstPollDoneRef.current = true;
      return;
    }

    const stored = getStoredMaxId();
    if (stored === null) {
      // localStorage was cleared between polls - re-baseline.
      setStoredMaxId(newestHeight);
      return;
    }
    if (newestHeight > stored) {
      setStoredMaxId(newestHeight);
      const audio = audioRef.current;
      if (audio) {
        // Rewind in case the previous play() left it at the end.
        audio.currentTime = 0;
        audio.play().catch(() => {
          // Autoplay blocked (no user gesture yet on this tab).
          // Silently swallow - not worth logging on every blocked play.
        });
      }
    }
  }, [enabled, query.data]);
}
