import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  gameServer: { url: string };
  mcp: { port: number; path: string };
  session: {
    /** Frequency at which the MCP keeps the game socket alive by
     *  re-emitting the last known heading. 1 Hz is well below the game
     *  server's default 5 s idle-kick threshold. */
    heartbeatHz: number;
    /** How long an MCP session can go without any tool call from the
     *  harness before it is reaped. Game-side termination (kick,
     *  disconnect, RIP) also tears down the session immediately,
     *  independent of this timer. */
    sessionTimeoutMs: number;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadConfig(): Config {
  const envPath = process.env.CELLAGENTS_MCP_CONFIG;
  const candidates = [
    envPath,
    path.resolve(__dirname, '../config.json'),
    path.resolve(__dirname, '../config.example.json')
  ].filter((p): p is string => typeof p === 'string');

  let cfg: Config | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Config;
      break;
    }
  }
  if (!cfg) throw new Error('No MCP server config file found; set CELLAGENTS_MCP_CONFIG or create config.json');

  // Back-compat: if an older config.json predates the session block,
  // fill in defaults instead of crashing.
  if (!cfg.session) {
    cfg.session = { heartbeatHz: 1, sessionTimeoutMs: 60_000 };
  }

  if (process.env.GAME_SERVER_URL) cfg.gameServer.url = process.env.GAME_SERVER_URL;
  if (process.env.MCP_PORT) cfg.mcp.port = Number(process.env.MCP_PORT);
  if (process.env.MCP_PATH) cfg.mcp.path = process.env.MCP_PATH;
  if (process.env.SESSION_HEARTBEAT_HZ) cfg.session.heartbeatHz = Number(process.env.SESSION_HEARTBEAT_HZ);
  if (process.env.SESSION_TIMEOUT_MS) cfg.session.sessionTimeoutMs = Number(process.env.SESSION_TIMEOUT_MS);
  return cfg;
}
