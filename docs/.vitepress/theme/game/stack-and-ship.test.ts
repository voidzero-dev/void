import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameworks } from './frameworks.ts';
import { advanceStackGame, createStackGame, dropStackTile } from './stack-and-ship.ts';

void test('perfect drops preserve the footprint and reward streaks', () => {
  let game = createStackGame(() => 0);
  for (let level = 1; level <= 6; level++) {
    const top = game.tiles[game.tiles.length - 1]!;
    game.moving = { ...game.moving!, [game.axis]: top[game.axis] + 3 };
    const result = dropStackTile(game, () => 0);
    game = result.game;
    assert.equal(result.perfect, true);
    assert.equal(result.fragment, null);
    assert.equal(game.tiles[level]!.width, 240);
    assert.equal(game.tiles[level]!.depth, 240);
    assert.equal(game.tiles[level]![game.axis], -120);
    assert.equal(game.combo, level);
  }
  assert.equal(game.score, 400);
  assert.equal(game.perfects, 6);
});

void test('overhangs on either side leave a matching cut piece and reduce the next tile', () => {
  for (const delta of [-40, 40]) {
    const initial = createStackGame(() => 0);
    const moving = { ...initial.moving!, x: -120 + delta };
    const { game, fragment, perfect } = dropStackTile({ ...initial, moving, combo: 3 });
    assert.equal(perfect, false);
    assert.equal(game.combo, 0);
    assert.equal(game.score, 10);
    assert.equal(game.tiles[1]!.width, 200);
    assert.equal(game.moving!.width, 200);
    assert.equal(game.moving!.depth, 240);
    assert.equal(fragment!.width, 40);
    assert.equal(fragment!.x, delta < 0 ? -160 : 120);
    assert.equal(game.tiles[1]!.x, delta < 0 ? -120 : -80);
  }
});

void test('a zero-overlap drop ends the run without adding a layer or points', () => {
  const initial = createStackGame(() => 0);
  const result = dropStackTile({ ...initial, moving: { ...initial.moving!, x: 120 } });
  assert.equal(result.game.moving, null);
  assert.equal(result.game.tiles.length, 1);
  assert.equal(result.game.score, 0);
  assert.equal(advanceStackGame(result.game, 1), result.game);
  assert.equal(dropStackTile(result.game).game, result.game);
});

void test('movement reflects at both ends and is independent of frame rate', () => {
  const initial = createStackGame(() => 0);
  const once = advanceStackGame(initial, 5);
  let stepped = initial;
  for (let frame = 0; frame < 100; frame++) {
    stepped = advanceStackGame(stepped, 0.05);
  }
  assert.equal(once.moving!.x, stepped.moving!.x);
  assert(once.moving!.x >= -300 && once.moving!.x <= 60);
  assert.equal(advanceStackGame(initial, 2.4).moving!.x, 60);
  assert.equal(advanceStackGame(initial, 4.8).moving!.x, -300);
});

void test('tiles enter from all four directions independently of the framework shuffle', () => {
  for (let entry = 0; entry < 4; entry++) {
    let call = 0;
    const game = createStackGame(() => (call++ === 0 ? (entry + 0.5) / 4 : 0.875));
    const axis = entry < 2 ? 'x' : 'z';
    const direction = entry % 2 === 0 ? 1 : -1;
    assert.equal(game.axis, axis);
    assert.equal(game.direction, direction);
    assert.equal(game.moving!.framework, 0);
    assert.equal(game.moving![axis], -120 - 180 * direction);
    const advanced = advanceStackGame(game, 1);
    assert.equal(advanced.moving![axis], -120 - 30 * direction);
    assert.equal(game.moving![axis === 'x' ? 'z' : 'x'], -120);
  }
});

void test('a new entry direction can change both axis and sign after a drop', () => {
  const initial = createStackGame(() => 0);
  initial.moving = { ...initial.moving!, x: -120 };
  let call = 0;
  const { game } = dropStackTile(initial, () => (call++ === 0 ? 0.875 : 0.375));
  assert.equal(game.axis, 'z');
  assert.equal(game.direction, -1);
  assert.equal(game.moving!.z, 60);
  assert.equal(game.moving!.framework, 2);
});

void test('each shuffled set includes all nine frameworks before any repeat', () => {
  let seed = 42;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  let game = createStackGame(random);
  let previous = -1;
  const sets: Array<Array<number>> = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const seen: Array<number> = [];
    for (let index = 0; index < 9; index++) {
      const current = game.moving!.framework;
      assert.notEqual(current, previous);
      seen.push(current);
      previous = current;
      const top = game.tiles[game.tiles.length - 1]!;
      game.moving = { ...game.moving!, [game.axis]: top[game.axis] };
      const remaining = [...game.remainingFrameworks];
      const result = dropStackTile(game, random);
      assert.deepEqual(game.remainingFrameworks, remaining);
      game = result.game;
    }
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      frameworks.map((_, index) => index),
    );
    sets.push(seen);
  }
  assert.notDeepEqual(sets[0], sets[1]);
});

void test('a new shuffled set cannot repeat the last logo of the previous set', () => {
  const initial = createStackGame(() => 0);
  const top = initial.tiles[0]!;
  const result = dropStackTile(
    { ...initial, moving: { ...initial.moving!, x: top.x }, remainingFrameworks: [] },
    () => 0,
  );
  assert.notEqual(result.game.moving!.framework, initial.moving!.framework);
});
