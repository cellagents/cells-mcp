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

export class GameClient {
  private socket: Socket;
  private welcomeResolved = false;
  private welcomeDeferred = createDeferred<{ playerId: string; world: { width: number; height: number } }>();

  snapshot: WorldSnapshot | null = null;

  constructor(
    private readonly gameServerUrl: string,
    private readonly nickname: string
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
      // Server quirk: a `player` client only receives `welcome` after it
      // emits `respawn`. Matches src/client/js/app.ts in cells-game.
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
}

function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
