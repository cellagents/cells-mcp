import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  gameServer: { url: string; adminToken: string };
  mcp: { port: number; path: string };
  clamp: { honestMaxFloor: number; lowerBoundFactor: number; upperBoundFactor: number };
  modelTiers: Record<string, number>;
  heartbeatFallback: { enabled: boolean; minDrainMultiplier: number; staleAfterMs: number };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Config loading order:
 *   1. file at CELLAGENTS_MCP_CONFIG (if set)
 *   2. config.json next to the source
 *   3. config.example.json next to the source (the shipped defaults)
 * Then env vars override individual leaves so docker-compose can wire things
 * without mounting a file.
 */
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

  // Env overrides. Keep each override explicit and documented.
  if (process.env.GAME_SERVER_URL) cfg.gameServer.url = process.env.GAME_SERVER_URL;
  if (process.env.GAME_SERVER_ADMIN_TOKEN) cfg.gameServer.adminToken = process.env.GAME_SERVER_ADMIN_TOKEN;
  if (process.env.MCP_PORT) cfg.mcp.port = Number(process.env.MCP_PORT);
  if (process.env.MCP_PATH) cfg.mcp.path = process.env.MCP_PATH;
  if (process.env.MCP_MODEL_TIERS) {
    try { cfg.modelTiers = JSON.parse(process.env.MCP_MODEL_TIERS); }
    catch (err) { console.warn('[config] MCP_MODEL_TIERS not valid JSON:', (err as Error).message); }
  }
  return cfg;
}
