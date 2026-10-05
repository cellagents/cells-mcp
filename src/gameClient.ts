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

type SteeringState =
  | { kind: 'idle' }
  | { kind: 'move_to'; x: number; y: number }
  | { kind: 'heading'; angle: number };

/** How close (world units) to a move_to target before we consider the
 *  player arrived and stop steering. Comfortably above the game's own
 *  MIN_DISTANCE (50) + typical radius so arrival is unambiguous. */
const ARRIVAL_THRESHOLD = 80;

/** Length (world units) of the direction vector we synthesize for a
 *  persistent heading. Well above the game's MIN_DISTANCE so the server
 *  never scales the delta down. */
const HEADING_PROJECTION = 500;

export class GameClient {
  private socket: Socket;
  private welcomeResolved = false;
  private welcomeDeferred = createDeferred<{ playerId: string; world: { width: number; height: number } }>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Steering intent, resolved to a mouse-offset on every pump tick.
   *  idle      → emit (0,0); the player decelerates and halts.
   *  move_to   → emit (target - player); when inside arrivalThreshold
   *              the pump switches to idle so the cell doesn't jitter
   *              past the destination.
   *  heading   → emit a unit-direction scaled to a safely-large length
   *              so the game never treats it as "near destination". */
  private steering: SteeringState = { kind: 'idle' };
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

  /** Head toward a specific world coordinate. The MCP keeps steering the
   *  cell there every pump tick, re-computing the direction from the
   *  current player position. When the player arrives within
   *  ARRIVAL_THRESHOLD the steering goes idle and the cell decelerates. */
  moveTo(x: number, y: number): void {
    this.steering = { kind: 'move_to', x, y };
    this.emitSteering();
  }

  /** Move indefinitely at a given angle (radians, standard math convention:
   *  0 = +x, π/2 = +y, i.e. down in screen space). The pump re-emits a
   *  unit direction every tick so the cell doesn't drift from the heading
   *  as it moves. */
  setHeading(angle: number): void {
    this.steering = { kind: 'heading', angle };
    this.emitSteering();
  }

  /** Stop any steering; cell decelerates to a halt. */
  stop(): void {
    this.steering = { kind: 'idle' };
    this.emitSteering();
  }

  /** Resolve the current steering state against the current snapshot and
   *  emit a mouse-offset '0' event. Called synchronously by the move_to /
   *  set_heading / stop entrypoints and by the heartbeat pump. */
  private emitSteering(): void {
    const offset = this.computeOffset();
    this.socket.emit('0', offset);
  }

  private computeOffset(): { x: number; y: number } {
    if (this.steering.kind === 'idle') {
      return { x: 0, y: 0 };
    }
    // Fall back to "aim at origin" if we have no snapshot yet - this only
    // affects the first few ms before the server fires serverTellPlayerMove.
    const self = this.snapshot?.self;
    const px = self?.x ?? 0;
    const py = self?.y ?? 0;
    if (this.steering.kind === 'move_to') {
      const dx = this.steering.x - px;
      const dy = this.steering.y - py;
      const dist = Math.hypot(dx, dy);
      if (dist < ARRIVAL_THRESHOLD) {
        // Latch arrival so subsequent heartbeats emit (0,0) without
        // recomputing. Avoids microscopic oscillation if the player
        // overshoots by a hair.
        this.steering = { kind: 'idle' };
        return { x: 0, y: 0 };
      }
      return { x: dx, y: dy };
    }
    // heading: project a fixed-length vector along the angle.
    const { angle } = this.steering;
    return {
      x: Math.cos(angle) * HEADING_PROJECTION,
      y: Math.sin(angle) * HEADING_PROJECTION
    };
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
      // Re-emit a fresh mouse-offset computed from the current steering
      // state and the latest snapshot position. cells-game stamps
      // lastHeartbeat on every '0' event regardless of offset value, so
      // an idle (0,0) offset still keeps us alive.
      this.emitSteering();
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
