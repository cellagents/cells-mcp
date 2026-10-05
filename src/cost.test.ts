import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Config } from './config.js';
import { clampBounds, clampDeclared, computeHonestEstimate } from './cost.js';
import { GameClient } from './gameClient.js';

const baseConfig: Config = {
  gameServer: { url: 'http://unused', adminToken: 'x' },
  mcp: { port: 0, path: '/mcp' },
  clamp: { honestMaxFloor: 0.001, lowerBoundFactor: -0.5, upperBoundFactor: 2.0 },
  modelTiers: { default: 1.0, 'claude-sonnet-4-6': 1.0, 'claude-opus-4-7': 2.5 },
  heartbeatFallback: { enabled: false, minDrainMultiplier: 1.0, staleAfterMs: 10000 }
};

function stubGame(intervalsMs: number[], promptTokens: number[]): GameClient {
  // Only properties cost.ts reads are populated; the GameClient constructor
  // opens a socket, so we bypass it with a bare object cast.
  return {
    toolCallIntervals: intervalsMs,
    promptTokensHistory: promptTokens
  } as unknown as GameClient;
}

test('clampDeclared returns value unchanged when within bounds', () => {
  const honest = 1.0;
  assert.equal(clampDeclared(1.5, honest, baseConfig), 1.5);
  assert.equal(clampDeclared(-0.3, honest, baseConfig), -0.3);
});

test('clampDeclared clamps when above the upper bound', () => {
  const honest = 1.0;
  assert.equal(clampDeclared(10, honest, baseConfig), 2.0);
});

test('clampDeclared clamps when below the lower bound', () => {
  const honest = 1.0;
  assert.equal(clampDeclared(-5, honest, baseConfig), -0.5);
});

test('clampBounds scales linearly with honestEstimate', () => {
  assert.deepEqual(clampBounds(2.0, baseConfig), { lower: -1.0, upper: 4.0 });
});

test('computeHonestEstimate returns floor-or-tier when no history', () => {
  const game = stubGame([], []);
  const est = computeHonestEstimate(game, baseConfig, 'claude-opus-4-7');
  assert.ok(est >= 2.5, `expected at least tier (2.5), got ${est}`);
});

test('computeHonestEstimate scales with tokens-per-second', () => {
  // 1000 tokens over 1 second (1000ms interval) with tier 1 → 10 (1000/100)
  const fast = stubGame([1000], [1000]);
  const slow = stubGame([5000], [1000]);
  const estFast = computeHonestEstimate(fast, baseConfig, 'claude-sonnet-4-6');
  const estSlow = computeHonestEstimate(slow, baseConfig, 'claude-sonnet-4-6');
  assert.ok(estFast > estSlow, `fast=${estFast} should exceed slow=${estSlow}`);
});
