import express from 'express';

import { loadConfig } from './config.js';
import { createSession, destroySession, Session } from './session.js';

async function main() {
  const config = loadConfig();

  const sessions = new Map<string, Session>();
  const usedNicknames = new Set<string>();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  // MCP endpoint. The Streamable HTTP transport does session routing via the
  // `mcp-session-id` header; we create a new session on initial POST without
  // one, then dispatch to the matching transport on every subsequent request.
  app.all(config.mcp.path, async (req, res) => {
    const sessionId = (req.headers['mcp-session-id'] as string | undefined) || undefined;

    let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      session = createSession(config, usedNicknames);
      sessions.set(session.id, session);
      session.transport.onclose = () => {
        if (session) {
          destroySession(session, usedNicknames);
          sessions.delete(session.id);
        }
      };
    }

    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] handleRequest error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' });
      }
    }
  });

  const server = app.listen(config.mcp.port, () => {
    console.log(`[cellagents-mcp] listening on :${config.mcp.port}${config.mcp.path}`);
    console.log(`[cellagents-mcp] game server: ${config.gameServer.url}`);
  });

  const shutdown = () => {
    console.log('[cellagents-mcp] shutting down');
    for (const s of sessions.values()) destroySession(s, usedNicknames);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[cellagents-mcp] fatal:', err);
  process.exit(1);
});
