/**
 * #372: /api/status must carry the executed error for FAILED bid
 * mutations. Before this, `last_proposals` exposed only the outcome
 * enum, so the dashboard could render a bare orange FAILED badge and
 * nothing else - the operator had to reach into the decisions API to
 * find out that Braiins had blacklisted the target.
 *
 * The route itself needs a whole Fastify + repo harness to exercise;
 * the mapping function is the actual seam, so it gets a direct test.
 */
import { describe, expect, it } from 'vitest';

import { toProposalView } from './status.js';
import type { ExecutionResult, GateOutcome } from '../../controller/types.js';

const createProposal = {
  kind: 'CREATE_BID',
  price_sat: 1_000_000,
  speed_limit_ph: 1,
  amount_sat: 500_000,
  reason: 'target under-filled',
} as unknown as GateOutcome['proposal'];

const allowed: GateOutcome = {
  proposal: createProposal,
  allowed: true,
} as unknown as GateOutcome;

describe('toProposalView - executed error passthrough (#372)', () => {
  it('carries the raw error verbatim on a FAILED execution', () => {
    const err =
      'Braiins API POST /spot/bid returned 400 - Target not allowed (blacklisted until 2026-08-22T19:01:40 UTC)';
    const executed: ExecutionResult = {
      proposal: createProposal,
      outcome: 'FAILED',
      error: err,
    } as ExecutionResult;
    const view = toProposalView(allowed, executed);
    expect(view.executed).toBe('FAILED');
    expect(view.error).toBe(err);
  });

  it('is null for EXECUTED, DRY_RUN and BLOCKED outcomes', () => {
    const executedOk: ExecutionResult = {
      proposal: createProposal,
      outcome: 'EXECUTED',
      note: 'created B123',
    } as ExecutionResult;
    expect(toProposalView(allowed, executedOk).error).toBeNull();

    const dry: ExecutionResult = {
      proposal: createProposal,
      outcome: 'DRY_RUN',
      note: 'would create',
    } as ExecutionResult;
    expect(toProposalView(allowed, dry).error).toBeNull();

    const blocked: ExecutionResult = {
      proposal: createProposal,
      outcome: 'BLOCKED',
      reason: 'NOT_LIVE',
    } as unknown as ExecutionResult;
    expect(toProposalView(allowed, blocked).error).toBeNull();
  });

  it('is null when the proposal was never executed at all', () => {
    const gated: GateOutcome = {
      proposal: createProposal,
      allowed: false,
      reason: 'NOT_LIVE',
    } as unknown as GateOutcome;
    const view = toProposalView(gated, undefined);
    expect(view.executed).toBe('DRY_RUN');
    expect(view.error).toBeNull();
    expect(view.gate_reason).toBe('NOT_LIVE');
  });
});
