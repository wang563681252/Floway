import type { GatewayCtx } from './gateway-ctx.ts';
import { SubscriptionRequestLease } from './subscription-pool-lease.ts';
import { recordSubscriptionPoolOutcome, SubscriptionPoolSelection, type PoolIterationOptions } from './subscription-pool-selection.ts';
import { upstreamPerformanceContext } from './telemetry/attribution.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiErrorResult, ModelCandidate, PerformanceOperation } from '@floway-dev/provider';

// A serve-layer attempt result counts as success when:
//   - The SSE event stream actually opened (`type: 'events'`). Mid-stream
//     failure is the upstream's responsibility from there on; a fresh
//     attempt on a different upstream does not start once the client has
//     begun consuming events.
//   - The non-streaming envelope landed: `PlainResult` with a 2xx status,
//     or the OpenAI-Responses-compact `{type:'result'}` envelope.
// `api-error` and `internal-error` are failures: the serve loop falls
// through to the next candidate. 4xx is on the failure side — 429
// (rate-limit) is the responsibility of the upstream that issued it, and
// the gateway's candidate ordering exists to absorb that kind of
// transient. Passthrough serves feed in an enlarged `plain` shape that
// carries the raw upstream Response plus per-attempt telemetry alongside
// the status; the success discriminant is unchanged.
type IterableAttemptResult =
  | { readonly type: 'events'; events?: AsyncIterable<unknown> }
  | { readonly type: 'result' }
  | { readonly type: 'plain'; readonly status: number; response?: Response }
  | { readonly type: 'api-error'; readonly status?: number; readonly headers?: Headers; readonly source?: string }
  | { readonly type: 'internal-error' };

const isAttemptSuccess = (result: IterableAttemptResult): boolean => {
  switch (result.type) {
  case 'events':
  case 'result':
    return true;
  case 'plain':
    return result.status >= 200 && result.status < 300;
  case 'api-error':
  case 'internal-error':
    return false;
  }
};

// Tries each narrowed candidate in order and returns the first success. A
// per-candidate *failure result* falls through so a transient 5xx/429 on
// one upstream rolls over to the next; a thrown error leaves the loop and
// surfaces to the caller, so a dial failure does not advance. When the
// list is exhausted the most recent failure is returned so callers can
// forward it verbatim and clients still see real upstream telemetry rather
// than a synthetic gateway envelope. Callers are contractually required to
// hand in a non-empty candidate list — the empty-candidate branch renders
// each caller's own protocol-shaped "no viable candidate" envelope at the
// serve site.
//
// Owns per-attempt AttemptState: clears the two timing slots and stamps
// `ctx.attempt.telemetry` with the current candidate's
// `PerformanceTelemetryContext` synchronously BEFORE handing control to
// `run`. That way a mid-attempt throw (interceptor bug, translation
// error, provider-layer JS exception not represented as a ChatServeFailure)
// still attributes the perf error row to the throwing candidate: the
// outer catch reads `ctx.attempt.telemetry` and feeds it into
// `recordFailedRequest`. Callsites don't need to duplicate this stamp.
export const iterateCandidates = async <T extends IterableAttemptResult>(
  candidates: readonly ModelCandidate[],
  invocationLabel: string,
  ctx: GatewayCtx,
  operation: PerformanceOperation,
  run: (candidate: ModelCandidate, attemptCtx: GatewayCtx) => Promise<T>,
  options: PoolIterationOptions = {},
): Promise<T | ApiErrorResult> => {
  let lastFailure: T | undefined;
  let lastCredentialFailure: unknown;
  const quotaScope = options.quotaScope ?? operation;
  const selection = new SubscriptionPoolSelection(candidates, await getRepo().subscriptionPools.list(), { ...options, quotaScope });
  while (true) {
    const selected = await selection.next(ctx);
    if (!selected) break;
    const { candidate } = selected;
    ctx.attempt.timing.upstreamCallStartedAt = null;
    ctx.attempt.timing.firstOutputTokenAt = null;
    ctx.attempt.telemetry = upstreamPerformanceContext(ctx, candidate, operation);
    if (!selected.lease) {
      const result = await run(candidate, ctx);
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
      lastCredentialFailure = undefined;
      continue;
    }
    const lease = new SubscriptionRequestLease(getRepo().subscriptionPools, selected.lease, ctx);
    let heldByBody = false;
    let failure: unknown;
    try {
      const result = await lease.execute(() => run(candidate, { ...ctx, abortSignal: lease.signal }));
      if (isAttemptSuccess(result)) {
        await recordSubscriptionPoolOutcome(candidate, 200, undefined, quotaScope);
        if (result.type === 'events' && result.events) {
          result.events = lease.wrapEvents(result.events);
          heldByBody = true;
        } else if (result.type === 'plain' && result.response?.body) {
          result.response = lease.wrapResponse(result.response);
          heldByBody = true;
        }
        return result;
      }
      if (result.type === 'api-error' && result.source === 'upstream' && result.status !== undefined) {
        await recordSubscriptionPoolOutcome(candidate, result.status, result.headers, quotaScope);
      } else if (result.type === 'plain') {
        await recordSubscriptionPoolOutcome(candidate, result.status, result.response?.headers, quotaScope);
      }
      lastFailure = result;
      lastCredentialFailure = undefined;
    } catch (error) {
      failure = error;
      if (candidate.provider.isSubscriptionCredentialError?.(error) && !lease.signal.aborted) {
        console.warn('[subscription-pool] credential unavailable before response', candidate.provider.upstreamId);
        lastCredentialFailure = error;
        lastFailure = undefined;
      } else throw error;
    } finally {
      if (!heldByBody) {
        try {
          await lease.close();
        } catch (cleanupError) {
          if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Subscription attempt and cleanup failed', { cause: failure });
          throw cleanupError;
        }
      }
    }
  }
  if (lastFailure === undefined) {
    if (lastCredentialFailure !== undefined) throw lastCredentialFailure;
    if (candidates.length === 0) throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
    return selection.unavailable();
  }
  return lastFailure;
};
