import { io, Socket } from 'socket.io-client';

// Shape of the per-tick view the game server emits as `serverTellPlayerMove`.
// Positions and sizes are in world coordinates, matching the upstream
// agar.io-clone data model.
export interface Cell {
  x: number;
  y: number;
  mass: number;
  radius: number;
  speed: number;
}

export interface PlayerView {
  x: number;
  y: number;
  cells: Cell[];
  massTotal: number;
  hue: number;
  id: string;
  name: string;
}

export interface FoodView { x: number; y: number; }
export interface VirusView { x: number; y: number; mass: number; radius: number; }
export interface MassFoodView { x: number; y: number; mass: number; radius: number; }

export interface WorldSnapshot {
  self: PlayerView;
  players: PlayerView[];
  food: FoodView[];
  mass: MassFoodView[];
  viruses: VirusView[];
  roundState: RoundState | null;
  lastUpdated: number;
}

export interface RoundState {
  phase: 'open' | 'sudden_death' | 'countdown' | 'ended';
  timeRemaining: number | null;
  endsAt: number | null;
  winner: string | null;
}

export interface LeaderboardEntry { id: string; name: string; }

/**
 * GameClient wraps one Socket.IO connection to the game server and keeps the
 * last snapshot it received, so tools can read current state synchronously.
 * One instance per MCP session.
 */
export class GameClient {
  private socket: Socket;
  private welcomeResolved = false;
  private welcomeDeferred = createDeferred<{ playerId: string; world: { width: number; height: number } }>();

  snapshot: WorldSnapshot | null = null;
  roundState: RoundState | null = null;
  leaderboard: LeaderboardEntry[] = [];

  // Observed timing for the honest-cost estimator. toolCallIntervals holds the
  // gap between the last few heartbeat calls (ms), promptTokensHistory is the
  // declared prompt_tokens for the same window.
  readonly toolCallIntervals: number[] = [];
  readonly promptTokensHistory: number[] = [];
  lastHeartbeatAt: number | null = null;

  constructor(
    private readonly gameServerUrl: string,
    private readonly nickname: string,
    public readonly joinToken: string
  ) {
    this.socket = io(this.gameServerUrl, {
      query: {
        type: 'player',
        join_token: this.joinToken
      },
      reconnection: false
    });

    this.socket.on('welcome', (playerSettings: any, gameSizes: { width: number; height: number }) => {
      // Mirror the default client's handshake: the server expects us to send
      // our chosen nickname back via `gotit` before it spawns us into the
      // map. socket.id is only final after `connect`, so we read it here.
      const playerPayload = {
        name: this.nickname,
        screenWidth: 1,
        screenHeight: 1,
        target: { x: 0, y: 0 }
      };
      this.socket.emit('gotit', playerPayload);
      if (!this.welcomeResolved) {
        this.welcomeResolved = true;
        this.welcomeDeferred.resolve({ playerId: this.socket.id ?? '', world: gameSizes });
      }
    });

    this.socket.on('serverTellPlayerMove', (
      self: PlayerView,
      players: PlayerView[],
      food: FoodView[],
      mass: MassFoodView[],
      viruses: VirusView[]
    ) => {
      this.snapshot = {
        self,
        players,
        food,
        mass,
        viruses,
        roundState: this.roundState,
        lastUpdated: Date.now()
      };
    });

    this.socket.on('roundState', (state: RoundState) => {
      this.roundState = state;
      if (this.snapshot) this.snapshot.roundState = state;
    });

    this.socket.on('leaderboard', (data: { players: number; leaderboard: LeaderboardEntry[] }) => {
      this.leaderboard = data.leaderboard || [];
    });

    this.socket.on('kick', (reason: string) => {
      console.warn(`[GameClient] kicked (${this.nickname}): ${reason}`);
      if (!this.welcomeResolved) {
        this.welcomeDeferred.reject(new Error(`kicked during join: ${reason}`));
      }
    });

    this.socket.on('connect_error', (err: Error) => {
      console.error('[GameClient] connect_error:', err?.message, (err as any)?.description, (err as any)?.cause);
      if (!this.welcomeResolved) {
        this.welcomeDeferred.reject(err);
      }
    });

    this.socket.on('connect', () => {
      console.log('[GameClient] connected, socket id:', this.socket.id);
      // Upstream protocol quirk: a `player` client never receives `welcome`
      // until it asks for it by emitting `respawn`. See src/client/js/app.js
      // in agar.io-clone, which fires `respawn` immediately after connect.
      this.socket.emit('respawn');
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('[GameClient] disconnected:', reason);
    });
  }

  async awaitJoined(timeoutMs = 5000): Promise<{ playerId: string; world: { width: number; height: number } }> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout waiting for welcome')), timeoutMs)
    );
    return Promise.race([this.welcomeDeferred.promise, timeout]);
  }

  get playerId(): string {
    return this.socket.id ?? '';
  }

  setHeading(target: { x: number; y: number }): void {
    // Native heartbeat/target event in upstream protocol.
    this.socket.emit('0', target);
  }

  fireFood(): void {
    this.socket.emit('1');
  }

  split(): void {
    this.socket.emit('2');
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  recordHeartbeat(promptTokens: number): void {
    const now = Date.now();
    if (this.lastHeartbeatAt !== null) {
      this.toolCallIntervals.push(now - this.lastHeartbeatAt);
      if (this.toolCallIntervals.length > 10) this.toolCallIntervals.shift();
    }
    this.lastHeartbeatAt = now;
    this.promptTokensHistory.push(promptTokens);
    if (this.promptTokensHistory.length > 10) this.promptTokensHistory.shift();
  }
}

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
