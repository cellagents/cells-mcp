import type { Config } from './config.js';
import type { GameClient } from './gameClient.js';

export interface HeartbeatInput {
  cost: number;
  model: string;
  promptTokens: number;
}

export interface HeartbeatOutcome {
  applied_drain: number;
  honest_estimate: number;
  declared: number;
  clamp: { lower: number; upper: number };
  model_tier: number;
}

/**
 * Compute an honest cost estimate from observable quantities. This is the
 * server-side mirror of what a well-behaved harness should declare. The
 * formula is intentionally transparent and documented in EDU_PROJECT.md.
 *
 * honest_estimate = tier(model) × tokens_per_second
 * where tokens_per_second = mean(prompt_tokens_recent) / mean(interval_recent_sec)
 *
 * The result is a dimensionless multiplier that gets applied to the game
 * server's `massLossRate`. 1.0 means baseline drain, 2.0 means twice as fast.
 */
export function computeHonestEstimate(game: GameClient, config: Config, model: string): number {
  const tier = config.modelTiers[model] ?? config.modelTiers.default ?? 1;
  const intervals = game.toolCallIntervals;
  const promptTokens = game.promptTokensHistory;

  if (intervals.length === 0 || promptTokens.length === 0) {
    return Math.max(config.clamp.honestMaxFloor, tier);
  }

  const meanIntervalSec = mean(intervals) / 1000;
  const meanPromptTokens = mean(promptTokens);
  if (meanIntervalSec <= 0) return Math.max(config.clamp.honestMaxFloor, tier);

  const tokensPerSecond = meanPromptTokens / meanIntervalSec;
  const estimate = tier * (tokensPerSecond / 100); // 100 tokens/sec = tier
  return Math.max(config.clamp.honestMaxFloor, estimate);
}

export function clampDeclared(declared: number, honestEstimate: number, config: Config): number {
  const lower = config.clamp.lowerBoundFactor * honestEstimate;
  const upper = config.clamp.upperBoundFactor * honestEstimate;
  if (declared < lower) return lower;
  if (declared > upper) return upper;
  return declared;
}

export function clampBounds(honestEstimate: number, config: Config): { lower: number; upper: number } {
  return {
    lower: config.clamp.lowerBoundFactor * honestEstimate,
    upper: config.clamp.upperBoundFactor * honestEstimate
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
