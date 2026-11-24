import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalDemos } from '../../docs/.vitepress/theme/terminal/demos.ts';
import {
  PlaybackClock,
  playbackSpeeds,
  terminalFrame,
  type TerminalDemo,
} from '../../docs/.vitepress/theme/terminal/timeline.ts';

void test('pause and speed changes preserve playback position without counting paused time', () => {
  const clock = new PlaybackClock(20_000);
  clock.play(1000);
  assert.equal(clock.read(1500), 500);
  clock.pause(1500);
  assert.equal(clock.read(10_000), 500);
  clock.play(10_000);
  clock.setSpeed(2, 11_000);
  assert.equal(clock.read(11_500), 2500);
  clock.seek(10_000, 11_500);
  assert.equal(clock.read(12_000), 11_000);
  clock.pause(12_000);
  assert.equal(clock.read(13_000), 11_000);
  clock.setSpeed(Number.NaN, 13_000);
  assert.equal(clock.speed, 2);
});

void test('endpoints clamp and replay starts at the beginning', () => {
  const clock = new PlaybackClock(5000);
  clock.play(0);
  assert.equal(clock.read(10_000), 5000);
  clock.pause(10_000);
  clock.seek(-100, 10_000);
  clock.play(10_000);
  assert.equal(clock.read(10_100), 100);
  clock.seek(9000, 10_100);
  assert.equal(clock.read(10_100), 5000);
});

void test('seeking backwards restores transient prompt options and spinner states', () => {
  const demo = terminalDemos.find((item) => item.id === 'recover')!;
  const selectionTime = demo.events.find(
    (event) => event.type === 'write' && event.line.id === 'option',
  )!.at;
  const rollbackTime = demo.events.find(
    (event) => event.type === 'write' && event.line.id === 'rollback',
  )!.at;
  const intermediate = terminalFrame(demo, selectionTime);
  assert.ok(intermediate.some((line) => line.id === 'option'));
  const rolling = terminalFrame(demo, rollbackTime);
  assert.ok(!rolling.some((line) => line.id === 'option'));
  assert.equal(rolling.find((line) => line.id === 'rollback')?.spinner, true);
  const completed = terminalFrame(demo, demo.duration);
  assert.ok(completed.every((line) => !line.spinner && !line.caret));
  assert.deepEqual(terminalFrame(demo, selectionTime), intermediate);
});

void test('typed Unicode characters are never split and finish without a caret', () => {
  const demo = {
    ...terminalDemos[0],
    duration: 1000,
    events: [{ at: 0, type: 'type', id: 'command', text: 'a🚀b', duration: 900 }],
  } satisfies TerminalDemo;
  assert.equal(terminalFrame(demo, 300)[0].segments[0].text, 'a');
  assert.equal(terminalFrame(demo, 600)[0].segments[0].text, 'a🚀');
  assert.equal(terminalFrame(demo, 1000)[0].segments[0].text, 'a🚀b');
  assert.equal(terminalFrame(demo, 1000)[0].caret, false);
});

void test('all demo timelines finish, stay ordered, and render complete aligned boxes', () => {
  for (const demo of terminalDemos) {
    assert.equal(demo.events[0].type, 'type');
    assert.ok(
      demo.events.every((event, i) => event.at >= 0 && (!i || event.at >= demo.events[i - 1].at)),
    );
    assert.ok(demo.duration > demo.events.at(-1)!.at);
    const lines = terminalFrame(demo, demo.duration);
    assert.ok(lines.every((line) => !line.spinner && !line.caret));
    let width = 0;
    for (const line of lines) {
      const text = line.segments.map((segment) => segment.text).join('');
      if (text.startsWith('╭')) {
        width = Array.from(text).length;
      }
      if (text.startsWith('│') || text.startsWith('╰')) {
        assert.equal(Array.from(text).length, width, `${demo.id}: ${text}`);
      }
    }
  }
});

void test('every demo finishes within ten seconds at every available playback speed', () => {
  for (const demo of terminalDemos) {
    for (const speed of playbackSpeeds) {
      assert.ok(demo.duration / speed <= 10_000, `${demo.id} at ${speed}×`);
    }
    for (const event of demo.events) {
      if (event.type === 'type') {
        const nextEvent = demo.events.find((next) => next.at > event.at);
        assert.ok(event.at + event.duration <= (nextEvent?.at ?? demo.duration), event.id);
      }
    }
  }
});

void test('status and prompt symbols always have exactly one following space', () => {
  for (const demo of terminalDemos) {
    for (const event of demo.events) {
      if (event.type === 'write') {
        const text = event.line.segments.map((segment) => segment.text).join('');
        if (/^\s*[◇●◆✓›]/u.test(text)) {
          assert.match(text, /^\s*[◇●◆✓›] [^\s]/u, `${demo.id}: ${text}`);
        }
      }
    }
  }
});

void test('command output adds destination context without echoing the typed command', () => {
  for (const demo of terminalDemos) {
    const output = terminalFrame(demo, demo.duration)
      .filter((line) => !line.id.endsWith('command'))
      .map((line) => line.segments.map((segment) => segment.text).join(''));
    assert.ok(
      !output.some((line) =>
        /^void (deploy|platform install|project logs|project rollback)$/.test(line),
      ),
    );
    if (demo.id === 'deploy') {
      assert.equal(
        output.find((line) => line.includes('→')),
        'blog → Cloudflare',
      );
    }
  }
});
