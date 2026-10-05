import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { Config } from './config.js';
import { GameClient, TerminationReason } from './gameClient.js';
import { buildObservation } from './observe.js';

export interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  game: GameClient | null;
  world: { width: number; height: number } | null;
  nickname: string | null;
  /** Last time any MCP tool call (or raw MCP request) was observed for
   *  this session. The inactivity watchdog uses this. */
  lastCommandAt: number;
  /** Set when the game side terminated the player (kick, disconnect,
   *  or RIP). The MCP session itself stays alive; this is surfaced as a
   *  tool-result error on the next command that needs the game, and
   *  cleared the moment join_game creates a new GameClient. */
  lastGameTermination: TerminationReason | null;
}

/** Reasons the whole MCP session goes away. Only inactivity-driven and
 *  lifecycle-driven paths are here; game-side termination (kick, RIP,
 *  disconnect) is surfaced at the tool-result layer and does NOT tear
 *  down the MCP session. */
export type SessionDestroyReason =
  | 'inactivity'
  | 'explicit-close'
  | 'shutdown';

export function describeDestroyReason(reason: SessionDestroyReason): string {
  return reason;
}

function describeGameTermination(reason: TerminationReason): string {
  switch (reason.kind) {
    case 'kick':       return `game kicked player: ${reason.reason}`;
    case 'disconnect': return `game socket disconnected: ${reason.reason}`;
    case 'rip':        return 'player was eaten';
  }
}

export interface SessionLifecycle {
  /** Called when this session wants to be destroyed. Implementor is
   *  responsible for removing it from the active-sessions map and
   *  recording a tombstone. */
  onDestroy(session: Session, reason: SessionDestroyReason): void;
}

export function createSession(
  config: Config,
  usedNicknames: Set<string>,
  _lifecycle: SessionLifecycle
): Session {
  const sessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId
  });

  const server = new McpServer(
    { name: 'cellagents-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const session: Session = {
    id: sessionId,
    server,
    transport,
    game: null,
    world: null,
    nickname: null,
    lastCommandAt: Date.now(),
    lastGameTermination: null
  };

  const bump = () => { session.lastCommandAt = Date.now(); };

  const requireJoined = (): GameClient => {
    // Game-side termination is surfaced here as a tool-result error.
    // The MCP SDK wraps thrown errors into {isError:true, content:[...]}
    // without closing the MCP session, so the agent sees a tool error
    // and can call join_game on the same MCP session to respawn.
    if (session.lastGameTermination) {
      throw new Error(
        `game session ended (${describeGameTermination(session.lastGameTermination)}). ` +
        `Call join_game to start a new one; the MCP session itself is still open.`
      );
    }
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
      bump();
      if (session.game && !session.lastGameTermination) {
        // Still playing on this MCP session; disallow a second join.
        throw new Error('already joined; call stop or wait until the current game session ends');
      }
      // If the prior game ended, discard its remains before rejoining.
      if (session.game) {
        session.game.disconnect();
        session.game = null;
      }
      if (session.nickname) {
        usedNicknames.delete(session.nickname);
        session.nickname = null;
      }
      session.lastGameTermination = null;

      const resolved = resolveNicknameCollision(nickname, usedNicknames);
      usedNicknames.add(resolved);
      const game = new GameClient(
        config.gameServer.url,
        resolved,
        config.session.heartbeatHz
      );
      // Game-side termination (kick, raw disconnect after welcome, or
      // RIP) marks the Session's game as dead but leaves the MCP
      // session alive so the agent can call join_game again on the
      // same session-id. The destruction cascade to full MCP teardown
      // is reserved for inactivity (handled elsewhere).
      game.onTerminated((reason: TerminationReason) => {
        session.lastGameTermination = reason;
        session.game = null;
        if (session.nickname) {
          usedNicknames.delete(session.nickname);
          session.nickname = null;
        }
        console.log(`[session] game-side termination (${session.id}): ${describeGameTermination(reason)}`);
      });
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
      bump();
      const game = requireJoined();
      if (!game.snapshot || !session.world) {
        return { content: [{ type: 'text', text: JSON.stringify({ waiting: true }) }] };
      }
      const obs = buildObservation(game.snapshot, session.world);
      return { content: [{ type: 'text', text: JSON.stringify(obs) }] };
    }
  );

  server.registerTool(
    'move_to',
    {
      description: 'Head toward a specific point in world coordinates. The MCP keeps steering the cell toward (x, y) every tick, recomputing the direction from your current position, so the cell will arrive even if it crosses the map. When within arrival range the cell decelerates and stops. Call again to switch destinations; call set_heading or stop to override.',
      inputSchema: {
        x: z.number(),
        y: z.number()
      }
    },
    async (args) => {
      bump();
      const game = requireJoined();
      game.moveTo(args.x, args.y);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target: { x: args.x, y: args.y } }) }] };
    }
  );

  server.registerTool(
    'set_heading',
    {
      description: 'Steer the cell in a fixed direction indefinitely. The angle is in radians using the standard math convention: 0 = +x (right), π/2 = +y (down in screen space, since the world y-axis points down). The cell keeps moving in that direction tick after tick until it hits the arena edge or you call move_to, set_heading or stop again. Use this for persistent movement; use move_to when you want to reach a particular point.',
      inputSchema: {
        angle: z.number()
      }
    },
    async (args) => {
      bump();
      const game = requireJoined();
      game.setHeading(args.angle);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, angle: args.angle }) }] };
    }
  );

  server.registerTool(
    'stop',
    {
      description: 'Stop any active movement. The cell decelerates and halts in place. Any previous move_to or set_heading is cleared.',
      inputSchema: {}
    },
    async () => {
      bump();
      const game = requireJoined();
      game.stop();
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }
  );

  server.registerTool(
    'split',
    {
      description: 'Split the player cells (equivalent to pressing space in the default client).',
      inputSchema: {}
    },
    async () => {
      bump();
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
      bump();
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
