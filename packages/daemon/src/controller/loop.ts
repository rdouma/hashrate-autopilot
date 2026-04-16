/**
 * setInterval-based tick driver with graceful shutdown.
 *
 * - Avoids overlapping ticks (if a tick runs long, the next tick waits).
 * - Surfaces per-tick errors to the logger without killing the loop.
 * - stop() flushes any in-flight tick before resolving, so shutdowns are
 *   clean.
 */

import type { Controller, TickResult } from './tick.js';

export interface LoopOptions {
  readonly controller: Controller;
  readonly intervalMs: number;
  readonly onTick: (result: TickResult) => void;
  readonly onError: (err: unknown) => void;
}

export class TickLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: LoopOptions) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce(); // immediate first tick
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already reported via onError
      }
    }
  }

  private async runOnce(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = (async () => {
      try {
        const result = await this.options.controller.tick();
        this.options.onTick(result);
      } catch (err) {
        this.options.onError(err);
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}
