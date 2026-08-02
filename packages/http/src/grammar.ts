// Shared HTTP/1.1 grammar primitives (RFC 9110 / RFC 9112).

import { HttpProtocolError } from './errors.ts';

// RFC 9110 §5.6.2: token = 1*tchar; tchar = "!" / "#" / "$" / "%" / "&" /
// "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
export const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Module-scope so we never allocate a fresh decoder per request/response.
export const ASCII_DECODER = new TextDecoder();

// RFC 9112 §5 forbids any non-ASCII byte in the header section. Reject
// ≥ 0x80 before decoding — TextDecoder fatal-UTF-8 alone would accept
// valid UTF-8 sequences like 0xc3 0xa9 ("é") that the spec forbids in
// the header section.
export const decodeAsciiHeaderSection = (bytes: Uint8Array, context: string): string => {
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i]! >= 0x80) {
      throw new HttpProtocolError(
        `non-ASCII byte 0x${bytes[i]!.toString(16).padStart(2, '0')} at offset ${i} in ${context}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
  }
  return ASCII_DECODER.decode(bytes);
};

// Serialize an assembled request head (request line + field lines +
// terminator) to the bytes that go on the wire.
//
// The head is a byte string, not Unicode text. Every runtime that hands us
// headers models a field value as a WebIDL ByteString (Fetch, "Headers"),
// so each JS code unit in the strings we assemble here already stands for
// exactly one wire byte in 0x00-0xFF — an inbound `é` reaches us as the
// single code unit U+00E9 because the byte on the wire was 0xE9. Encoding
// that head as UTF-8 would re-expand every code unit ≥ 0x80 into a
// multi-byte sequence, so the upstream would receive a value that is not
// the one the client sent (and a header section carrying bytes RFC 9112 §5
// forbids). Writing one byte per code unit — Latin-1 — is what keeps the
// serialization byte-faithful, and matches what the runtime's own fetch
// puts on the wire for the same header bag.
//
// A code unit above 0xFF cannot be a wire byte under any encoding, so it
// is a caller bug rather than something to silently mangle: UTF-8 would
// change the value's length and Latin-1 would truncate the high bits.
// Reject it here, mirroring `decodeAsciiHeaderSection` on the response
// side.
export const encodeHeadSectionBytes = (head: string, context: string): Uint8Array => {
  const out = new Uint8Array(head.length);
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c > 0xff) {
      throw new HttpProtocolError(
        `non-byte code point U+${c.toString(16).toUpperCase().padStart(4, '0')} at offset ${i} in ${context}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
    out[i] = c;
  }
  return out;
};

// RFC 9110 §5.6.3: OWS = *( SP / HTAB ). Strip from both ends of a
// field-value. Wrapped in a helper rather than exporting the bare
// `/g`-flag regex because a module-scope `/g` regex carries `lastIndex`
// and would become a footgun if anyone later switched to `.test`/`.exec`.
export const trimFieldValueOws = (value: string): string => value.replace(/^[\t ]+|[\t ]+$/g, '');

// RFC 9112 §4: status-line = HTTP-version SP status-code SP reason-phrase.
// The version group is non-capturing — no caller reads it — so capture
// indices are status=m[1], reason=m[2]. The reason alternation `(\S.*|)`
// permits an empty reason (RFC 7230 erratum 4087) while forbidding a
// leading SP, which would otherwise be silently absorbed from a double
// SP between code and reason.
export const STATUS_LINE = /^HTTP\/(?:1\.[01]) (\d{3}) (\S.*|)$/;

// RFC 9110 §5.5: field-content = field-vchar / SP / HTAB / obs-fold;
// field-vchar = VCHAR / obs-text. The legal byte set inside a value is
// HTAB (0x09), SP (0x20), VCHAR (0x21-0x7E), and obs-text (0x80-0xFF).
// Anything else — NUL and the rest of the C0 control set (0x01-0x08,
// 0x0B-0x1F; CR/LF call out the smuggling shape directly) plus DEL
// (0x7F) — violates the grammar. Each caller passes a builder so the
// error message stays caller-shaped while the byte set lives in one
// place.
export const validateFieldValueBytes = (
  value: string,
  makeError: (hex: string) => HttpProtocolError,
): void => {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw makeError(c.toString(16).padStart(2, '0'));
    }
  }
};

// RFC 9112 §3.2 request-target. We don't validate the full URI grammar
// — callers above us own that — but a CR/LF/SP/NUL/CTL/DEL byte would
// split the request line and smuggle a forged head past the header
// validators. The legal byte set is therefore VCHAR + obs-text
// (≥ 0x21, excluding DEL). Empty path is rejected up front; the field
// is mandatory.
export const validateRequestTargetBytes = (
  path: string,
  makeEmptyError: () => HttpProtocolError,
  makeByteError: (hex: string) => HttpProtocolError,
): void => {
  if (path.length === 0) {
    throw makeEmptyError();
  }
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x21 || c === 0x7f) {
      throw makeByteError(c.toString(16).padStart(2, '0'));
    }
  }
};
