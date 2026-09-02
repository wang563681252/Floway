import { expect, test } from 'vitest';

import { unwrapCopilotItemId } from '../src/interceptors/openai-responses/item-id-carrier.ts';
import { copilotModelMatchesReplayTarget, upgradeCopilotOpenAIResponsesReplayCarrier } from '../src/replay-affinity.ts';
import { appendOpaqueTrailer, decodeOpaqueValue } from '@floway-dev/protocols/common';
import { stubProviderModel } from '@floway-dev/test-utils';

const model = stubProviderModel({
  id: 'gpt-5.6-sol',
  endpoints: { openaiResponses: {} },
  providerData: {
    rawModels: [
      { id: 'gpt-5.6-sol', supported_endpoints: ['/responses'] },
      { id: 'gpt-5.6-sol-fast', supported_endpoints: ['/responses'] },
    ],
  },
});

const legacyCarrier = (value: string, id: string): string => {
  const original = decodeOpaqueValue(value);
  return appendOpaqueTrailer(original, new TextEncoder().encode(JSON.stringify({
    version: 1,
    origin: original.origin,
    id,
  })));
};

test('recognizes a pre-merge fast public model as a replay target of its current family', () => {
  expect(copilotModelMatchesReplayTarget(model, 'gpt-5.6-sol')).toBe(true);
  expect(copilotModelMatchesReplayTarget(model, 'gpt-5.6-sol-fast')).toBe(true);
  expect(copilotModelMatchesReplayTarget(model, 'gpt-other-fast')).toBe(false);
});

test('upgrades a legacy replay carrier with the raw model named by its authenticated affinity', () => {
  const upgraded = upgradeCopilotOpenAIResponsesReplayCarrier(
    legacyCarrier('opaque reasoning', 'rs_upstream'),
    model,
    'gpt-5.6-sol-fast',
  );

  expect(unwrapCopilotItemId(upgraded)).toEqual({
    kind: 'owned',
    value: 'opaque reasoning',
    version: 2,
    origin: 'raw',
    id: 'rs_upstream',
    rawModelId: 'gpt-5.6-sol-fast',
  });
});

test('recognizes the dashed public spelling of a legacy Claude fast lane', () => {
  const claude = stubProviderModel({
    id: 'claude-opus-4-6',
    endpoints: { openaiResponses: {} },
    providerData: {
      rawModels: [
        { id: 'claude-opus-4.6', supported_endpoints: ['/responses'] },
        { id: 'claude-opus-4.6-fast', supported_endpoints: ['/responses'] },
      ],
    },
  });

  expect(copilotModelMatchesReplayTarget(claude, 'claude-opus-4-6-fast')).toBe(true);
});
