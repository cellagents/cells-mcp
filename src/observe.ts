import type { WorldSnapshot, PlayerView, Cell } from './gameClient.js';

export interface Observation {
  world: { width: number; height: number };
  self: {
    cells: { x: number; y: number; mass: number; radius: number }[];
    mass_total: number;
    center: { x: number; y: number };
  };
  threats: Threat[];      // bigger cells near us
  prey: Prey[];           // smaller cells near us
  viruses: NearEntity[];  // nearest viruses
  food_hint: { count_in_view: number; nearest: { x: number; y: number; distance: number } | null };
  edges: { left: number; right: number; top: number; bottom: number };
}

interface Threat { player: string; x: number; y: number; mass: number; distance: number; }
interface Prey   { player: string; x: number; y: number; mass: number; distance: number; }
interface NearEntity { x: number; y: number; mass: number; distance: number; }

const MAX_THREATS = 5;
const MAX_PREY = 5;
const MAX_VIRUSES = 5;
// Only consider a cell a "threat" if its mass is >1.1x our biggest cell (the
// upstream eat rule). Same ratio inverted for prey.
const EAT_RATIO = 1.1;

export function buildObservation(
  snapshot: WorldSnapshot,
  worldSize: { width: number; height: number }
): Observation {
  const self = snapshot.self;
  const myBiggest = biggestCell(self.cells);
  const myMass = myBiggest ? myBiggest.mass : 0;

  const threats: Threat[] = [];
  const prey: Prey[] = [];

  for (const other of snapshot.players) {
    if (other.id === self.id) continue;
    for (const cell of other.cells) {
      const distance = Math.hypot(cell.x - self.x, cell.y - self.y);
      if (cell.mass > myMass * EAT_RATIO) {
        threats.push({ player: other.name, x: cell.x, y: cell.y, mass: Math.round(cell.mass), distance: Math.round(distance) });
      } else if (myMass > cell.mass * EAT_RATIO) {
        prey.push({ player: other.name, x: cell.x, y: cell.y, mass: Math.round(cell.mass), distance: Math.round(distance) });
      }
    }
  }
  threats.sort((a, b) => a.distance - b.distance);
  prey.sort((a, b) => a.distance - b.distance);

  const viruses: NearEntity[] = snapshot.viruses
    .map(v => ({
      x: v.x,
      y: v.y,
      mass: Math.round(v.mass),
      distance: Math.round(Math.hypot(v.x - self.x, v.y - self.y))
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_VIRUSES);

  const foodCount = snapshot.food.length;
  let nearestFood: { x: number; y: number; distance: number } | null = null;
  if (foodCount > 0) {
    let best = Infinity;
    let bestEntry = snapshot.food[0];
    for (const f of snapshot.food) {
      const d = Math.hypot(f.x - self.x, f.y - self.y);
      if (d < best) { best = d; bestEntry = f; }
    }
    nearestFood = { x: Math.round(bestEntry.x), y: Math.round(bestEntry.y), distance: Math.round(best) };
  }

  return {
    world: worldSize,
    self: {
      cells: self.cells.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), mass: Math.round(c.mass), radius: Math.round(c.radius) })),
      mass_total: Math.round(self.massTotal),
      center: { x: Math.round(self.x), y: Math.round(self.y) }
    },
    threats: threats.slice(0, MAX_THREATS),
    prey: prey.slice(0, MAX_PREY),
    viruses,
    food_hint: { count_in_view: foodCount, nearest: nearestFood },
    edges: {
      left: Math.round(self.x),
      right: Math.round(worldSize.width - self.x),
      top: Math.round(self.y),
      bottom: Math.round(worldSize.height - self.y)
    }
  };
}

function biggestCell(cells: Cell[]): Cell | null {
  if (cells.length === 0) return null;
  return cells.reduce((a, b) => (a.mass >= b.mass ? a : b));
}
