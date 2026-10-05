import type { Config } from './config.js';

/**
 * Thin HTTP client for the game server's /admin surface. Only the endpoints
 * the MCP server actually calls are implemented; the thin client's /admin
 * mode talks to the same surface over its own fetch.
 */
export class AdminClient {
  constructor(private readonly config: Config) {}

  private headers(): HeadersInit {
    return {
      'Authorization': `Bearer ${this.config.gameServer.adminToken}`,
      'Content-Type': 'application/json'
    };
  }

  async setDrainMultiplier(playerId: string, multiplier: number): Promise<void> {
    const res = await fetch(`${this.config.gameServer.url}/admin/drain`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ playerId, multiplier })
    });
    if (!res.ok) {
      throw new Error(`setDrainMultiplier failed: ${res.status} ${await res.text()}`);
    }
  }

  async resolveJoinToken(token: string): Promise<string | null> {
    const res = await fetch(`${this.config.gameServer.url}/admin/token/${encodeURIComponent(token)}`, {
      headers: this.headers()
    });
    if (!res.ok) {
      throw new Error(`resolveJoinToken failed: ${res.status}`);
    }
    const body = await res.json() as { playerId: string | null };
    return body.playerId;
  }
}
