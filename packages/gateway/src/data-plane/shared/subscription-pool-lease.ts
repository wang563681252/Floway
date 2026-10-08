import type { GatewayCtx } from './gateway-ctx.ts';
import type { SubscriptionPoolLease, SubscriptionPoolsRepo } from '../../repo/subscription-pools.ts';

export const SUBSCRIPTION_LEASE_MS = 120_000;
const RENEW_INTERVAL_MS = 30_000;

export class SubscriptionRequestLease {
  readonly signal: AbortSignal;
  readonly failure: Promise<never>;
  private readonly controller = new AbortController();
  private readonly reject: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;
  private readonly abort: () => void;

  constructor(
    private readonly repo: SubscriptionPoolsRepo,
    private readonly lease: SubscriptionPoolLease,
    private readonly ctx: Pick<GatewayCtx, 'abortSignal' | 'backgroundScheduler'>,
  ) {
    this.signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, this.controller.signal]) : this.controller.signal;
    let reject: (error: unknown) => void = () => { throw new Error('Subscription lease failure handler not initialized'); };
    this.failure = new Promise<never>((_resolve, fail) => { reject = fail; });
    this.reject = reject;
    void this.failure.catch(error => { console.error('[subscription-pool lease]', error); });
    this.abort = () => { ctx.backgroundScheduler(this.close()); };
    ctx.abortSignal?.addEventListener('abort', this.abort, { once: true });
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.repo.renew(this.lease.token, Date.now(), Date.now() + SUBSCRIPTION_LEASE_MS).then(renewed => {
        if (this.closing) return;
        if (!renewed) throw new Error('Subscription account lease expired while a request was active');
        this.schedule();
      }).catch(error => {
        if (this.closing) return;
        this.reject(error);
        this.controller.abort(error);
      });
    }, RENEW_INTERVAL_MS);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearTimeout(this.timer);
    this.ctx.abortSignal?.removeEventListener('abort', this.abort);
    this.closing = this.repo.release(this.lease.token);
    return this.closing;
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return await Promise.race([action(), this.failure]);
  }

  wrapEvents<T>(events: AsyncIterable<T>): AsyncIterable<T> {
    const owner = this;
    return {
      [Symbol.asyncIterator]() {
        const iterator = events[Symbol.asyncIterator]();
        let finished = false;
        const finish = async (failure?: unknown): Promise<void> => {
          if (finished) return;
          finished = true;
          try {
            try {
              await iterator.return?.();
            } finally {
              await owner.close();
            }
          } catch (cleanupError) {
            if (failure !== undefined) throw new AggregateError([failure, cleanupError], 'Subscription request and cleanup failed', { cause: failure });
            throw cleanupError;
          }
        };
        return {
          async next(): Promise<IteratorResult<T>> {
            if (finished) return { done: true, value: undefined };
            try {
              const next = await owner.execute(() => iterator.next());
              if (next.done) await finish();
              return next;
            } catch (error) {
              await finish(error);
              throw error;
            }
          },
          async return(): Promise<IteratorResult<T>> {
            await finish();
            return { done: true, value: undefined };
          },
          async throw(error: unknown): Promise<IteratorResult<T>> {
            await finish(error);
            throw error;
          },
        };
      },
    };
  }

  wrapResponse(response: Response): Response {
    if (response.body === null) throw new Error('Subscription response has no body to own its active lease');
    const reader = response.body.getReader();
    const owner = this;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await owner.execute(() => reader.read());
          if (next.done) {
            await owner.close();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          try {
            await reader.cancel(error);
            await owner.close();
          } catch (cleanupError) {
            controller.error(new AggregateError([error, cleanupError], 'Subscription response and cleanup failed', { cause: error }));
            return;
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await owner.close();
        }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
