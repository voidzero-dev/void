<script setup lang="ts">
import RiveAnimation from '@components/shared/RiveAnimation.vue';
import { useData } from 'vitepress';
import { computed } from 'vue';
import frameworksAnimation from './assets/animations/640_x_320_vite_frameworks_diamond.riv';
import connectorsAnimation from './assets/animations/640_x_320_void_connectors.riv';
import StackAndShip from './game/StackAndShip.vue';

defineProps<{
  kind: 'stack' | 'frameworks';
}>();

const { frontmatter } = useData();
const descriptions = computed(() => ({
  stack:
    frontmatter.value.homeI18n?.visuals?.stack_description ??
    'Animated illustration of Void connectors.',
  frameworks:
    frontmatter.value.homeI18n?.visuals?.frameworks_description ??
    'Animated illustration of Void framework integrations.',
  frameworksGame:
    frontmatter.value.homeI18n?.visuals?.frameworks_game_label ??
    'Framework integrations and Stack & Ship game',
}));
</script>

<template>
  <div
    class="feature-visual"
    :class="`feature-visual--${kind}`"
    :role="kind === 'stack' ? 'img' : 'group'"
    :aria-label="kind === 'stack' ? descriptions[kind] : descriptions.frameworksGame"
  >
    <div v-if="kind === 'stack'" class="feature-animation">
      <RiveAnimation
        :desktop-src="connectorsAnimation"
        :desktop-width="640"
        :desktop-height="320"
        canvas-class="w-full h-auto"
      />
    </div>

    <StackAndShip v-else-if="kind === 'frameworks'" class="feature-animation">
      <RiveAnimation
        :desktop-src="frameworksAnimation"
        :desktop-width="640"
        :desktop-height="320"
        state-machines="State Machine 1"
        canvas-class="w-full h-auto"
      />
    </StackAndShip>
  </div>
</template>

<style scoped>
.feature-visual {
  display: grid;
  place-items: center;
  width: 100%;
  height: 17rem;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
}

.feature-visual--stack,
.feature-visual--frameworks {
  border: 0;
  background: transparent;
}

.feature-visual--frameworks {
  overflow: visible;
}

.feature-animation {
  width: 100%;
  max-width: 40rem;
}

@media (min-width: 768px) {
  .feature-visual {
    height: 20rem;
  }
}
</style>
