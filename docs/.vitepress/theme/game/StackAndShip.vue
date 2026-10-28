<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useData } from 'vitepress';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { frameworks } from './frameworks';
import {
  advanceStackGame,
  createStackGame,
  dropStackTile,
  LAYER_HEIGHT,
  type Tile,
} from './stack-and-ship';
import StackTile from './StackTile.vue';

const { frontmatter } = useData();
const i18n = computed(() => frontmatter.value.homeI18n?.game ?? {});

type Phase = 'idle' | 'playing' | 'paused' | 'over';
const phase = ref<Phase>('idle');
const game = shallowRef(createStackGame());
const best = ref(0);
const previousBest = ref(0);
const board = ref<HTMLButtonElement | null>(null);
const container = ref<HTMLElement | null>(null);
const fragment = shallowRef<Tile | null>(null);
const fragmentFall = ref(0);
const landingOffset = ref(0);
const feedback = ref('');
const layers = computed(() => game.value.tiles.length - 1);
const shareUrl = computed(
  () =>
    `https://x.com/intent/tweet?${new URLSearchParams({
      text: `I shipped a stack with ${layers.value} ${layers.value === 1 ? 'layer' : 'layers'}. Deploy Vite apps with Void. Check out void.cloud`,
    })}`,
);
const framework = computed(() => frameworks[game.value.moving?.framework ?? 0]?.name);
const top = computed(() => game.value.tiles[game.value.tiles.length - 1]!);
const originX = computed(
  () => 320 - (top.value.x + top.value.width / 2 - top.value.z - top.value.depth / 2) * 0.8,
);
const originY = computed(
  () =>
    250 +
    Math.max(0, layers.value * LAYER_HEIGHT - 75) -
    (top.value.x + top.value.width / 2 + top.value.z + top.value.depth / 2) * 0.36,
);
const visibleTiles = computed(() => game.value.tiles.slice(-20));
const STORAGE_KEY = 'void:stack-and-ship:best';
let frame = 0;
let lastFrame = 0;
let droppedAt = -Infinity;
let nextTileAt = 0;
let observer: IntersectionObserver | undefined;

function saveBest() {
  if (game.value.score <= best.value) {
    return;
  }
  best.value = game.value.score;
  try {
    localStorage.setItem(STORAGE_KEY, String(best.value));
  } catch {
    /* Play also works without storage. */
  }
}

function animate(now: number) {
  frame = 0;
  const elapsed = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const sinceDrop = Math.max(0, now - droppedAt);
  landingOffset.value = -36 * (1 - Math.min(1, sinceDrop / 160)) ** 2;
  fragmentFall.value = Math.min(900, (sinceDrop / 1000) ** 2 * 1000);
  if (sinceDrop > 900) {
    fragment.value = null;
  }
  if (sinceDrop > 850) {
    feedback.value = '';
  }
  if (phase.value === 'playing' && now >= nextTileAt) {
    game.value = advanceStackGame(game.value, elapsed);
  }
  if (phase.value === 'playing' || (phase.value === 'over' && fragment.value)) {
    frame = requestAnimationFrame(animate);
  }
}

function runFrames() {
  cancelAnimationFrame(frame);
  lastFrame = performance.now();
  frame = requestAnimationFrame(animate);
}

async function start() {
  game.value = createStackGame();
  previousBest.value = best.value;
  fragment.value = null;
  feedback.value = '';
  landingOffset.value = 0;
  droppedAt = -Infinity;
  nextTileAt = 0;
  phase.value = 'playing';
  runFrames();
  await nextTick();
  board.value?.focus({ preventScroll: true });
}

function drop(event?: KeyboardEvent | MouseEvent) {
  if (event instanceof KeyboardEvent && event.repeat) {
    return;
  }
  if (phase.value !== 'playing' || performance.now() < nextTileAt) {
    return;
  }
  // Sample at the input time, rather than relying on the previous rendered frame.
  const now = performance.now();
  game.value = advanceStackGame(game.value, Math.min(0.05, (now - lastFrame) / 1000));
  lastFrame = now;
  const result = dropStackTile(game.value);
  game.value = result.game;
  fragment.value = result.fragment;
  droppedAt = now;
  nextTileAt = now + 220;
  landingOffset.value = -36;
  feedback.value = result.perfect
    ? `${i18n.value.perfect ?? 'Perfect'}${game.value.combo > 1 ? ` · ${Math.min(game.value.combo, 5)}×` : '!'}`
    : '';
  saveBest();
  if (!game.value.moving) {
    phase.value = 'over';
  }
}

function pause() {
  if (phase.value !== 'playing') {
    return;
  }
  phase.value = 'paused';
  cancelAnimationFrame(frame);
  frame = 0;
}

async function resume() {
  phase.value = 'playing';
  runFrames();
  await nextTick();
  board.value?.focus({ preventScroll: true });
}

function close() {
  phase.value = 'idle';
  cancelAnimationFrame(frame);
  frame = 0;
  nextTick(() =>
    container.value?.querySelector<HTMLButtonElement>('.game-play')?.focus({ preventScroll: true }),
  );
}

function visibilityChanged() {
  if (document.hidden) {
    pause();
  }
}

onMounted(() => {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isSafeInteger(stored) && stored >= 0) {
      best.value = stored;
    }
  } catch {
    /* Storage is optional. */
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries[0]?.isIntersecting) {
        pause();
      }
    },
    { threshold: 0.15 },
  );
  if (container.value) {
    observer.observe(container.value);
  }
  document.addEventListener('visibilitychange', visibilityChanged);
});

onUnmounted(() => {
  cancelAnimationFrame(frame);
  observer?.disconnect();
  document.removeEventListener('visibilitychange', visibilityChanged);
});
</script>

<template>
  <div id="stack-and-ship" ref="container" class="stack-and-ship" @keydown.esc.stop="close">
    <Transition name="artwork-fade">
      <div v-if="phase === 'idle'" class="game-idle"><slot /></div>
    </Transition>
    <button v-if="phase === 'idle'" class="game-button game-play" type="button" @click="start">
      <Icon icon="lucide:play" class="size-3.5" aria-hidden="true" />
      {{ i18n.play ?? 'Play Stack & Ship' }}
    </button>
    <Transition name="artwork-fade">
      <div v-if="phase !== 'idle'" class="game-live">
        <div class="game-header">
          <span class="game-layers"
            >{{ layers }}
            <span class="game-muted">{{
              layers === 1 ? (i18n.layer ?? 'layer') : (i18n.layers ?? 'layers')
            }}</span></span
          >
          <span class="game-score"
            ><span class="game-muted">{{ i18n.score ?? 'Score' }}</span> {{ game.score }}</span
          >
          <span class="game-best"
            ><span class="game-muted">{{ i18n.best ?? 'Best' }}</span> {{ best }}</span
          >
          <button
            class="game-close"
            type="button"
            :aria-label="i18n.close_aria ?? 'Close game'"
            @click="close"
          >
            <Icon icon="lucide:x" class="size-4" aria-hidden="true" />
          </button>
        </div>
        <button
          ref="board"
          class="game-board"
          type="button"
          :aria-label="
            (
              i18n.drop_aria ?? 'Drop the {framework} tile. Tap, press Space, or press Enter.'
            ).replace('{framework}', String(framework))
          "
          :disabled="phase !== 'playing'"
          @click="drop"
          @keydown.space.prevent="drop"
          @keydown.enter.prevent="drop"
        >
          <svg class="game-scene" viewBox="0 0 640 400" aria-hidden="true">
            <defs>
              <filter id="stack-soft-shadow" x="-30%" y="-50%" width="160%" height="200%">
                <feGaussianBlur stdDeviation="4" />
              </filter>
            </defs>
            <g v-for="tile in visibleTiles" :key="tile.level">
              <StackTile
                :tile="tile"
                :origin-x="originX"
                :origin-y="originY"
                :offset-y="tile.level === layers ? landingOffset : 0"
                :perfect="tile.level === layers && feedback.length > 0"
              />
            </g>
            <StackTile
              v-if="fragment"
              :tile="fragment"
              :origin-x="originX"
              :origin-y="originY"
              :offset-y="fragmentFall"
            />
            <StackTile
              v-if="game.moving && landingOffset > -1"
              :tile="game.moving"
              :origin-x="originX"
              :origin-y="originY"
              :offset-y="-36"
            />
          </svg>
        </button>
        <div v-if="phase === 'playing'" class="game-footer">
          <span class="game-hint"
            >{{ i18n.hint_before_key ?? 'Tap or press' }} <kbd>{{ i18n.hint_key ?? 'Space' }}</kbd>
            {{ i18n.hint_after_key ?? 'to drop' }}</span
          >
          <button
            class="game-pause"
            type="button"
            :aria-label="i18n.pause_aria ?? 'Pause game'"
            @click="pause"
          >
            <Icon icon="lucide:pause" class="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <span :key="layers" class="game-feedback" role="status" aria-live="polite">{{
          feedback
        }}</span>
        <div v-if="phase === 'paused' || phase === 'over'" class="game-receipt" role="status">
          <template v-if="phase === 'over'">
            <span class="game-receipt-label"
              >{{ game.score > previousBest ? (i18n.new_best ?? 'New personal best · ') : ''
              }}{{
                (i18n.shipped ?? 'Shipped {layers} {unit}.')
                  .replace('{layers}', String(layers))
                  .replace(
                    '{unit}',
                    layers === 1 ? (i18n.layer ?? 'layer') : (i18n.layers ?? 'layers'),
                  )
              }}</span
            >
            <div class="game-receipt-actions">
              <button class="game-button" type="button" @click="start">
                {{ i18n.restart ?? 'Ship another stack' }}
                <Icon icon="lucide:rotate-ccw" class="size-3.5" aria-hidden="true" />
              </button>
              <a
                class="game-button"
                :href="shareUrl"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="i18n.share_aria ?? 'Share your stack on X (opens in a new tab)'"
              >
                {{ i18n.share ?? 'Share' }}
                <Icon icon="lucide:share-2" class="size-3.5" aria-hidden="true" />
              </a>
            </div>
          </template>
          <template v-else>
            <span class="game-receipt-label">{{
              i18n.paused ?? 'Paused · Your stack is safe'
            }}</span>
            <button class="game-button" type="button" @click="resume">
              {{ i18n.resume ?? 'Keep stacking' }}
              <Icon icon="lucide:play" class="size-3.5" aria-hidden="true" />
            </button>
          </template>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.stack-and-ship {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 16rem;
  isolation: isolate;
  font-family: var(--font-sans);
}
.stack-and-ship:focus {
  outline: none;
}
.game-idle {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: center;
}
.artwork-fade-enter-active,
.artwork-fade-leave-active {
  transition: opacity 200ms ease;
}
.artwork-fade-enter-from,
.artwork-fade-leave-to {
  opacity: 0;
}
.game-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--color-white) 12%, transparent);
  border-radius: 8px;
  background: var(--color-nickel);
  color: var(--color-white);
  font: 12px var(--font-sans);
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--default-transition-duration)
    var(--default-transition-timing-function);
}
.game-button:hover {
  background: var(--color-grey);
}
.game-play {
  position: absolute;
  bottom: -16px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
}
.game-live {
  position: absolute;
  inset: 0;
}
.game-header {
  position: absolute;
  z-index: 2;
  inset: 0 0 auto auto;
  display: flex;
  align-items: center;
  gap: 14px;
  pointer-events: none;
  color: var(--color-white);
  font: 10px var(--font-sans);
  font-variant-numeric: tabular-nums;
}
.game-muted {
  color: var(--color-grey);
}
.game-header > span {
  white-space: nowrap;
}
.game-close,
.game-pause {
  display: grid;
  place-items: center;
  padding: 4px;
  border: 0;
  background: transparent;
  color: var(--color-grey);
  cursor: pointer;
  pointer-events: auto;
}
.game-close:hover,
.game-pause:hover {
  color: var(--color-white);
}
.game-board {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  padding: 16px 0 48px;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.game-board:disabled {
  cursor: default;
}
.game-scene {
  width: 100%;
  height: 100%;
  display: block;
  overflow: hidden;
}
.game-footer {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  align-items: center;
  gap: 12px;
  pointer-events: none;
  color: var(--color-grey);
  font: 10px var(--font-sans);
}
.game-hint {
  margin-left: auto;
}
.game-footer kbd {
  font: inherit;
  color: var(--color-white);
}
.game-feedback {
  position: absolute;
  top: 52px;
  left: 0;
  width: 100%;
  text-align: center;
  pointer-events: none;
  color: var(--color-white);
  font: 12px var(--font-sans);
}
.game-receipt {
  position: absolute;
  bottom: -16px;
  left: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.game-receipt-label {
  color: var(--color-white);
  font: 10px var(--font-sans);
}
.game-receipt-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.stack-and-ship :is(button, a):not(.game-board):focus-visible {
  outline: 2px solid var(--color-white);
  outline-offset: -3px;
}
.stack-and-ship .game-board:focus,
.stack-and-ship .game-board:focus-visible {
  outline: none;
}
.game-live:has(.game-board:focus-visible) .game-hint kbd {
  text-decoration: underline;
  text-underline-offset: 3px;
}
@supports (corner-shape: squircle) {
  .game-button {
    border-radius: 20px;
  }
}
@media (max-width: 420px) {
  .game-header {
    gap: 8px;
    font-size: 10px;
  }
  .game-footer {
    gap: 8px;
  }
  .game-hint {
    font-size: 9px;
  }
}
</style>
