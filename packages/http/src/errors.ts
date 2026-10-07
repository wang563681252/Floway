// Errors raised when an HTTP/1.1 message, a WebSocket handshake, or a WebSocket
// frame is malformed, smuggling-shaped, or over a DoS cap, plus the one
// transport-shaped failure this package can detect on its own (a TLS record
// stream cut short without close_notify). Other transport errors propagate as
// the underlying error.

/**
 * Stable discriminator for an HttpProtocolError. Lets callers branch on
 * a class of failure (smuggling, header-shape, body-framing, DoS cap)
 * without parsing the human-readable `message`.
 */
export type HttpProtocolErrorCode =
  | 'BAD_STATUS_LINE'
  | 'BAD_HEADERS'
  | 'OBS_FOLD'
  | 'CL_AND_TE'
  | 'MULTIPLE_CL'
  | 'BAD_CL'
  | 'TE_NOT_CHUNKED'
  | 'TE_DOUBLE_CHUNKED'
  | 'CHUNK_BAD_SIZE'
  | 'CHUNK_TOO_LONG'
  | 'TRAILERS_TOO_LONG'
  | 'TOO_MANY_HEADERS'
  | 'HEADER_BUFFER_OVERFLOW'
  | 'UNSUPPORTED_CONTENT_ENCODING'
  | 'WS_MESSAGE_TOO_LARGE'
  | 'EOF'
  | 'TLS_TRUNCATED'
  | 'TRAILING_BODY_BYTES'
  | 'HEAD_REQUEST_REJECTED';

export class HttpProtocolError extends Error {
  override readonly name = 'HttpProtocolError';
  readonly code: HttpProtocolErrorCode;
  /** RFC reference whose grammar / framing rule the violation maps to. */
  readonly rfc?: string;

  constructor(message: string, code: HttpProtocolErrorCode, opts?: { cause?: unknown; rfc?: string }) {
    super(message, opts);
    this.code = code;
    this.rfc = opts?.rfc;
  }
}

/**
 * True for the transport-EOF-without-close_notify failure the userspace TLS
 * layer raises.
 *
 * The TLS layer reports the truncation; each framing layer above it decides
 * whether the truncation is observable to IT. Chunked and Content-Length
 * framing carry their own completion signal, so a cut record stream means a
 * demonstrably incomplete message and must surface. A body delimited by the
 * connection close (RFC 9112 §6.3) and a WebSocket frame boundary have no
 * such signal — they end at exactly the point the transport ends, whether or
 * not TLS got to say close_notify — so for them the truncation carries no
 * information and must not become a failure.
 */
export const isTlsTruncation = (err: unknown): boolean =>
  err instanceof HttpProtocolError && err.code === 'TLS_TRUNCATED';
