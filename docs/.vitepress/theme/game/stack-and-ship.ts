import { frameworks } from './frameworks.ts';

export type Axis = 'x' | 'z';

export interface Tile {
  x: number;
  z: number;
  width: number;
  depth: number;
  level: number;
  framework: number;
}

export interface StackGame {
  tiles: Array<Tile>;
  moving: Tile | null;
  remainingFrameworks: Array<number>;
  axis: Axis;
  direction: 1 | -1;
  travel: number;
  score: number;
  combo: number;
  perfects: number;
}

export interface DropResult {
  game: StackGame;
  fragment: Tile | null;
  perfect: boolean;
}

const RANGE = 180;
export const LAYER_HEIGHT = 26;

function nextTile(
  top: Tile,
  remainingFrameworks: Array<number>,
  random: () => number,
): Pick<StackGame, 'axis' | 'direction' | 'moving' | 'remainingFrameworks'> {
  const entry = Math.floor(random() * 4);
  const axis: Axis = entry < 2 ? 'x' : 'z';
  const direction = entry % 2 === 0 ? 1 : -1;
  let bag = remainingFrameworks;
  if (bag.length === 0) {
    bag = frameworks.map((_, index) => index);
    for (let index = bag.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [bag[index], bag[other]] = [bag[other], bag[index]];
    }
    // Avoid an immediate repeat when starting the next shuffled set.
    if (bag[0] === top.framework) {
      [bag[0], bag[1]] = [bag[1], bag[0]];
    }
  }
  const [framework, ...remaining] = bag;
  return {
    axis,
    direction,
    remainingFrameworks: remaining,
    moving: {
      ...top,
      [axis]: top[axis] - RANGE * direction,
      level: top.level + 1,
      framework,
    },
  };
}

export function createStackGame(random: () => number = Math.random): StackGame {
  const base: Tile = { x: -120, z: -120, width: 240, depth: 240, level: 0, framework: -1 };
  return {
    tiles: [base],
    ...nextTile(base, [], random),
    travel: 0,
    score: 0,
    combo: 0,
    perfects: 0,
  };
}

export function advanceStackGame(game: StackGame, seconds: number): StackGame {
  if (!game.moving) {
    return game;
  }
  const top = game.tiles.at(-1)!;
  const speed = Math.min(320, 150 + top.level * 9);
  const travel = game.travel + Math.max(0, seconds) * speed;
  const position = travel % (RANGE * 4);
  const offset = position <= RANGE * 2 ? position - RANGE : RANGE * 3 - position;
  return {
    ...game,
    travel,
    moving: { ...game.moving, [game.axis]: top[game.axis] + offset * game.direction },
  };
}

export function dropStackTile(game: StackGame, random: () => number = Math.random): DropResult {
  if (!game.moving) {
    return { game, fragment: null, perfect: false };
  }
  const top = game.tiles.at(-1)!;
  const tile = game.moving;
  const size = game.axis === 'x' ? 'width' : 'depth';
  const delta = tile[game.axis] - top[game.axis];
  const perfect = Math.abs(delta) <= Math.min(7, top[size] * 0.045);

  if (!perfect && Math.abs(delta) >= top[size]) {
    return { game: { ...game, moving: null, combo: 0 }, fragment: tile, perfect: false };
  }

  const placed: Tile = perfect
    ? { ...tile, [game.axis]: top[game.axis] }
    : {
        ...tile,
        [game.axis]: Math.max(tile[game.axis], top[game.axis]),
        [size]: top[size] - Math.abs(delta),
      };
  const fragment: Tile | null = perfect
    ? null
    : {
        ...tile,
        [game.axis]: delta > 0 ? top[game.axis] + top[size] : tile[game.axis],
        [size]: Math.abs(delta),
      };
  const combo = perfect ? game.combo + 1 : 0;
  return {
    game: {
      tiles: [...game.tiles, placed],
      ...nextTile(placed, game.remainingFrameworks, random),
      travel: 0,
      score: game.score + (perfect ? 20 * Math.min(combo, 5) : 10),
      combo,
      perfects: game.perfects + Number(perfect),
    },
    fragment,
    perfect,
  };
}
