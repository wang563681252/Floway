// Post-handshake termination behavior of the userspace TLS adapter.
//
// These cases need a TLS session that is already established, which the
// fake duplex cannot produce against a real client. `@reclaimprotocol/tls`
// is therefore replaced with a stub whose handshake succeeds immediately
// and whose record callbacks the test drives by hand — that is the only way
// to control the exact interleaving of "plaintext arrived", "peer sent
// close_notify", and "the transport hung up" that this behavior turns on.
// The rest of the adapter's surface is covered against the real library in
// tls_test.ts.

import { describe, expect, it, vi } from 'vitest';

import { collectBody, makeFakeDuplex } from './test-utils.ts';
import { parseHttpResponse } from '../src/parser.ts';
import { userspaceTls } from '../src/tls.ts';

interface CapturedHooks {
  onApplicationData: (plaintext: Uint8Array) => void;
  onTlsEnd: (error?: unknown) => void;
}

const harness = vi.hoisted(() => ({
  hooks: null as CapturedHooks | null,
}));

vi.mock('@reclaimprotocol/tls', () => ({
  setCryptoImplementation: (): void => { /* the stub client does no crypto */ },
  makeTLSClient: (opts: {
    onHandshake: () => void;
    onApplicationData: (plaintext: Uint8Array) => void;
    onTlsEnd: (error?: unknown) => void;
  }) => {
    harness.hooks = {
      onApplicationData: opts.onApplicationData,
      onTlsEnd: opts.onTlsEnd,
    };
    return {
      startHandshake: (): Promise<void> => { opts.onHandshake(); return Promise.resolve(); },
      // Transport bytes are ignored: the test injects plaintext through
      // onApplicationData instead of encrypting real records.
      handleReceivedBytes: (): Promise<void> => Promise.resolve(),
      write: (): Promise<void> => Promise.resolve(),
      // Mirrors the real client, which forwards its argument to onTlsEnd
      // rather than tracking whether it already ended.
      end: (error?: unknown): Promise<void> => { opts.onTlsEnd(error); return Promise.resolve(); },
    };
  },
}));

vi.mock('@reclaimprotocol/tls/webcrypto', () => ({ webcryptoCrypto: {} }));

const enc = new TextEncoder();
const dec = new TextDecoder();

const connect = async (): Promise<{
  fake: ReturnType<typeof makeFakeDuplex>;
  plaintext: ReadableStream<Uint8Array>;
  hooks: CapturedHooks;
}> => {
  const fake = makeFakeDuplex();
  const tls = await userspaceTls(
    { readable: fake.readable, writable: fake.writable },
    { host: 'example.com' },
  );
  const hooks = harness.hooks;
  if (!hooks) throw new Error('TLS client stub did not capture its callbacks');
  return { fake, plaintext: tls.readable, hooks };
};

describe('userspaceTls — transport EOF without close_notify', () => {
  it('hands the consumer every decrypted byte before surfacing the truncation', async () => {
    // The read pump runs ahead of the consumer, so plaintext is normally
    // still buffered when the transport hangs up. Erroring the controller
    // straight away would run ResetQueue and silently drop it.
    const { fake, plaintext, hooks } = await connect();
    hooks.onApplicationData(enc.encode('first'));
    hooks.onApplicationData(enc.encode('second'));
    fake.endResponse();

    const reader = plaintext.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('first');
    expect(dec.decode((await reader.read()).value)).toBe('second');
    await expect(reader.read()).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'TLS_TRUNCATED',
    });
  });

  it('reports a cut-short chunked body as a truncation rather than a framing EOF', async () => {
    // RFC 8446 §6.1: without close_notify we cannot tell a complete
    // response from a censored one. Before this was surfaced, the chunked
    // decoder saw a clean end-of-stream and could only report the generic
    // "chunked: EOF in size".
    const { fake, plaintext, hooks } = await connect();
    hooks.onApplicationData(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'));
    hooks.onApplicationData(enc.encode('5\r\nhello\r\n'));
    fake.endResponse();

    const parsed = await parseHttpResponse(plaintext);
    await expect(collectBody(parsed)).rejects.toMatchObject({ code: 'TLS_TRUNCATED' });
  });

  it('still completes a response whose body finished before the rude close', async () => {
    // A peer that terminates the HTTP message properly and only then drops
    // the socket has delivered everything; the latched truncation must stay
    // behind the buffered bytes and never reach this consumer.
    const { fake, plaintext, hooks } = await connect();
    hooks.onApplicationData(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'));
    hooks.onApplicationData(enc.encode('5\r\nhello\r\n'));
    hooks.onApplicationData(enc.encode('0\r\n\r\n'));
    fake.endResponse();

    const parsed = await parseHttpResponse(plaintext);
    expect(await collectBody(parsed)).toBe('hello');
  });

  // The drain that holds a latched truncation behind undelivered plaintext is
  // the one part of this change that could turn a COMPLETE response into a
  // failure, and whether it does depends entirely on how record delivery
  // interleaves with consumer reads. A single hand-picked interleaving proves
  // little, so sweep the axes that decide the outcome: how finely the response
  // is split across onApplicationData calls, and whether the consumer is
  // already parked on a read or lagging behind. Every combination must yield
  // the whole body.
  describe('complete response followed by a rude close, across delivery interleavings', () => {
    const RESPONSE = [
      'HTTP/1.1 200 OK\r\n',
      'Transfer-Encoding: chunked\r\n',
      '\r\n',
      '5\r\nhello\r\n',
      '6\r\n world\r\n',
      '0\r\n\r\n',
    ].join('');

    const splitEvery = (s: string, size: number): string[] => {
      const out: string[] = [];
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
      return out;
    };

    // 1 exercises the worst case (one record per byte, so the terminating
    // chunk straddles many deliveries); RESPONSE.length delivers it whole.
    for (const size of [1, 2, 3, 7, 13, 32, RESPONSE.length]) {
      for (const eager of [true, false]) {
        it(`delivers the full body with ${size}-byte records and a ${eager ? 'parked' : 'lagging'} consumer`, async () => {
          const { fake, plaintext, hooks } = await connect();

          // eager: start reading before any bytes exist, so every delivery
          // lands on a parked read request.
          // lagging: let the whole response and the EOF land first, so the
          // truncation is latched while plaintext is still queued.
          const body = eager ? parseHttpResponse(plaintext) : null;

          for (const piece of splitEvery(RESPONSE, size)) {
            hooks.onApplicationData(enc.encode(piece));
            if (eager) await Promise.resolve();
          }
          fake.endResponse();

          const parsed = await (body ?? parseHttpResponse(plaintext));
          expect(await collectBody(parsed)).toBe('hello world');
        });
      }
    }
  });
});

describe('userspaceTls — peer close_notify', () => {
  it('ends the plaintext stream cleanly and ignores the transport EOF that follows', async () => {
    const { fake, plaintext, hooks } = await connect();
    hooks.onApplicationData(enc.encode('done'));
    // Peer's close_notify alert, which the real client turns into onTlsEnd
    // with no error, followed by the TCP FIN it rides on.
    hooks.onTlsEnd();
    fake.endResponse();

    const reader = plaintext.getReader();
    expect(dec.decode((await reader.read()).value)).toBe('done');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});
