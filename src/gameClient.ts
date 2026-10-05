import { io, Socket } from 'socket.io-client';

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
  lastUpdated: number;
}

export type TerminationReason =
  | { kind: 'kick'; reason: string }
  | { kind: 'disconnect'; reason: string }
  | { kind: 'rip' };

export class GameClient {
  private socket: Socket;
  private welcomeResolved = false;
  private welcomeDeferred = createDeferred<{ playerId: string; world: { width: number; height: number } }>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastTarget: { x: number; y: number } = { x: 0, y: 0 };
  private terminated = false;
  private terminationListener: ((reason: TerminationReason) => void) | null = null;

  snapshot: WorldSnapshot | null = null;

  constructor(
    private readonly gameServerUrl: string,
    private readonly nickname: string,
    private readonly heartbeatHz: number = 1
  ) {
    this.socket = io(this.gameServerUrl, {
      query: { type: 'player' },
      reconnection: false
    });

    this.socket.on('welcome', (_playerSettings: any, gameSizes: { width: number; height: number }) => {
      const playerPayload = {
        name: this.nickname,
        screenWidth: 1,
        screenHeight: 1,
        target: { x: 0, y: 0 }
      };
      this.socket.emit('gotit', playerPayload);
      if (!this.welcomeResolved) {
        this.welcomeResolved = true;
        this.startHeartbeat();
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
        lastUpdated: Date.now()
      };
    });

    this.socket.on('kick', (reason: string) => {
      console.warn(`[GameClient] kicked (${this.nickname}): ${reason}`);
      if (!this.welcomeResolved) {
        this.welcomeDeferred.reject(new Error(`kicked during join: ${reason}`));
      } else {
        this.markTerminated({ kind: 'kick', reason });
      }
    });

    this.socket.on('RIP', () => {
      console.log(`[GameClient] RIP (${this.nickname})`);
      this.markTerminated({ kind: 'rip' });
    });

    this.socket.on('connect_error', (err: Error) => {
      console.error('[GameClient] connect_error:', err?.message, (err as any)?.description, (err as any)?.cause);
      if (!this.welcomeResolved) {
        this.welcomeDeferred.reject(err);
      }
    });

    this.socket.on('connect', () => {
      console.log('[GameClient] connected, socket id:', this.socket.id);
      // Server quirk: a `player` client only receives `welcome` after it
      // emits `respawn`. Matches src/client/js/app.ts in cells-game.
      this.socket.emit('respawn');
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('[GameClient] disconnected:', reason);
      // disconnect fires for every socket close including our own
      // disconnect() call. Only propagate as a termination signal if we
      // were still live: we were welcomed and haven't already marked a
      // termination (kick/RIP already fired just before this).
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

  /** Register a callback fired exactly once when the game side ends the
   *  session (kick, post-join disconnect, or RIP). Not called when the
   *  MCP side explicitly calls disconnect(). */
  onTerminated(cb: (reason: TerminationReason) => void): void {
    this.terminationListener = cb;
  }

  isAlive(): boolean {
    return !this.terminated;
  }

  get playerId(): string {
    return this.socket.id ?? '';
  }

  setHeading(target: { x: number; y: number }): void {
    this.lastTarget = target;
    // Pass through immediately; the heartbeat pump below will keep sending
    // the same target between explicit calls so the game server doesn't
    // kick us for inactivity.
    this.socket.emit('0', target);
  }

  fireFood(): void {
    this.socket.emit('1');
  }

  split(): void {
    this.socket.emit('2');
  }

  disconnect(): void {
    // Intentional close by the MCP side. Don't propagate as a termination
    // signal; the caller already knows it tore the session down.
    this.terminated = true;
    this.stopHeartbeat();
    this.socket.disconnect();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer || this.heartbeatHz <= 0) return;
    const intervalMs = Math.max(1, Math.round(1000 / this.heartbeatHz));
    this.heartbeatTimer = setInterval(() => {
      if (this.terminated) return;
      // Re-emit last known target; cells-game stamps lastHeartbeat on
      // every '0' event regardless of target value.
      this.socket.emit('0', this.lastTarget);
    }, intervalMs);
    // Don't let this timer hold the Node process open on shutdown.
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

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
