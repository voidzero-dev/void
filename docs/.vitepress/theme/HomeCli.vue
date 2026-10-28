<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { useData } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { terminalDemos } from './terminal/demos.ts';
import TerminalPlayer from './terminal/TerminalPlayer.vue';
import { terminalFrame } from './terminal/timeline.ts';

const { frontmatter } = useData();
const i18n = computed(() => frontmatter.value.homeI18n ?? {});
const selected = ref('deploy');
const reducedMotion = ref(false);
const autoAdvance = ref(true);
const stage = ref<HTMLElement | null>(null);
const player = ref<InstanceType<typeof TerminalPlayer> | null>(null);
const state = ref({ time: 0, playing: false });
const demo = computed(() => ({
  ...terminalDemos.find((item) => item.id === selected.value)!,
  ...i18n.value.cli_demos?.[selected.value],
}));
const tabs = [
  { id: 'deploy', label: 'deploy' },
  { id: 'install', label: 'platform' },
  { id: 'recover', label: 'logs' },
];
const transcript = computed(() =>
  terminalFrame(demo.value, demo.value.duration)
    .map((line) => line.segments.map((segment) => segment.text).join(''))
    .join('\n'),
);
const playbackLabel = computed(() =>
  state.value.playing || autoAdvance.value
    ? (i18n.value.pause_demo ?? 'Pause demo')
    : state.value.time >= demo.value.duration
      ? (i18n.value.replay_demo ?? 'Replay demo')
      : (i18n.value.play_demo ?? 'Play demo'),
);
let advanceTimer: ReturnType<typeof setTimeout> | undefined;
let motionQuery: MediaQueryList | undefined;
let observer: IntersectionObserver | undefined;
let visible = false;

function clearAdvance() {
  clearTimeout(advanceTimer);
  advanceTimer = undefined;
}

function choose(value: string | number) {
  clearAdvance();
  autoAdvance.value = false;
  selected.value = String(value);
}

function completed() {
  clearAdvance();
  if (!autoAdvance.value || reducedMotion.value) {
    return;
  }
  advanceTimer = setTimeout(() => {
    if (document.hidden || !visible) {
      return;
    }
    const index = terminalDemos.findIndex((item) => item.id === selected.value);
    selected.value = terminalDemos[(index + 1) % terminalDemos.length].id;
  }, 3000);
}

function resumeAdvance() {
  if (visible && !document.hidden && state.value.time >= demo.value.duration) {
    completed();
  }
}

function togglePlayback() {
  const waiting = autoAdvance.value && state.value.time >= demo.value.duration;
  autoAdvance.value = false;
  clearAdvance();
  if (!waiting) {
    player.value?.toggle();
  }
}

function syncMotion() {
  reducedMotion.value = motionQuery?.matches ?? false;
  if (reducedMotion.value) {
    autoAdvance.value = false;
    clearAdvance();
  }
}

onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  syncMotion();
  motionQuery.addEventListener('change', syncMotion);
  observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) {
      resumeAdvance();
    } else {
      clearAdvance();
    }
  });
  if (stage.value) {
    observer.observe(stage.value);
  }
  document.addEventListener('visibilitychange', resumeAdvance);
});

onBeforeUnmount(() => {
  clearAdvance();
  motionQuery?.removeEventListener('change', syncMotion);
  observer?.disconnect();
  document.removeEventListener('visibilitychange', resumeAdvance);
});
</script>

<template>
  <section id="cli" class="cli-section" data-theme="dark" aria-labelledby="cli-heading">
    <div class="wrapper border-t border-nickel cli-heading">
      <a
        :href="i18n.cli_link ?? '/reference/cli'"
        class="cli-wordmark"
        :aria-label="i18n.cli_label ?? 'Void CLI reference'"
      >
        <img src="/void-cli.svg" alt="" width="536" height="113" />
      </a>
      <h2 id="cli-heading" class="text-white">
        {{ i18n.cli_heading ?? 'Deploy with One Command' }}
      </h2>
      <p>
        {{
          i18n.cli_description ??
          'Handle the full lifecycle of your project: building, deploying and managing your resources.'
        }}
      </p>
    </div>

    <div ref="stage" class="wrapper border-t border-nickel terminal-background cli-stage">
      <TabsRoot :model-value="selected" class="cli-terminal" @update:model-value="choose">
        <TabsContent :key="demo.id" :value="demo.id" class="cli-panel">
          <TerminalPlayer
            ref="player"
            :demo="demo"
            :reduced-motion="reducedMotion"
            appearance="home"
            @progress="state = $event"
            @complete="completed"
          />
          <div class="cli-sr-only">
            <p>{{ demo.context }}</p>
            <pre>{{ transcript }}</pre>
          </div>
        </TabsContent>

        <div class="cli-controls">
          <TabsList :aria-label="i18n.cli_commands_label ?? 'Void CLI commands'" class="cli-tabs">
            <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id">
              {{ tab.label }}
            </TabsTrigger>
          </TabsList>
          <button
            type="button"
            class="cli-playback"
            :aria-label="playbackLabel"
            :title="playbackLabel"
            @click="togglePlayback"
          >
            <Icon
              :icon="
                state.playing || autoAdvance
                  ? 'lucide:pause'
                  : state.time >= demo.duration
                    ? 'lucide:rotate-ccw'
                    : 'lucide:play'
              "
              width="15"
              height="15"
              aria-hidden="true"
            />
          </button>
        </div>
      </TabsRoot>
    </div>
  </section>
</template>

<style scoped>
.cli-section {
  background: var(--color-primary);
  color: var(--color-white);
}
.cli-heading {
  display: flex;
  min-height: 320px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  padding: 64px 24px;
  text-align: center;
}
.cli-wordmark {
  display: inline-flex;
  width: 100px;
}
.cli-wordmark img {
  width: 100%;
  height: auto;
}
.cli-heading p {
  max-width: 450px;
  color: #ffffffb3;
  text-wrap: pretty;
}
.cli-stage {
  display: flex;
  justify-content: center;
  height: 640px;
  padding: 112px 40px 0;
  background-color: var(--color-wine);
  overflow: clip;
}
.cli-terminal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 992px;
  min-width: 0;
  border-radius: 8px 8px 0 0;
  background: #111111;
  outline: 1px solid #ffffff4d;
  outline-offset: 3px;
  overflow: hidden;
}
.cli-panel {
  flex: 1;
  min-height: 0;
}
.cli-controls {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 12px;
  padding: 16px 24px 24px;
}
.cli-tabs {
  display: flex;
  align-items: center;
  padding: 4px;
  border: 1px solid #ffffff1a;
  border-radius: 6px;
  white-space: nowrap;
}
.cli-tabs :deep([role='tab']) {
  color: #aaa6b2;
}
.cli-tabs :deep([data-state='active']) {
  color: #111111;
}
.cli-playback {
  position: absolute;
  right: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid #ffffff1a;
  border-radius: 5px;
  color: #aaa6b2;
  cursor: pointer;
}
.cli-playback:hover {
  color: #ffffff;
  border-color: #ffffff4d;
}
.cli-section :is(a, button, [role='tabpanel']):focus-visible {
  outline: 2px solid #8c9fff;
  outline-offset: 4px;
}
.cli-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 767px) {
  .cli-heading {
    min-height: 280px;
    padding: 56px 24px;
    gap: 20px;
  }
  .cli-stage {
    height: 528px;
    padding: 40px 16px 0;
  }
  .cli-controls {
    gap: 8px;
    padding: 16px 8px 20px;
  }
  .cli-tabs :deep([role='tab']) {
    padding: 6px;
    font-size: 11px;
  }
  .cli-playback {
    position: static;
    flex-shrink: 0;
  }
}
</style>
