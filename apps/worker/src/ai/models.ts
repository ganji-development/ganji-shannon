// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Model resolution for the pi harness.
 *
 * Anthropic providers use three tiers (small/medium/large) mapped to Claude models.
 * DeepSeek V4 uses 6 explicit operational modes defined per-agent:
 *   flash off, flash high, flash max, pro off, pro high, pro max
 *
 * Each agent's deepseekMode is declared in its AgentDefinition (session-manager.ts).
 * resolveModelSelection() reads the agent's mode directly — no tier-based env vars.
 *
 * Provider detection: DEEPSEEK_API_KEY → DeepSeek; CLAUDE_CODE_USE_BEDROCK → Bedrock;
 * ANTHROPIC_BASE_URL+ANTHROPIC_AUTH_TOKEN → custom base URL; else direct Anthropic.
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { AuthStorage, type ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { DeepSeekExecutionState } from '../types/agents.js';
import { AGENTS } from '../session-manager.js';

export type ModelTier = 'small' | 'medium' | 'large';

const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  small: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-6',
  large: 'claude-opus-4-8',
};


export interface EffectiveProvider {
  /** pi-ai provider id: 'anthropic' or 'amazon-bedrock'. */
  providerId: string;
  /** Custom-base-URL override applied to the resolved anthropic model. */
  baseUrl?: string;
  /** Runtime credential to prime on AuthStorage for the 'anthropic' provider. */
  anthropicToken?: string;
}

/**
 * Determine the active provider + auth from the env-var contract the CLI forwards:
 * `DEEPSEEK_API_KEY` → direct DeepSeek Anthropic-compatible endpoint;
 * `CLAUDE_CODE_USE_BEDROCK` → Bedrock; `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`
 * → custom base URL; else direct Anthropic (`ANTHROPIC_API_KEY`, or
 * `CLAUDE_CODE_OAUTH_TOKEN`).
 */
export function resolveEffectiveProvider(): EffectiveProvider {
  // DeepSeek API — direct Anthropic-compatible endpoint
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      providerId: 'anthropic',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic',
      anthropicToken: process.env.DEEPSEEK_API_KEY,
    };
  }

  // Bedrock — env flag.
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    return { providerId: 'amazon-bedrock' };
  }

  // Custom base URL — env contract.
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      providerId: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      anthropicToken: process.env.ANTHROPIC_AUTH_TOKEN,
    };
  }

  // Direct Anthropic (API key, or OAuth token).
  const eff: EffectiveProvider = { providerId: 'anthropic' };
  const token = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) eff.anthropicToken = token;
  return eff;
}

/** Resolve a model tier to a concrete model ID (env override → default). For Anthropic only. */
export function resolveModelId(tier: ModelTier = 'medium'): string {
  switch (tier) {
    case 'small':
      return process.env.ANTHROPIC_SMALL_MODEL || DEFAULT_MODELS.small;
    case 'large':
      return process.env.ANTHROPIC_LARGE_MODEL || DEFAULT_MODELS.large;
    default:
      return process.env.ANTHROPIC_MEDIUM_MODEL || DEFAULT_MODELS.medium;
  }
}

// DeepSeekExecutionState type is defined in types/agents.ts and imported above.

/** Parse any of the 6 explicit DeepSeek operational modes into concrete modelId and thinkingLevel. */
export function parseDeepSeekOperatingMode(mode: DeepSeekExecutionState | string): { modelId: string; thinkingLevel: ThinkingLevel } {
  const normalized = (typeof mode === 'string' ? mode : '').toLowerCase().trim();
  switch (normalized) {
    case 'flash off':
      return { modelId: 'deepseek-v4-flash', thinkingLevel: 'off' };
    case 'flash high':
      return { modelId: 'deepseek-v4-flash', thinkingLevel: 'high' as ThinkingLevel };
    case 'flash max':
      return { modelId: 'deepseek-v4-flash', thinkingLevel: 'max' as ThinkingLevel };
    case 'pro off':
      return { modelId: 'deepseek-v4-pro', thinkingLevel: 'off' };
    case 'pro high':
      return { modelId: 'deepseek-v4-pro', thinkingLevel: 'high' as ThinkingLevel };
    case 'pro max':
    default:
      return { modelId: 'deepseek-v4-pro', thinkingLevel: 'max' as ThinkingLevel };
  }
}

/** Whether a model supports adaptive thinking. Opus 4.6/4.7/4.8 and DeepSeek V4 models. */
export function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-[678]/.test(model) || /deepseek/i.test(model);
}

/**
 * Resolve thinking level for a given Anthropic model. DeepSeek thinking is resolved
 * directly via parseDeepSeekOperatingMode() from the agent's deepseekMode — not here.
 */
export function resolveThinkingLevel(modelId: string): ThinkingLevel {
  if (process.env.CLAUDE_ADAPTIVE_THINKING === 'false') return 'off';
  return supportsAdaptiveThinking(modelId) ? 'medium' : 'off';
}

export interface ModelSelection {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  authStorage: AuthStorage;
  modelId: string;
  providerId: string;
}

/**
 * Resolve the active provider (see resolveEffectiveProvider), prime an AuthStorage
 * with its credential, and resolve the tier's model from a fresh ModelRegistry.
 * Anthropic / custom-base-URL use a runtime anthropic key; Bedrock authenticates
 * from the AWS_ env vars (bearer token primed explicitly as a belt-and-suspenders).
 */
export function resolveModelSelection(
  registryFactory: (authStorage: AuthStorage) => ModelRegistry,
  modelTier: ModelTier,
  agentName?: string | null,
  isChildTask?: boolean,
): ModelSelection {
  const eff = resolveEffectiveProvider();
  const isDeepSeek = !!process.env.DEEPSEEK_API_KEY;

  let modelId: string;
  let thinkingLevel: ThinkingLevel;

  if (isDeepSeek) {
    if (isChildTask) {
      // Child task: default to flash max (fast + reasons), or agent override.
      const agentChildMode = agentName
        ? AGENTS[agentName as keyof typeof AGENTS]?.deepseekChildMode
        : undefined;
      const effectiveMode = agentChildMode ?? 'flash max';
      const parsed = parseDeepSeekOperatingMode(effectiveMode);
      modelId = parsed.modelId;
      thinkingLevel = parsed.thinkingLevel;
    } else {
      // Main task: resolve the agent's native 6-mode execution state.
      // Priority: agent definition → DEEPSEEK_MODE env override → default (pro max).
      const agentMode = agentName
        ? AGENTS[agentName as keyof typeof AGENTS]?.deepseekMode
        : undefined;
      const effectiveMode = agentMode
        ?? (process.env.DEEPSEEK_MODE as DeepSeekExecutionState | undefined)
        ?? 'pro max';
      const parsed = parseDeepSeekOperatingMode(effectiveMode);
      modelId = parsed.modelId;
      thinkingLevel = parsed.thinkingLevel;
    }
  } else {
    // Anthropic / Bedrock: standard tier-based resolution. Child tasks always use 'small'.
    const effectiveTier = isChildTask ? 'small' : modelTier;
    modelId = resolveModelId(effectiveTier);
    thinkingLevel = resolveThinkingLevel(modelId);
  }

  const authStorage = AuthStorage.inMemory();
  if (eff.providerId === 'anthropic' && eff.anthropicToken) {
    authStorage.setRuntimeApiKey('anthropic', eff.anthropicToken);
  }
  // Bedrock auth flows from the AWS_ env vars; prime the bearer token explicitly so
  // it resolves via AuthStorage in addition to pi-ai's own env fallback.
  if (eff.providerId === 'amazon-bedrock' && process.env.AWS_BEARER_TOKEN_BEDROCK) {
    authStorage.setRuntimeApiKey('amazon-bedrock', process.env.AWS_BEARER_TOKEN_BEDROCK);
  }

  const registry = registryFactory(authStorage);

  let model: Model<Api>;
  if (isDeepSeek) {
    // The pi registry only knows Anthropic model IDs. Use a known model as a structural
    // template, then override its id so DeepSeek's endpoint receives the right model name.
    const template = registry.find(eff.providerId, 'claude-haiku-4-5-20251001');
    if (!template) {
      throw new Error(`Model not found in pi registry: provider="${eff.providerId}" model="claude-haiku-4-5-20251001"`);
    }
    const withId = { ...template, id: modelId };
    model = eff.baseUrl ? { ...withId, baseUrl: eff.baseUrl } : withId;
  } else {
    const found = registry.find(eff.providerId, modelId);
    if (!found) {
      throw new Error(`Model not found in pi registry: provider="${eff.providerId}" model="${modelId}"`);
    }
    model = eff.baseUrl ? { ...found, baseUrl: eff.baseUrl } : found;
  }

  return {
    model,
    thinkingLevel,
    authStorage,
    modelId,
    providerId: eff.providerId,
  };
}

/**
 * Whether a model is in the Fable family. Fable's safety classifiers flag
 * cybersecurity tasks and route them to Opus 4.8, so a security scan on Fable
 * largely runs on Opus 4.8 anyway.
 */
export function isFableModel(model: string): boolean {
  return /fable/i.test(model);
}
