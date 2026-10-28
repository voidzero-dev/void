<script setup lang="ts">
import { useData } from 'vitepress';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PlaybackClock, terminalFrame, type TerminalDemo } from './timeline.ts';

const { frontmatter } = useData();
const props = withDefaults(
  defineProps<{
    demo: TerminalDemo;
    speed?: number;
    autoplay?: boolean;
    reducedMotion?: boolean;
    appearance?: 'studio' | 'home';
  }>(),
  { speed: 1, autoplay: true, reducedMotion: false, appearance: 'studio' },
);
const emit = defineEmits<{
  progress: [state: { time: number; playing: boolean; countdown: number }];
  complete: [];
}>();

const terminal = ref<HTMLElement | null>(null);
const viewport = ref<HTMLElement | null>(null);
// A complete, readable poster is available before hydration and with reduced motion.
const elapsed = ref(props.demo.duration);
const lines = computed(() => terminalFrame(props.demo, elapsed.value));
// Draw the box edges across the full terminal cell height. Font glyphs leave
// gaps at our readable line spacing; the transcript keeps the original glyphs.
const renderedLines = computed(() =>
  lines.value.map((line) => {
    const text = line.segments.map((segment) => segment.text).join('');
    const box = text.startsWith('╭')
      ? 'top'
      : text.startsWith('│')
        ? 'row'
        : text.startsWith('╰')
          ? 'bottom'
          : undefined;
    return {
      ...line,
      box,
      columns: Array.from(text).length,
      segments: box ? line.segments.slice(1, -1) : line.segments,
    };
  }),
);
const spinnerFrames = ['◒', '◐', '◓', '◑'];
const spinnerFrame = computed(() => spinnerFrames[Math.floor(elapsed.value / 80) % 4]);
let clock = new PlaybackClock(props.demo.duration);
let wantsToPlay = false;
let visible = false;
let mounted = false;
let frame = 0;
let pendingUntil = 0;
let observer: IntersectionObserver | undefined;

function report(now: number) {
  elapsed.value = clock.read(now);
  emit('progress', {
    time: elapsed.value,
    playing: wantsToPlay,
    countdown: pendingUntil ? Math.max(0, Math.ceil((pendingUntil - now) / 1000)) : 0,
  });
}

function tick(now: number) {
  frame = 0;
  if (pendingUntil && now >= pendingUntil) {
    pendingUntil = 0;
    clock.play(now);
  }
  report(now);
  if (elapsed.value >= props.demo.duration) {
    clock.pause(now);
    wantsToPlay = false;
    report(now);
    emit('complete');
    return;
  }
  if (wantsToPlay && visible && !document.hidden) {
    frame = requestAnimationFrame(tick);
  }
}

function reconcile() {
  if (!mounted) {
    return;
  }
  const now = performance.now();
  if (frame) {
    cancelAnimationFrame(frame);
  }
  frame = 0;
  if (wantsToPlay && visible && !document.hidden) {
    if (!pendingUntil) {
      clock.play(now);
    }
    frame = requestAnimationFrame(tick);
  } else {
    clock.pause(now);
  }
  report(now);
}

function replay(delay = 0) {
  if (!mounted) {
    return;
  }
  const now = performance.now();
  clock.pause(now);
  clock.seek(0, now);
  pendingUntil = delay > 0 ? now + delay : 0;
  wantsToPlay = true;
  reconcile();
}

function toggle() {
  if (wantsToPlay) {
    wantsToPlay = false;
    pendingUntil = 0;
    reconcile();
  } else if (elapsed.value >= props.demo.duration) {
    replay();
  } else {
    wantsToPlay = true;
    reconcile();
  }
}

function seek(time: number) {
  wantsToPlay = false;
  pendingUntil = 0;
  clock.pause(performance.now());
  clock.seek(time, performance.now());
  reconcile();
}

defineExpose({ replay, toggle, seek });

watch(
  () => props.demo.id,
  () => {
    clock = new PlaybackClock(props.demo.duration);
    clock.setSpeed(props.speed, performance.now());
    if (props.reducedMotion || !props.autoplay) {
      seek(props.demo.duration);
    } else {
      replay();
    }
  },
);
watch(
  () => props.speed,
  (speed) => {
    clock.setSpeed(speed, performance.now());
    reconcile();
  },
);
watch(
  () => props.reducedMotion,
  (reduce) => {
    if (reduce) {
      seek(props.demo.duration);
    }
  },
);
watch(lines, async () => {
  await nextTick();
  if (viewport.value) {
    viewport.value.scrollTop = viewport.value.scrollHeight;
  }
});

onMounted(() => {
  mounted = true;
  clock.setSpeed(props.speed, performance.now());
  if (props.reducedMotion || !props.autoplay) {
    clock.seek(props.demo.duration, performance.now());
  } else {
    clock.seek(0, performance.now());
    wantsToPlay = true;
  }
  if (typeof IntersectionObserver === 'undefined') {
    visible = true;
  } else {
    observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        reconcile();
      },
      { threshold: 0.1 },
    );
    if (terminal.value) {
      observer.observe(terminal.value);
    }
  }
  document.addEventListener('visibilitychange', reconcile);
  reconcile();
});

onBeforeUnmount(() => {
  mounted = false;
  if (frame) {
    cancelAnimationFrame(frame);
  }
  observer?.disconnect();
  document.removeEventListener('visibilitychange', reconcile);
});
</script>

<template>
  <div
    ref="terminal"
    class="void-terminal"
    :class="{ 'void-terminal--home': appearance === 'home' }"
    :data-demo="demo.id"
  >
    <div v-if="appearance === 'studio'" class="void-terminal-bar" aria-hidden="true">
      <span class="void-terminal-dots"><i /><i /><i /></span>
      <span class="void-terminal-directory">{{ demo.directory }}</span>
      <span class="void-terminal-wordmark">void</span>
    </div>
    <div ref="viewport" class="void-terminal-viewport" aria-hidden="true">
      <div class="void-terminal-output">
        <div
          v-for="line in renderedLines"
          :key="line.id"
          class="void-terminal-line"
          :class="line.box && ['void-terminal-box-line', 'void-terminal-box-' + line.box]"
          :style="line.box ? { '--box-columns': line.columns } : undefined"
        >
          <span v-if="line.spinner" class="tone-blue">{{ spinnerFrame + ' ' }}</span
          ><span class="void-terminal-content"
            ><span
              v-for="(segment, index) in line.segments"
              :key="index"
              :class="['tone-' + (segment.tone || 'base'), { 'terminal-bold': segment.bold }]"
              >{{ segment.text }}</span
            ></span
          ><span v-if="line.caret" class="void-terminal-caret" />
        </div>
      </div>
    </div>
    <p class="terminal-sr-only">
      {{ frontmatter.homeI18n?.terminal_example ?? 'Animated example:' }} {{ demo.command }}.
      {{ demo.description }}
      {{
        frontmatter.homeI18n?.terminal_transcript ?? 'A complete transcript follows the player.'
      }}
    </p>
  </div>
</template>

<style scoped>
.void-terminal {
  --terminal-base: #e5e7ef;
  --terminal-muted: #8c91a4;
  --terminal-blue: #8c9fff;
  --terminal-green: #a8c98b;
  --terminal-yellow: #e8c480;
  --terminal-red: #ef9294;
  width: 100%;
  overflow: hidden;
  border: 1px solid #ffffff24;
  border-radius: 12px;
  background: #15171d;
  box-shadow:
    0 24px 64px #00000026,
    0 2px 8px #00000015;
  color: var(--terminal-base);
  text-align: left;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-variant-ligatures: none;
  -webkit-font-smoothing: antialiased;
}
.void-terminal-bar {
  display: flex;
  align-items: center;
  gap: 18px;
  height: 48px;
  padding: 0 24px;
  border-bottom: 1px solid #ffffff0d;
  background: #ffffff03;
  color: var(--terminal-muted);
  font-size: 11px;
}
.void-terminal-dots {
  display: flex;
  gap: 7px;
}
.void-terminal-dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #454852;
}
.void-terminal-directory {
  flex: 1;
}
.void-terminal-wordmark {
  color: #c8ccd8;
  font-weight: 600;
  letter-spacing: -0.06em;
  font-size: 15px;
}
.void-terminal-viewport {
  height: 520px;
  overflow: auto;
  scrollbar-width: none;
  overscroll-behavior: contain;
}
.void-terminal-viewport::-webkit-scrollbar {
  display: none;
}
.void-terminal-output {
  padding: 25px 30px 32px;
}
.void-terminal-line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-height: 22px;
  line-height: 22px;
  font-size: 13px;
  letter-spacing: 0;
}
.void-terminal-box-line {
  position: relative;
  width: calc(var(--box-columns) * 1ch);
  white-space: pre;
}
.void-terminal-box-line::before {
  content: '';
  position: absolute;
  inset: 0 0.5ch;
  border-left: 1px solid var(--terminal-muted);
  border-right: 1px solid var(--terminal-muted);
}
.void-terminal-box-top::before {
  top: 50%;
  border-top: 1px solid var(--terminal-muted);
  border-radius: 4px 4px 0 0;
}
.void-terminal-box-bottom::before {
  bottom: 50%;
  border-bottom: 1px solid var(--terminal-muted);
  border-radius: 0 0 4px 4px;
}
.void-terminal-box-line .void-terminal-content {
  position: relative;
  margin-left: 3ch;
}
.void-terminal-box-top .void-terminal-content {
  margin-left: 2.5ch;
  padding: 0 0.5ch;
  background: #15171d;
}
.tone-base {
  color: var(--terminal-base);
}
.tone-muted {
  color: var(--terminal-muted);
}
.tone-blue {
  color: var(--terminal-blue);
}
.tone-green {
  color: var(--terminal-green);
}
.tone-yellow {
  color: var(--terminal-yellow);
}
.tone-red {
  color: var(--terminal-red);
}
.terminal-bold {
  font-weight: 700;
}
.void-terminal-caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  vertical-align: -3px;
  background: #cbd2ff;
}
.terminal-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (min-width: 1100px) {
  .void-terminal-line {
    font-size: 14px;
    line-height: 24px;
    min-height: 24px;
  }
  .void-terminal-viewport {
    height: 560px;
  }
}
@media (max-width: 640px) {
  .void-terminal-bar {
    padding: 0 18px;
    height: 42px;
  }
  .void-terminal-output {
    padding: 20px 16px;
  }
  .void-terminal-line {
    font-size: 10px;
    line-height: 20px;
    min-height: 20px;
  }
  .void-terminal-viewport {
    height: 460px;
  }
}

.void-terminal--home {
  --terminal-base: #ffffff;
  --terminal-muted: #aaa6b2;
  --terminal-green: #22ff73;
  height: 100%;
  border: 0;
  border-radius: 0;
  background: #111111;
  box-shadow: none;
  font-family: var(--font-mono);
}
.void-terminal--home .void-terminal-viewport {
  height: 100%;
  overflow: hidden;
  overscroll-behavior: auto;
}
.void-terminal--home .void-terminal-output {
  padding: 24px 32px;
}
.void-terminal--home .void-terminal-line {
  font-size: 14px;
  line-height: 22px;
  min-height: 22px;
}
.void-terminal--home .void-terminal-box-top .void-terminal-content {
  background: #111111;
}
@media (max-width: 640px) {
  .void-terminal--home .void-terminal-output {
    padding: 20px 16px;
  }
  .void-terminal--home .void-terminal-line {
    font-size: 11px;
    line-height: 19px;
    min-height: 19px;
  }
}
</style>
