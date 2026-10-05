import express from 'express';

import { loadConfig } from './config.js';
import {
  createSession,
  destroySession,
  describeDestroyReason,
  Session,
  SessionDestroyReason,
  SessionLifecycle
} from './session.js';

interface Tombstone {
  reason: SessionDestroyReason;
  destroyedAt: number;
}

const TOMBSTONE_TTL_MS = 10 * 60 * 1000; // 10 min
const WATCHDOG_INTERVAL_MS = 5000;        // scan every 5 s

async function main() {
  const config = loadConfig();

  const sessions = new Map<string, Session>();
  const tombstones = new Map<string, Tombstone>();
  const usedNicknames = new Set<string>();

  const teardown = (session: Session, reason: SessionDestroyReason): void => {
    if (!sessions.has(session.id)) return; // already gone
    sessions.delete(session.id);
    tombstones.set(session.id, { reason, destroyedAt: Date.now() });
    destroySession(session, usedNicknames);
    console.log(`[session] destroyed ${session.id}: ${describeDestroyReason(reason)}`);
  };

  const lifecycle: SessionLifecycle = {
    onDestroy: (session, reason) => teardown(session, reason)
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: sessions.size, tombstones: tombstones.size });
  });

  // MCP endpoint. The Streamable HTTP transport does session routing via the
  // `mcp-session-id` header; we create a new session on initial POST without
  // one, then dispatch to the matching transport on every subsequent request.
  // If the sessionId was torn down (inactivity, game kick, RIP), reply with
  // a terminal error so the harness knows to call join_game again instead
  // of silently getting rerouted to a brand-new blank session.
  app.all(config.mcp.path, async (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) || undefined;

    if (sessionId) {
      const grave = tombstones.get(sessionId);
      if (grave) {
        res.status(410).json({
          error: 'session_terminated',
          detail: describeDestroyReason(grave.reason),
          hint: 'call join_game to resume'
        });
        return;
      }
    }

    let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      session = createSession(config, usedNicknames, lifecycle);
      sessions.set(session.id, session);
      session.transport.onclose = () => {
        if (session && sessions.has(session.id)) {
          teardown(session, 'explicit-close');
        }
      };
    }

    // Any request against a live session counts as proof the harness is
    // still driving it; refresh the inactivity timer. Does not require
    // the request to successfully dispatch a tool.
    session.lastCommandAt = Date.now();

    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] handleRequest error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' });
      }
    }
  });

  // Watchdog: reap inactive sessions, GC old tombstones. Runs on a cheap
  // interval; everything is in-memory so no I/O cost.
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (now - s.lastCommandAt > config.session.sessionTimeoutMs) {
        teardown(s, 'inactivity');
      }
    }
    for (const [id, t] of tombstones) {
      if (now - t.destroyedAt > TOMBSTONE_TTL_MS) {
        tombstones.delete(id);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  const server = app.listen(config.mcp.port, () => {
    console.log(`[cellagents-mcp] listening on :${config.mcp.port}${config.mcp.path}`);
    console.log(`[cellagents-mcp] game server: ${config.gameServer.url}`);
    console.log(`[cellagents-mcp] heartbeat ${config.session.heartbeatHz} Hz, inactivity timeout ${config.session.sessionTimeoutMs} ms`);
  });

  const shutdown = () => {
    console.log('[cellagents-mcp] shutting down');
    clearInterval(watchdog);
    for (const s of Array.from(sessions.values())) teardown(s, 'shutdown');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[cellagents-mcp] fatal:', err);
  process.exit(1);
});
