import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { Config } from './config.js';
import { AdminClient } from './adminClient.js';
import { GameClient } from './gameClient.js';
import { buildObservation } from './observe.js';
import { clampBounds, clampDeclared, computeHonestEstimate } from './cost.js';

export interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  game: GameClient | null;
  world: { width: number; height: number } | null;
  nickname: string | null;
  joinToken: string | null;
}

/**
 * One MCP session wraps one game-server player. The McpServer and its
 * transport are allocated per-session so the SDK's session-id dispatch does
 * the routing for us, and tool handlers close over per-session state.
 */
export function createSession(config: Config, adminClient: AdminClient, usedNicknames: Set<string>): Session {
  const sessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  const server = new McpServer(
    { name: 'cellagents-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const session: Session = {
    id: sessionId,
    server,
    transport,
    game: null,
    world: null,
    nickname: null,
    joinToken: null
  };

  const requireJoined = (): GameClient => {
    if (!session.game) {
      throw new Error('join_game must be called before any other tool');
    }
    return session.game;
  };

  server.registerTool(
    'join_game',
    {
      description: 'Join the agar.io game under a nickname. Must be called first. Returns the resolved player_id and the world dimensions. Nickname collisions are auto-resolved by appending an index.',
      inputSchema: { nickname: z.string().min(1).max(25) }
    },
    async ({ nickname }) => {
      if (session.game) {
        throw new Error('already joined');
      }
      const resolved = resolveNicknameCollision(nickname, usedNicknames);
      usedNicknames.add(resolved);
      const joinToken = randomUUID();
      const game = new GameClient(config.gameServer.url, resolved, joinToken);
      try {
        const info = await game.awaitJoined();
        session.game = game;
        session.world = info.world;
        session.nickname = resolved;
        session.joinToken = joinToken;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ player_id: info.playerId, nickname: resolved, world: info.world, join_token: joinToken })
          }]
        };
      } catch (err) {
        usedNicknames.delete(resolved);
        game.disconnect();
        throw err;
      }
    }
  );

  server.registerTool(
    'observe',
    {
      description: 'Return a compact JSON snapshot of what the player sees this tick: own cells, nearest threats and prey, nearest viruses, map edges, and current round phase.',
      inputSchema: {}
    },
    async () => {
      const game = requireJoined();
      if (!game.snapshot || !session.world) {
        return { content: [{ type: 'text', text: JSON.stringify({ waiting: true }) }] };
      }
      const obs = buildObservation(game.snapshot, session.world);
      return { content: [{ type: 'text', text: JSON.stringify(obs) }] };
    }
  );

  server.registerTool(
    'set_heading',
    {
      description: 'Set the target point the player cell moves toward. Pass either {x,y} in world coordinates, or {angle} in radians (interpreted from current position).',
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        angle: z.number().optional()
      }
    },
    async (args) => {
      const game = requireJoined();
      const snapshot = game.snapshot;
      let target: { x: number; y: number };
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        target = { x: args.x, y: args.y };
      } else if (typeof args.angle === 'number' && snapshot) {
        const distance = 500;
        target = {
          x: snapshot.self.x + Math.cos(args.angle) * distance,
          y: snapshot.self.y + Math.sin(args.angle) * distance
        };
      } else {
        throw new Error('set_heading requires either {x,y} or {angle}; and {angle} requires a prior observe');
      }
      game.setHeading(target);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] };
    }
  );

  server.registerTool(
    'split',
    {
      description: 'Split the player cells (equivalent to pressing space in the default client).',
      inputSchema: {}
    },
    async () => {
      const game = requireJoined();
      game.split();
      const cells = game.snapshot?.self.cells.length ?? 0;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cells }) }] };
    }
  );

  server.registerTool(
    'eject',
    {
      description: 'Eject a piece of mass as food (equivalent to pressing W in the default client).',
      inputSchema: {}
    },
    async () => {
      const game = requireJoined();
      game.fireFood();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );

  server.registerTool(
    'heartbeat',
    {
      description: 'Declare the metabolic cost of the last tick. The client is expected to compute cost itself from its own model usage; the server clamps and applies it as a drain multiplier.',
      inputSchema: {
        cost: z.number(),
        model: z.string(),
        prompt_tokens: z.number().int().nonnegative()
      }
    },
    async ({ cost, model, prompt_tokens }) => {
      const game = requireJoined();
      game.recordHeartbeat(prompt_tokens);
      const honest = computeHonestEstimate(game, config, model);
      const applied = clampDeclared(cost, honest, config);
      const bounds = clampBounds(honest, config);
      try {
        await adminClient.setDrainMultiplier(game.playerId, applied);
      } catch (err) {
        console.warn('[heartbeat] drain apply failed:', (err as Error).message);
      }
      const tier = config.modelTiers[model] ?? config.modelTiers.default ?? 1;
      console.log(`[honest-vs-declared] player=${session.nickname} declared=${cost} honest=${honest.toFixed(3)} applied=${applied.toFixed(3)} model=${model}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, applied_drain: applied, honest_estimate: honest, declared: cost, clamp: bounds, model_tier: tier })
        }]
      };
    }
  );

  server.registerTool(
    'status',
    {
      description: 'Return the current round phase, remaining time (seconds, if in countdown), and the leaderboard top names.',
      inputSchema: {}
    },
    async () => {
      const game = requireJoined();
      const round = game.roundState ?? { phase: 'open', timeRemaining: null, endsAt: null, winner: null };
      const top = game.leaderboard.map(e => e.name);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ phase: round.phase, time_remaining: round.timeRemaining, winner: round.winner, leaderboard_top: top })
        }]
      };
    }
  );

  server.connect(transport).catch(err => {
    console.error('[session] mcp connect failed:', err);
  });

  return session;
}

function resolveNicknameCollision(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired}${n}`)) n++;
  return `${desired}${n}`;
}

export function destroySession(session: Session, usedNicknames: Set<string>): void {
  if (session.nickname) usedNicknames.delete(session.nickname);
  session.game?.disconnect();
  session.transport.close().catch(() => {});
  session.server.close().catch(() => {});
}
