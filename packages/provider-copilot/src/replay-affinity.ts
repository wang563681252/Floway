import { unwrapCopilotItemId, wrapCopilotItemId } from './interceptors/openai-responses/item-id-carrier.ts';
import { copilotPublicModelId } from './model-name.ts';
import { copilotVariantIndex } from './model-variants.ts';
import type { CopilotRawModel } from './types.ts';
import type { ProviderModel } from '@floway-dev/provider';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

const legacyReplayRawModel = (model: ProviderModel, targetModelId: string): CopilotRawModel | undefined => {
  const rawModels = (model.providerData as Partial<CopilotProviderData> | undefined)?.rawModels;
  if (!Array.isArray(rawModels)) return undefined;
  const index = copilotVariantIndex(rawModels);
  return rawModels.find(rawModel =>
    copilotPublicModelId(rawModel.id) === targetModelId
    && index.publicIdOf(rawModel.id) === model.id);
};

// Before Fast Mode became a service tier, Copilot exposed each accelerated raw
// lane as its own public model. Client-carried state from those releases still
// names that old public id, while the current catalog exposes only its merged
// family. Keep the compatibility decision in the provider that owns the raw
// catalog and suffix semantics.
// https://github.com/openai/codex/issues/32191
export const copilotModelMatchesReplayTarget = (model: ProviderModel, targetModelId: string): boolean =>
  model.id === targetModelId || legacyReplayRawModel(model, targetModelId) !== undefined;

export const upgradeCopilotOpenAIResponsesReplayCarrier = (
  value: string,
  model: ProviderModel,
  targetModelId: string,
): string => {
  const rawModel = legacyReplayRawModel(model, targetModelId);
  if (rawModel === undefined) return value;

  const decoded = unwrapCopilotItemId(value);
  if (decoded.kind === 'foreign') return value;
  if (decoded.version === 2) {
    if (decoded.rawModelId !== rawModel.id) {
      throw new TypeError('Copilot OpenAI Responses affinity conflicts with its carried raw model id');
    }
    return value;
  }
  return wrapCopilotItemId(decoded.value, decoded.id, rawModel.id);
};
