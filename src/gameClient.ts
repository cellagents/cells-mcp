// Protocol 1.0 game client. Uses @cellagents/game-protocol for the
// handshake + event names. Public API matches LegacyGameClient so
// session.ts can swap between them transparently (see
// createGameClient.ts for the dispatch).
//
// The Tick payload's flat `entities` list is grouped back into the
// per-kind arrays the rest of cells-mcp consumes (WorldSnapshot).
// Keeps observe() independent of wire version.

import { io, Socket } from 'socket.io-client';
import {
    PROTOCOL_VERSION,
    ClientEvent,
    ServerEvent,
    type Welcome,
    type Reject,
    type Tick,
    type Kick,
    type Entity,
    type Effect,
    type Rules
} from '@cellagents/game-protocol';

/** User-agent string sent to the server on subscribe. Keep in sync
 *  with package.json; manual bump is fine until this repo adopts
 *  a build-time inject. */
export const CELLS_MCP_USER_AGENT = 'cells-mcp/2.0.0';

export interface Cell {
    x: number;
    y: number;
    mass: number;
    radius: number;
    speed?: number;
    /** Protocol 1.0: per-cell effects (`noMerge` on freshly-split
     *  cells). Surface so observe() can report merge-timer state. */
    effects?: Effect[];
}

export interface PlayerView {
    x: number;
    y: number;
    cells: Cell[];
    massTotal: number;
    hue: number;
    id: string;
    name: string;
    /** Protocol 1.0: per-player effects (`invulnerable` during
     *  spawn grace). */
    effects?: Effect[];
}

export interface FoodView { x: number; y: number; mass: number; }
export interface VirusView { x: number; y: number; mass: number; radius: number; }
export interface MassFoodView { x: number; y: number; mass: number; radius: number; }

export interface WorldSnapshot {
    self: PlayerView;
    players: PlayerView[];
    food: FoodView[];
    mass: MassFoodView[];
    viruses: VirusView[];
    lastUpdated: number;
    /** Protocol 1.0: active rules. Bots read eatRatio from here
     *  rather than hardcoding it. Optional so the legacy client
     *  (which has no rules bag) can share this shape. */
    rules?: Rules;
}

export type TerminationReason =
    | { kind: 'kick'; reason: string }
    | { kind: 'disconnect'; reason: string }
    | { kind: 'rip' };

type SteeringState =
    | { kind: 'idle' }
    | { kind: 'move_to'; x: number; y: number }
    | { kind: 'heading'; angle: number };

const ARRIVAL_THRESHOLD = 80;
const HEADING_PROJECTION = 500;

export class GameClient {
    private socket: Socket;
    private welcomeResolved = false;
    private welcomeDeferred = createDeferred<{ playerId: string; world: { width: number; height: number } }>();
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private steering: SteeringState = { kind: 'idle' };
    private terminated = false;
    private terminationListener: ((reason: TerminationReason) => void) | null = null;

    /** Granted action types (from welcome.actions, updated by
     *  actionsChanged). Public so session.ts tools can refuse a
     *  split/eject when the server did not list it. */
    actions = new Set<string>();
    /** Active rules bag. Updated on welcome and rulesChanged. */
    rules: Rules = {};

    snapshot: WorldSnapshot | null = null;

    constructor(
        private readonly gameServerUrl: string,
        private readonly nickname: string,
        private readonly viewport: { width: number; height: number },
        private readonly heartbeatHz: number = 1
    ) {
        this.socket = io(this.gameServerUrl, { reconnection: false });

        this.socket.on('connect', () => {
            console.log('[GameClient] connected, socket id:', this.socket.id);
            this.socket.emit(ClientEvent.subscribe, {
                protocol: PROTOCOL_VERSION,
                userAgent: CELLS_MCP_USER_AGENT,
                capabilities: ['presence', 'steer', 'act'],
                name: this.nickname,
                screen: { width: this.viewport.width, height: this.viewport.height }
            });
        });

        this.socket.on(ServerEvent.welcome, (payload: Welcome) => {
            this.actions = new Set(payload.actions);
            this.rules = payload.rules;
            if (!this.welcomeResolved) {
                this.welcomeResolved = true;
                this.startHeartbeat();
                this.welcomeDeferred.resolve({
                    playerId: payload.self?.id ?? payload.sessionId,
                    world: payload.world
                });
            }
        });

        this.socket.on(ServerEvent.reject, (payload: Reject) => {
            if (!this.welcomeResolved) {
                this.welcomeDeferred.reject(new Error(`subscribe rejected: ${payload.code} — ${payload.message}`));
            }
        });

        this.socket.on(ServerEvent.actionsChanged, (payload: { actions: string[] }) => {
            this.actions = new Set(payload?.actions ?? []);
        });

        this.socket.on(ServerEvent.rulesChanged, (payload: { rules: Rules }) => {
            this.rules = payload?.rules ?? {};
        });

        this.socket.on(ServerEvent.tick, (payload: Tick) => {
            if (!payload.self) {
                // Pre-respawn / dead state. Keep the previous
                // snapshot so observe keeps a last-known view.
                return;
            }
            this.snapshot = tickToWorldSnapshot(payload, this.rules);
        });

        this.socket.on(ServerEvent.kick, (payload: Kick) => {
            console.warn(`[GameClient] kicked (${this.nickname}): ${payload.reason}`);
            if (!this.welcomeResolved) {
                this.welcomeDeferred.reject(new Error(`kicked during join: ${payload.reason}`));
            } else {
                this.markTerminated({ kind: 'kick', reason: payload.reason });
            }
        });

        this.socket.on(ServerEvent.died, () => {
            console.log(`[GameClient] died (${this.nickname})`);
            this.markTerminated({ kind: 'rip' });
        });

        this.socket.on(ServerEvent.message, () => {
            // cells-mcp 2.0 exposes no messaging tools; ignore
            // incoming `message` events quietly so a chat-full
            // server doesn't flood stdout.
        });

        this.socket.on('connect_error', (err: Error) => {
            console.error('[GameClient] connect_error:', err?.message, (err as unknown as { description?: unknown })?.description, (err as unknown as { cause?: unknown })?.cause);
            if (!this.welcomeResolved) {
                this.welcomeDeferred.reject(err);
            }
        });

        this.socket.on('disconnect', (reason: string) => {
            console.log('[GameClient] disconnected:', reason);
            if (this.welcomeResolved) {
                this.markTerminated({ kind: 'disconnect', reason });
            }
        });
    }

    async awaitJoined(timeoutMs = 5000): Promise<{ playerId: string; world: { width: number; height: number } }> {
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout waiting for welcome')), timeoutMs)
        );
        return Promise.race([this.welcomeDeferred.promise, timeout]);
    }

    onTerminated(cb: (reason: TerminationReason) => void): void {
        this.terminationListener = cb;
    }

    isAlive(): boolean {
        return !this.terminated;
    }

    get playerId(): string {
        return this.socket.id ?? '';
    }

    moveTo(x: number, y: number): void {
        this.steering = { kind: 'move_to', x, y };
        this.emitSteering();
    }

    setHeading(angle: number): void {
        this.steering = { kind: 'heading', angle };
        this.emitSteering();
    }

    stop(): void {
        this.steering = { kind: 'idle' };
        this.emitSteering();
    }

    private emitSteering(): void {
        const offset = this.computeOffset();
        this.socket.emit(ClientEvent.heartbeat, offset);
    }

    private computeOffset(): { x: number; y: number } {
        if (this.steering.kind === 'idle') return { x: 0, y: 0 };
        const self = this.snapshot?.self;
        const px = self?.x ?? 0;
        const py = self?.y ?? 0;
        if (this.steering.kind === 'move_to') {
            const dx = this.steering.x - px;
            const dy = this.steering.y - py;
            const dist = Math.hypot(dx, dy);
            if (dist < ARRIVAL_THRESHOLD) {
                this.steering = { kind: 'idle' };
                return { x: 0, y: 0 };
            }
            return { x: dx, y: dy };
        }
        const { angle } = this.steering;
        return {
            x: Math.cos(angle) * HEADING_PROJECTION,
            y: Math.sin(angle) * HEADING_PROJECTION
        };
    }

    /** Server-side gate: the action is only accepted if `eject`
     *  appears in welcome.actions / the latest actionsChanged list.
     *  The caller gets a boolean back so a tool can report that
     *  the action is currently revoked. */
    fireFood(): boolean {
        if (!this.actions.has('eject')) return false;
        this.socket.emit(ClientEvent.action, { type: 'eject' });
        return true;
    }

    split(): boolean {
        if (!this.actions.has('split')) return false;
        this.socket.emit(ClientEvent.action, { type: 'split' });
        return true;
    }

    disconnect(): void {
        this.terminated = true;
        this.stopHeartbeat();
        this.socket.disconnect();
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer || this.heartbeatHz <= 0) return;
        const intervalMs = Math.max(1, Math.round(1000 / this.heartbeatHz));
        this.heartbeatTimer = setInterval(() => {
            if (this.terminated) return;
            this.emitSteering();
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private markTerminated(reason: TerminationReason): void {
        if (this.terminated) return;
        this.terminated = true;
        this.stopHeartbeat();
        if (this.terminationListener) {
            try { this.terminationListener(reason); } catch (err) {
                console.error('[GameClient] onTerminated listener threw:', err);
            }
        }
    }
}

/** Translate a protocol-1.0 Tick (flat entity list, PlayerMeta
 *  without cells) into the internal WorldSnapshot shape the rest of
 *  cells-mcp uses. Cells are grouped by owner; food / ejected /
 *  virus kinds split into their legacy arrays. Unknown entity kinds
 *  are dropped silently (bots don't need to see them). */
function tickToWorldSnapshot(tick: Tick, rules: Rules): WorldSnapshot {
    const cellsByOwner = new Map<string, Cell[]>();
    const food: FoodView[] = [];
    const mass: MassFoodView[] = [];
    const viruses: VirusView[] = [];
    for (const e of tick.entities) {
        switch (e.kind) {
            case 'cell': {
                const owner = (e as Entity & { owner?: string }).owner;
                if (!owner) break;
                const list = cellsByOwner.get(owner);
                const c: Cell = { x: e.x, y: e.y, mass: e.mass, radius: e.radius };
                if (e.effects) c.effects = e.effects;
                if (list) list.push(c);
                else cellsByOwner.set(owner, [c]);
                break;
            }
            case 'food':
                food.push({ x: e.x, y: e.y, mass: e.mass });
                break;
            case 'ejected':
                mass.push({ x: e.x, y: e.y, mass: e.mass, radius: e.radius });
                break;
            case 'virus':
                viruses.push({ x: e.x, y: e.y, mass: e.mass, radius: e.radius });
                break;
            default:
                // Unknown kind: ignore. The protocol tells us to
                // preserve on parse (loose) but bots have no idea
                // what to do with it, so observe() just skips it.
                break;
        }
    }

    // The server guarantees Tick.self is non-null when we reach this
    // function (the caller checked). Build the self PlayerView.
    const selfMeta = tick.self!;
    const selfCells = cellsByOwner.get(selfMeta.id) ?? [];
    const self: PlayerView = {
        id: selfMeta.id,
        name: selfMeta.name ?? '',
        hue: selfMeta.hue,
        massTotal: selfMeta.massTotal,
        x: selfMeta.x,
        y: selfMeta.y,
        cells: selfCells
    };
    if (selfMeta.effects) self.effects = selfMeta.effects;

    const players: PlayerView[] = tick.players.map((p) => {
        const pv: PlayerView = {
            id: p.id,
            name: p.name ?? '',
            hue: p.hue,
            massTotal: p.massTotal,
            x: p.x,
            y: p.y,
            cells: cellsByOwner.get(p.id) ?? []
        };
        if (p.effects) pv.effects = p.effects;
        return pv;
    });

    return {
        self,
        players,
        food,
        mass,
        viruses,
        lastUpdated: tick.time,
        rules
    };
}

function createDeferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
