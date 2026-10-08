import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';
import { anthropicMessagesAttempt, anthropicMessagesGenerateTarget, canServeAnthropicMessagesCountTokens } from './attempt.ts';
import { renderAnthropicMessagesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import { createConversationRequest } from '../../shared/conversation-context.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { parseAnthropicBetaHeader, type AnthropicMessagesPayload, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface AnthropicMessagesServeGenerateArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface AnthropicMessagesServeCountTokensArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const anthropicMessagesServe = {
  generate: async (args: AnthropicMessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const anthropicBeta = parseAnthropicBetaHeader(headers.get('anthropic-beta'));
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeAnthropicMessagesAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => anthropicMessagesGenerateTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderAnthropicMessagesFailure(selection, 'generate');
    if (selection.candidates.length === 0) return renderAnthropicMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');

    // Try each affinity-selected candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim. Each attempt stamps its
    // private payload clone with the candidate's canonical model id.
    return await iterateCandidates(
      selection.candidates,
      'anthropicMessagesServe.generate',
      ctx,
      'chat',
      async (candidate, attemptCtx) => {
        const result = await anthropicMessagesAttempt.generate({ payload: selection.payloadFor(candidate), ctx: { ...ctx, abortSignal: attemptCtx.abortSignal }, candidate, headers, anthropicBeta });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
      {
        priorityFor: selection.priorityFor, errorFormat: 'anthropic',
        conversation: await createConversationRequest(ctx.conversationSecret, 'messages', payload, headers, 'generate', ctx.affinity.codec),
      },
    );
  },

  countTokens: async (args: AnthropicMessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, headers } = args;
    const anthropicBeta = parseAnthropicBetaHeader(headers.get('anthropic-beta'));
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeAnthropicMessagesAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(canServeAnthropicMessagesCountTokens);
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderAnthropicMessagesFailure(selection, 'countTokens');
    if (selection.candidates.length === 0) return renderAnthropicMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      selection.candidates,
      'anthropicMessagesServe.countTokens',
      ctx,
      'chat',
      (candidate, attemptCtx) => anthropicMessagesAttempt.countTokens({ payload: selection.payloadFor(candidate), ctx: { ...ctx, abortSignal: attemptCtx.abortSignal }, candidate, headers, anthropicBeta }),
      {
        priorityFor: selection.priorityFor, errorFormat: 'anthropic',
        conversation: await createConversationRequest(ctx.conversationSecret, 'messages', payload, headers, 'measure', ctx.affinity.codec),
      },
    );
  },
};
