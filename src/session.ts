import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { Config } from './config.js';
import { GameClient } from './gameClient.js';
import { buildObservation } from './observe.js';

export interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  game: GameClient | null;
  world: { width: number; height: number } | null;
  nickname: string | null;
}

export function createSession(config: Config, usedNicknames: Set<string>): Session {
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
    nickname: null
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
      description: 'Join the game under a nickname. Must be called first. Returns the resolved player_id and the world dimensions. Nickname collisions are auto-resolved by appending an index.',
      inputSchema: { nickname: z.string().min(1).max(25) }
    },
    async ({ nickname }) => {
      if (session.game) {
        throw new Error('already joined');
      }
      const resolved = resolveNicknameCollision(nickname, usedNicknames);
      usedNicknames.add(resolved);
      const game = new GameClient(config.gameServer.url, resolved);
      try {
        const info = await game.awaitJoined();
        session.game = game;
        session.world = info.world;
        session.nickname = resolved;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ player_id: info.playerId, nickname: resolved, world: info.world })
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
      description: 'Return a compact JSON snapshot of what the player sees this tick: own cells, nearest threats and prey, nearest viruses, map edges, and a food hint.',
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
