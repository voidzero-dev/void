<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { terminalDemos } from '../../docs/.vitepress/theme/terminal/demos.ts';
import TerminalPlayer from '../../docs/.vitepress/theme/terminal/TerminalPlayer.vue';
import { playbackSpeeds, terminalFrame } from '../../docs/.vitepress/theme/terminal/timeline.ts';

const props = withDefaults(defineProps<{ studio?: boolean }>(), { studio: false });
const selected = ref('deploy');
const speed = ref(1);
const loop = ref(!props.studio);
const capture = ref(false);
const reducedMotion = ref(false);
const player = ref<InstanceType<typeof TerminalPlayer> | null>(null);
const state = ref({ time: 0, playing: false, countdown: 0 });
const demo = computed(
  () => terminalDemos.find((item) => item.id === selected.value) ?? terminalDemos[0],
);
const transcript = computed(() =>
  terminalFrame(demo.value, demo.value.duration)
    .map(
      (line) => (line.spinner ? '◇ ' : '') + line.segments.map((segment) => segment.text).join(''),
    )
    .join('\n'),
);
const progress = computed(() => (state.value.time / demo.value.duration) * 100);
const seconds = (ms: number) => (ms / 1000).toFixed(1) + 's';
let advanceTimer: ReturnType<typeof setTimeout> | undefined;
let mediaQuery: MediaQueryList | undefined;

function clearAdvance() {
  clearTimeout(advanceTimer);
  advanceTimer = undefined;
}
function syncUrl() {
  if (!props.studio) {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set('demo', selected.value);
  url.searchParams.set('speed', String(speed.value));
  if (capture.value) {
    url.searchParams.set('capture', '1');
  } else {
    url.searchParams.delete('capture');
  }
  history.replaceState(null, '', url);
}
function choose(id: string) {
  clearAdvance();
  selected.value = id;
  syncUrl();
}
async function moveTab(event: KeyboardEvent, index: number, direction: number) {
  const tabs = (event.currentTarget as HTMLElement | null)?.parentElement;
  choose(terminalDemos[(index + direction + terminalDemos.length) % terminalDemos.length].id);
  await nextTick();
  tabs?.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus();
}
function completed() {
  clearAdvance();
  if (!loop.value || reducedMotion.value || capture.value) {
    return;
  }
  advanceTimer = setTimeout(() => {
    const index = terminalDemos.findIndex((item) => item.id === selected.value);
    choose(terminalDemos[(index + 1) % terminalDemos.length].id);
  }, 3000);
}
function toggle() {
  clearAdvance();
  player.value?.toggle();
}
function replay() {
  clearAdvance();
  player.value?.replay(capture.value ? 3000 : 0);
}
function showFinal() {
  clearAdvance();
  player.value?.seek(demo.value.duration);
}
function seek(event: Event) {
  clearAdvance();
  player.value?.seek(Number((event.target as HTMLInputElement).value));
}
function startCapture() {
  clearAdvance();
  capture.value = true;
  loop.value = false;
  syncUrl();
  player.value?.replay(3000);
}
function exitCapture() {
  capture.value = false;
  syncUrl();
}
function shortcut(event: KeyboardEvent) {
  if (!props.studio || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (event.key === 'Escape' && capture.value) {
    event.preventDefault();
    exitCapture();
    return;
  }
  const target = event.target as HTMLElement;
  if (target.closest('input, select, textarea, button, a, [contenteditable="true"]')) {
    return;
  }
  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    replay();
  } else if (event.code === 'Space') {
    event.preventDefault();
    toggle();
  }
}
function syncMotion() {
  reducedMotion.value = mediaQuery?.matches ?? false;
  if (reducedMotion.value) {
    clearAdvance();
    loop.value = false;
  }
}
onMounted(() => {
  mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  syncMotion();
  mediaQuery.addEventListener('change', syncMotion);
  if (props.studio) {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('demo');
    if (terminalDemos.some((item) => item.id === requested)) {
      selected.value = requested!;
    }
    const rate = Number(params.get('speed'));
    if (playbackSpeeds.some((allowed) => allowed === rate)) {
      speed.value = rate;
    }
    capture.value = params.get('capture') === '1';
    window.addEventListener('keydown', shortcut);
  }
});
onBeforeUnmount(() => {
  clearAdvance();
  mediaQuery?.removeEventListener('change', syncMotion);
  window.removeEventListener('keydown', shortcut);
});
</script>

<template>
  <section
    :id="studio ? undefined : 'terminal'"
    class="void-demos"
    :class="{ 'void-demos-studio': studio, 'void-demos-capture': capture }"
  >
    <div class="demos-container">
      <header v-if="!capture" class="demos-header">
        <div>
          <p class="demos-eyebrow">Void / {{ studio ? 'Terminal studio' : 'In your terminal' }}</p>
          <h2>
            {{ studio ? 'See what shipping feels like.' : 'A few commands. A lot of possibility.' }}
          </h2>
        </div>
        <p class="demos-intro">
          {{
            studio
              ? 'Three workflows, ready to replay and record.'
              : 'Build, deploy, and manage your apps from one place. Your terminal.'
          }}
        </p>
      </header>
      <div v-if="!capture" class="demos-tabs" role="tablist" aria-label="Void terminal examples">
        <button
          v-for="(item, index) in terminalDemos"
          :id="'demo-tab-' + item.id"
          :key="item.id"
          type="button"
          role="tab"
          :aria-selected="selected === item.id"
          :aria-controls="'demo-panel-' + item.id"
          :tabindex="selected === item.id ? 0 : -1"
          @click="choose(item.id)"
          @keydown.right.prevent="moveTab($event, index, 1)"
          @keydown.left.prevent="moveTab($event, index, -1)"
        >
          <span class="demos-tab-index">0{{ index + 1 }}</span>{{ item.label }}
        </button>
      </div>
      <div
        :id="'demo-panel-' + demo.id"
        role="tabpanel"
        :aria-labelledby="capture ? undefined : 'demo-tab-' + demo.id"
      >
        <div v-if="!capture" class="demo-caption">
          <div>
            <h3>{{ demo.title }}</h3>
            <p>{{ demo.description }}</p>
          </div>
          <a v-if="!studio" :href="demo.link"
            >{{ demo.linkLabel }} <span aria-hidden="true">↗</span></a
          >
          <span v-else class="demo-duration"
            >{{ Math.ceil(demo.duration / 1000 / speed) }} second demo</span
          >
        </div>
        <TerminalPlayer
          ref="player"
          :demo="demo"
          :speed="speed"
          :reduced-motion="reducedMotion"
          @progress="state = $event"
          @complete="completed"
        />
      </div>
      <template v-if="!capture">
        <div class="demo-controls">
          <div class="demo-buttons">
            <button
              type="button"
              :aria-label="state.playing ? 'Pause demo' : 'Play demo'"
              @click="toggle"
            >
              <Icon :icon="state.playing ? 'lucide:pause' : 'lucide:play'" /><span>{{
                state.playing ? 'Pause' : 'Play'
              }}</span>
            </button>
            <button type="button" aria-label="Replay demo" @click="replay">
              <Icon icon="lucide:rotate-ccw" /><span>Replay</span>
            </button>
            <button v-if="studio" type="button" @click="showFinal">
              <Icon icon="lucide:skip-forward" /><span>Final frame</span>
            </button>
          </div>
          <div class="demo-settings">
            <label
              >Speed<select v-model="speed" aria-label="Playback speed" @change="syncUrl">
                <option v-for="rate in playbackSpeeds" :key="rate" :value="rate">
                  {{ rate }}×
                </option>
              </select></label
            >
            <label class="demo-loop"
              ><input v-model="loop" type="checkbox" @change="clearAdvance" />Cycle demos</label
            >
          </div>
        </div>
        <div v-if="studio" class="demo-scrubber">
          <span>{{ seconds(state.time) }}</span
          ><input
            type="range"
            min="0"
            :max="demo.duration"
            :value="state.time"
            step="100"
            aria-label="Demo position"
            @input="seek"
          /><span>{{ seconds(demo.duration) }}</span>
        </div>
        <div v-else class="demo-progress" aria-hidden="true">
          <span :style="{ width: progress + '%' }" />
        </div>
        <div class="demo-footnote">
          <p>Illustrative demo · Sample data · Accelerated timing</p>
          <button v-if="studio" type="button" class="demo-record" @click="startCapture">
            <Icon icon="lucide:scan" />Clean capture <span aria-hidden="true">↗</span>
          </button>
        </div>
        <div v-if="studio" class="demo-capture-help">
          <p>
            <strong>Ready for CleanShot.</strong> Clean capture hides this page’s controls and
            starts playback after 3 seconds. Record the terminal area. Press <kbd>R</kbd> to replay,
            <kbd>Space</kbd> to pause, and <kbd>Esc</kbd> to return.
          </p>
          <p class="demo-context">{{ demo.context }}</p>
        </div>
        <details class="demo-transcript">
          <summary>Read the transcript</summary>
          <pre>{{ transcript }}</pre>
        </details>
      </template>
      <button
        v-else
        type="button"
        class="demo-exit-capture"
        aria-label="Exit capture mode"
        @click="exitCapture"
      >
        <Icon icon="lucide:x" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.void-demos {
  background: #101116;
  color: #e9eaf1;
  padding: 88px 32px;
  border-block: 1px solid #ffffff14;
}
.demos-container {
  width: min(100%, 1040px);
  margin: 0 auto;
}
.demos-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 40px;
  margin-bottom: 42px;
}
.demos-eyebrow {
  margin: 0 0 18px;
  color: #a0a6b8;
  font-family: monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.demos-header h2 {
  margin: 0;
  max-width: 620px;
  font-size: clamp(30px, 4vw, 46px);
  line-height: 1.12;
  font-weight: 500;
  letter-spacing: -0.045em;
  color: #f0f1f6;
}
.demos-intro {
  max-width: 245px;
  margin: 0 0 3px;
  color: #959bac;
  font-size: 14px;
  line-height: 1.7;
}
.demos-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #ffffff1a;
  margin-bottom: 27px;
}
.demos-tabs button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px 16px 0;
  margin-right: 25px;
  border-bottom: 2px solid transparent;
  color: #9298aa;
  font-size: 14px;
  cursor: pointer;
}
.demos-tabs button[aria-selected='true'] {
  color: #e9ecff;
  border-bottom-color: #8c9fff;
}
.demos-tab-index {
  color: #737a8e;
  font-family: monospace;
  font-size: 11px;
}
.demos-tabs button[aria-selected='true'] .demos-tab-index {
  color: #8c9fff;
}
.demo-caption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 25px;
  min-height: 76px;
  margin-bottom: 20px;
}
.demo-caption h3 {
  margin: 0 0 7px;
  font-weight: 500;
  font-size: 20px;
  letter-spacing: -0.025em;
  color: #eeeef5;
}
.demo-caption p {
  margin: 0;
  color: #9298aa;
  font-size: 13px;
  line-height: 1.6;
  max-width: 650px;
}
.demo-caption a {
  white-space: nowrap;
  color: #a3b0ff;
  font-size: 13px;
  text-decoration: none;
}
.demo-duration {
  white-space: nowrap;
  font-family: monospace;
  font-size: 11px;
  color: #8c91a4;
}
.demo-controls {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  align-items: center;
  padding: 18px 0 12px;
}
.demo-buttons,
.demo-settings {
  display: flex;
  align-items: center;
  gap: 18px;
}
.demo-buttons button,
.demo-record {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #bdc3d1;
  font-size: 12px;
  cursor: pointer;
}
.demo-buttons svg,
.demo-record svg {
  width: 14px;
  height: 14px;
}
.demo-settings {
  gap: 20px;
  color: #9097a9;
  font-size: 11px;
}
.demo-settings label {
  display: flex;
  gap: 9px;
  align-items: center;
}
.demo-settings select {
  color: #d5d9e5;
  background: #1c1e27;
  border: 1px solid #ffffff1a;
  border-radius: 4px;
  padding: 3px 7px;
  font-size: 11px;
}
.demo-loop input {
  accent-color: #8c9fff;
}
.demo-progress {
  height: 2px;
  background: #ffffff0d;
  margin-top: 6px;
}
.demo-progress span {
  display: block;
  height: 100%;
  background: #8c9fff;
}
.demo-scrubber {
  display: flex;
  gap: 16px;
  align-items: center;
  padding-top: 10px;
  font-family: monospace;
  font-size: 10px;
  color: #8f96a9;
}
.demo-scrubber input {
  flex: 1;
  min-width: 0;
  height: 3px;
  accent-color: #8c9fff;
  cursor: pointer;
}
.demo-footnote {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 15px;
}
.demo-footnote p {
  margin: 0;
  font-size: 10px;
  color: #7a8194;
  letter-spacing: 0.02em;
}
.demo-record {
  color: #b2bfff;
}
.demo-capture-help {
  border-top: 1px solid #ffffff0d;
  margin-top: 25px;
  padding-top: 22px;
  color: #9298aa;
  font-size: 12px;
  line-height: 1.8;
}
.demo-capture-help p {
  margin: 0 0 12px;
  max-width: 830px;
}
.demo-capture-help strong {
  color: #cbd0de;
  font-weight: 500;
}
.demo-capture-help kbd {
  font-family: monospace;
  font-size: 10px;
  padding: 2px 4px;
  border: 1px solid #ffffff25;
  border-radius: 3px;
  color: #c2c9db;
}
.demo-context {
  color: #767f96;
}
.demo-transcript {
  margin-top: 22px;
  font-size: 11px;
  color: #8c94a9;
}
.demo-transcript summary {
  cursor: pointer;
  width: fit-content;
}
.demo-transcript pre {
  overflow: auto;
  margin-top: 16px;
  padding: 20px;
  background: #15171d;
  color: #b3bbce;
  font-size: 12px;
  line-height: 1.7;
  border-radius: 6px;
}
.void-demos-studio {
  min-height: 100vh;
  padding-block: 60px;
}
.void-demos-capture {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 40px;
  border: 0;
  min-height: 100dvh;
  overflow: auto;
  background: #101116;
}
.void-demos-capture .demos-container {
  width: min(100%, 1040px);
}
.demo-exit-capture {
  position: fixed;
  top: 16px;
  right: 16px;
  padding: 7px;
  border-radius: 6px;
  color: #8d96aa;
  opacity: 0;
  cursor: pointer;
}
.demo-exit-capture:hover,
.demo-exit-capture:focus-visible {
  opacity: 1;
}
.demo-exit-capture svg {
  width: 18px;
  height: 18px;
}
.void-demos button:focus-visible,
.void-demos a:focus-visible,
.void-demos input:focus-visible,
.void-demos select:focus-visible,
.void-demos summary:focus-visible {
  outline: 2px solid #a2b1ff;
  outline-offset: 5px;
}
@media (max-width: 740px) {
  .void-demos {
    padding: 48px 24px;
  }
  .demos-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
    margin-bottom: 28px;
  }
  .demos-intro {
    max-width: 400px;
  }
  .demos-tabs button {
    gap: 6px;
    padding-right: 10px;
    margin-right: 14px;
    font-size: 12px;
  }
  .demo-caption {
    align-items: flex-start;
    min-height: 96px;
  }
  .demo-caption a,
  .demo-duration {
    display: none;
  }
  .demo-controls {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .demo-buttons {
    gap: 14px;
  }
  .demo-settings {
    gap: 20px;
  }
  .demo-footnote {
    align-items: flex-start;
  }
  .void-demos-capture {
    padding: 20px;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    scroll-behavior: auto;
  }
}
</style>
