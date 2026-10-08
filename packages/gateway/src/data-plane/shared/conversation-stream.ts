import type { ConversationContext, ConversationRequest } from './conversation-context.ts';
import { getRepo } from '../../repo/index.ts';
import type { ConversationClaim } from '../../repo/subscription-conversations.ts';

export class ConversationTurn {
  private settled = false;
  private didDispatch = false;
  private readonly token: string;
  private closeOwner: (() => Promise<void>) | undefined;
  private closeCompletedOwner: (() => Promise<void>) | undefined;

  constructor(readonly claim: ConversationClaim, readonly request: ConversationRequest, private readonly modelKey: string) {
    if (claim.conversation.requestToken === null) throw new Error('Conversation claim has no request owner');
    this.token = claim.conversation.requestToken;
  }

  async dispatched(): Promise<void> {
    if (this.didDispatch) return;
    await getRepo().subscriptionConversations.dispatched(this.claim.conversation.id, this.token);
    this.didDispatch = true;
  }

  async completed(output: ConversationContext, replace = false): Promise<void> {
    if (this.settled) return;
    const entries = replace ? output.entries : [...this.request.context.entries, ...output.entries];
    await getRepo().subscriptionConversations.finish({
      id: this.claim.conversation.id, token: this.token, phase: 'completed',
      contextHash: await this.request.hash(entries), contextLength: entries.length,
      settingsHash: replace ? this.claim.conversation.settingsHash ?? this.request.settingsHash : this.request.settingsHash,
      modelKey: this.modelKey, portable: (replace || this.request.context.portable) && output.portable,
    });
    this.settled = true;
    await this.closeCompletedOwner?.();
  }

  async rejected(reason: string): Promise<void> {
    if (this.settled) return;
    await getRepo().subscriptionConversations.finish({
      id: this.claim.conversation.id, token: this.token, phase: 'rejected', reason,
    });
    this.settled = true;
  }

  async uncertain(): Promise<void> {
    if (this.settled) return;
    await getRepo().subscriptionConversations.finish({
      id: this.claim.conversation.id, token: this.token, phase: 'uncertain', reason: 'execution_uncertain',
    });
    this.settled = true;
  }

  async failed(): Promise<void> {
    if (this.didDispatch) await this.uncertain();
    else await this.rejected('pre_dispatch_failed');
  }

  attachOwner(close: () => Promise<void>, completed: () => Promise<void>): void {
    this.closeOwner = close;
    this.closeCompletedOwner = completed;
  }

  async cancelled(): Promise<void> {
    let failure: unknown;
    try { await this.failed(); } catch (error) { failure = error; }
    try { await this.closeOwner?.(); } catch (cleanupError) {
      if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Conversation cancellation and lease cleanup failed', { cause: failure });
      throw cleanupError;
    }
    if (failure !== undefined) throw failure;
  }
}

// A single-frame handoff feeds the existing protocol assembler without retaining
// a second copy of every delta in the request.
class FrameHandoff<T> implements AsyncIterable<T> {
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private ready: (() => void) | undefined;
  private closed = false;
  private consumed: (() => void) | undefined;

  get ended(): boolean { return this.closed; }

  async send(value: T): Promise<void> {
    if (this.closed) return;
    if (!this.waiting) await new Promise<void>(resolve => { this.ready = resolve; });
    if (this.closed) return;
    const waiting = this.waiting;
    this.waiting = undefined;
    if (!waiting) throw new Error('Conversation frame handoff lost its reader');
    const consumed = new Promise<void>(resolve => { this.consumed = resolve; });
    waiting({ done: false, value });
    await consumed;
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
    this.ready?.();
    this.ready = undefined;
    this.consumed?.();
    this.consumed = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        this.consumed?.();
        this.consumed = undefined;
        if (this.closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>(resolve => {
          this.waiting = resolve;
          this.ready?.();
          this.ready = undefined;
        });
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

export const observeConversationFrames = <T, R>(
  frames: AsyncIterable<T>,
  turn: ConversationTurn | undefined,
  collect: (frames: AsyncIterable<T>) => Promise<R>,
  normalize: (result: R) => ConversationContext | Promise<ConversationContext>,
  replace: (result: R) => boolean = () => false,
): AsyncIterable<T> => {
  if (!turn) return frames;
  return {
    [Symbol.asyncIterator]() {
      let started = false;
      const generator = (async function* () {
        started = true;
        const handoff = new FrameHandoff<T>();
        const assembled = collect(handoff).then(
          value => { handoff.close(); return { ok: true as const, value }; },
          error => { handoff.close(); return { ok: false as const, error }; },
        );
        let ended = false;
        let failure: unknown;
        try {
          for await (const frame of frames) {
            await handoff.send(frame);
            let terminalFailure: unknown;
            if (handoff.ended && !ended) {
              const result = await assembled;
              if (!result.ok) terminalFailure = result.error;
              else {
                try {
                  await turn.completed(await normalize(result.value), replace(result.value));
                  ended = true;
                } catch (error) { terminalFailure = error; }
              }
            }
            yield frame;
            if (terminalFailure !== undefined) throw terminalFailure;
          }
          handoff.close();
          const result = await assembled;
          if (!result.ok) throw result.error;
          if (!ended) await turn.completed(await normalize(result.value), replace(result.value));
          ended = true;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          handoff.close();
          if (!ended) {
            try { await turn.cancelled(); } catch (cleanupError) {
              if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Conversation stream and state persistence failed', { cause: failure });
              throw cleanupError;
            }
          }
        }
      })();
      return {
        next: () => generator.next(),
        return: async () => {
          if (!started) await turn.cancelled();
          return await generator.return();
        },
        throw: async (error: unknown) => {
          if (!started) {
            try { await turn.cancelled(); } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Conversation stream and cancellation failed', { cause: error });
            }
          }
          return await generator.throw(error);
        },
      };
    },
  };
};
