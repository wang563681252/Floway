import { appendOpaqueTrailer, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, type OpaqueValueOrigin } from '@floway-dev/protocols/common';

interface CopilotItemIdDataV1 {
  version: 1;
  origin: OpaqueValueOrigin;
  id: string;
}

interface CopilotItemIdDataV2 {
  version: 2;
  origin: OpaqueValueOrigin;
  id: string;
  rawModelId: string;
}

type CopilotItemIdData = CopilotItemIdDataV1 | CopilotItemIdDataV2;

export type DecodedCopilotItemIdCarrier =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value: string } & CopilotItemIdData);

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const parseData = (value: unknown): CopilotItemIdData | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (record.origin !== 'raw' && record.origin !== 'base64' && record.origin !== 'base64url')
    || typeof record.id !== 'string'
    || record.id.length === 0
  ) return null;
  if (record.version === 1 && Object.keys(record).length === 3) {
    return { version: 1, origin: record.origin, id: record.id };
  }
  if (
    record.version === 2
    && Object.keys(record).length === 4
    && typeof record.rawModelId === 'string'
    && record.rawModelId.length > 0
  ) {
    return { version: 2, origin: record.origin, id: record.id, rawModelId: record.rawModelId };
  }
  return null;
};

export const wrapCopilotItemId = (value: string, id: string, rawModelId: string): string => {
  if (id.length === 0) throw new TypeError('Cannot carry an empty Copilot item id');
  if (rawModelId.length === 0) throw new TypeError('Cannot carry an empty Copilot raw model id');
  const original = decodeOpaqueValue(value);
  const metadata = textEncoder.encode(JSON.stringify({
    version: 2,
    origin: original.origin,
    id,
    rawModelId,
  } satisfies CopilotItemIdDataV2));
  if (metadata.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Copilot item id metadata exceeds the 2-byte length marker');
  return appendOpaqueTrailer(original, metadata);
};

export const unwrapCopilotItemId = (value: string): DecodedCopilotItemIdCarrier => {
  const framed = splitOpaqueTrailer(value);
  if (framed === null) return { kind: 'foreign', value };

  try {
    const data = parseData(JSON.parse(fatalTextDecoder.decode(framed.trailer)) as unknown);
    if (data === null) return { kind: 'foreign', value };
    return {
      kind: 'owned',
      value: encodeOpaqueValue(framed.original, data.origin),
      ...data,
    };
  } catch {
    return { kind: 'foreign', value };
  }
};
