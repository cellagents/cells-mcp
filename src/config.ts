import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  gameServer: { url: string };
  mcp: { port: number; path: string };
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

  if (process.env.GAME_SERVER_URL) cfg.gameServer.url = process.env.GAME_SERVER_URL;
  if (process.env.MCP_PORT) cfg.mcp.port = Number(process.env.MCP_PORT);
  if (process.env.MCP_PATH) cfg.mcp.path = process.env.MCP_PATH;
  return cfg;
}
