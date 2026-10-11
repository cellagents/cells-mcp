// Dual-mode factory. Probes the game server's HTTP /protocol route
// to decide which wire to speak:
//
//   200 OK + { protocol: '1.0' }  -> GameClient (new 4.0 handshake)
//   404 or anything else          -> LegacyGameClient (pre-fork
//                                     agar.io-clone + cells-game 3.x)
//
// The probe runs once per cells-mcp session; both clients expose
// the same public API so session.ts never has to care which it got.

import { ProtocolProbeSchema } from '@cellagents/game-protocol';
import { GameClient } from './gameClient.js';
import { LegacyGameClient } from './legacyGameClient.js';

/** Shared surface between the two game-client implementations. */
export type AnyGameClient = GameClient | LegacyGameClient;

export async function createGameClient(
    gameServerUrl: string,
    nickname: string,
    viewport: { width: number; height: number },
    heartbeatHz: number,
    /** Opaque per-MCP-session identity, forwarded to protocol 1.0
     *  servers as `subscribe.clientId`. The legacy wire has no
     *  slot for this, so the arg is ignored in legacy mode. */
    clientId?: string
): Promise<AnyGameClient> {
    const mode = await probe(gameServerUrl);
    if (mode === 'protocol-1.0') {
        return new GameClient(gameServerUrl, nickname, viewport, heartbeatHz, clientId);
    }
    return new LegacyGameClient(gameServerUrl, nickname, viewport, heartbeatHz);
}

async function probe(gameServerUrl: string): Promise<'protocol-1.0' | 'legacy'> {
    const url = gameServerUrl.replace(/\/$/, '') + '/protocol';
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.status === 404) return 'legacy';
        if (!res.ok) {
            console.warn(`[createGameClient] /protocol returned ${res.status}; assuming legacy`);
            return 'legacy';
        }
        const body: unknown = await res.json();
        const parsed = ProtocolProbeSchema.safeParse(body);
        if (!parsed.success) {
            console.warn('[createGameClient] /protocol body did not match ProtocolProbe; assuming legacy');
            return 'legacy';
        }
        return 'protocol-1.0';
    } catch (err) {
        // Network error, timeout, bad JSON etc. The game server might
        // still be a legacy one (pre-fork agar.io-clone has no HTTP
        // routes at all beyond the asset tree). Fall back to legacy;
        // if the server is in fact dead we'll surface the error at
        // the socket layer instead.
        console.warn('[createGameClient] /protocol probe failed:', (err as Error).message, '— assuming legacy');
        return 'legacy';
    }
}
