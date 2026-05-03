/**
 * Block-found audible cue (#88).
 *
 * Polls /api/reward-events on a 60s interval and rings the operator's
 * configured sound once when a new reward_events row appears. The
 * "newest seen" id is persisted in localStorage so a tab refresh
 * doesn't re-fire on previously-seen events. The first poll after
 * cold boot establishes a baseline silently rather than ringing for
 * the entire backlog.
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

const STORAGE_KEY = 'braiins.lastSeenRewardEventId';
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
  useEffect(() => {
    if (!choice || choice === 'off') {
      audioRef.current = null;
      return;
    }
    const url = blockFoundSoundUrl(choice);
    if (!url) {
      audioRef.current = null;
      return;
    }
    audioRef.current = new Audio(url);
    audioRef.current.preload = 'auto';
  }, [choice]);

  const enabled = !!choice && choice !== 'off';
  const query = useQuery({
    queryKey: ['reward-events'],
    queryFn: () => api.rewardEvents(50),
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    const events = query.data?.events;
    if (!events || events.length === 0) return;
    // Ascending by id - last is the newest.
    const newestId = events[events.length - 1]?.id ?? null;
    if (newestId === null) return;

    if (!firstPollDoneRef.current) {
      // Establish baseline silently. If localStorage already has a
      // higher id (rare - could happen if the user manually cleared
      // events server-side), fall through to fire on the next new id.
      const stored = getStoredMaxId();
      if (stored === null || newestId > stored) {
        setStoredMaxId(newestId);
      }
      firstPollDoneRef.current = true;
      return;
    }

    const stored = getStoredMaxId();
    if (stored === null) {
      // localStorage was cleared between polls - re-baseline.
      setStoredMaxId(newestId);
      return;
    }
    if (newestId > stored) {
      setStoredMaxId(newestId);
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
