<script setup lang="ts">
import { computed, useId } from 'vue';
import analogLogo from './assets/analog.svg';
import astroLogo from './assets/astro.svg';
import nuxtLogo from './assets/nuxt.svg';
import reactRouterLogo from './assets/react-router.svg';
import reactLogo from './assets/react.svg';
import solidLogo from './assets/solid.svg';
import svelteLogo from './assets/svelte.svg';
import tanstackLogo from './assets/tanstack.svg';
import sideLight from './assets/tile-side-light.webp';
import surface from './assets/tile-surface.webp';
import vueLogo from './assets/vue.svg';
import { frameworks } from './frameworks';
import { LAYER_HEIGHT } from './stack-and-ship';
import type { Tile } from './stack-and-ship';

const props = withDefaults(
  defineProps<{
    tile: Tile;
    originX: number;
    originY: number;
    offsetY?: number;
    perfect?: boolean;
  }>(),
  { offsetY: 0, perfect: false },
);
const id = useId().replaceAll(':', '');
const logos = {
  react: reactLogo,
  vue: vueLogo,
  svelte: svelteLogo,
  solid: solidLogo,
  analog: analogLogo,
  tanstack: tanstackLogo,
  'react-router': reactRouterLogo,
  astro: astroLogo,
  nuxt: nuxtLogo,
} satisfies Record<(typeof frameworks)[number]['id'], string>;
const framework = computed(() => frameworks[props.tile.framework]);
const accent = computed(() => framework.value?.color ?? 'var(--color-nickel)');
const logoSize = computed(() => Math.min(88, props.tile.width * 0.5, props.tile.depth * 0.5));
const radius = computed(() => Math.min(34, props.tile.width / 3, props.tile.depth / 3));
const depth = 24;
const sides = [depth, 20, 16, 12, 8, 4];
// The Rive hover paints these same light streaks over its colored side face.
// Keep them in screen space so they follow the extrusion, rather than the top plane.
const lightBounds = computed(() => ({
  x: props.originX + (props.tile.x - props.tile.z - props.tile.depth) * 0.8,
  y: props.originY - props.tile.level * LAYER_HEIGHT + (props.tile.x + props.tile.z) * 0.36,
  width: (props.tile.width + props.tile.depth) * 0.8,
  height: (props.tile.width + props.tile.depth) * 0.36 + depth,
}));
function plane(down = 0) {
  return `matrix(0.8 0.36 -0.8 0.36 ${props.originX} ${props.originY - props.tile.level * LAYER_HEIGHT + down})`;
}
</script>

<template>
  <g :transform="`translate(0 ${offsetY})`">
    <defs>
      <clipPath :id="`${id}-side`">
        <rect
          v-for="down in sides"
          :key="down"
          :x="tile.x"
          :y="tile.z"
          :width="tile.width"
          :height="tile.depth"
          :rx="radius"
          :transform="plane(down)"
        />
      </clipPath>
      <clipPath :id="`${id}-top`">
        <rect
          :x="tile.x"
          :y="tile.z"
          :width="tile.width"
          :height="tile.depth"
          :rx="radius"
          :transform="plane()"
        />
      </clipPath>
      <linearGradient :id="`${id}-rim`" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="var(--color-grey)" stop-opacity="0.65" />
        <stop offset="0.5" :stop-color="accent" :stop-opacity="perfect ? 1 : 0.4" />
        <stop offset="1" stop-color="var(--color-nickel)" stop-opacity="0.45" />
      </linearGradient>
    </defs>
    <rect
      :x="tile.x + 8"
      :y="tile.z + 8"
      :width="tile.width"
      :height="tile.depth"
      :rx="radius"
      :transform="plane(depth + 10)"
      fill="var(--color-midnight)"
      opacity="0.35"
      filter="url(#stack-soft-shadow)"
    />
    <g :clip-path="`url(#${id}-side)`" style="isolation: isolate">
      <rect v-bind="lightBounds" :fill="accent" />
      <image
        v-if="framework"
        :href="sideLight"
        :x="lightBounds.x - lightBounds.width * 0.07"
        :y="lightBounds.y - lightBounds.height * 0.1"
        :width="lightBounds.width * 1.14"
        :height="lightBounds.height * 1.2"
        preserveAspectRatio="none"
        style="mix-blend-mode: luminosity"
      />
    </g>
    <g :clip-path="`url(#${id}-top)`">
      <rect v-bind="lightBounds" fill="var(--color-midnight)" />
      <image
        :href="surface"
        :x="tile.x"
        :y="tile.z"
        :width="tile.width"
        :height="tile.depth"
        :transform="plane()"
        preserveAspectRatio="none"
      />
    </g>
    <rect
      :x="tile.x"
      :y="tile.z"
      :width="tile.width"
      :height="tile.depth"
      :rx="radius"
      :transform="plane()"
      fill="none"
      :stroke="`url(#${id}-rim)`"
      :stroke-width="perfect ? 3 : 1.8"
    />
    <image
      v-if="framework && logoSize > 18"
      :href="logos[framework.id]"
      :x="tile.x + (tile.width - logoSize) / 2"
      :y="tile.z + (tile.depth - logoSize) / 2"
      :width="logoSize"
      :height="logoSize"
      :transform="plane(-1)"
      opacity="0.95"
    />
    <text
      v-if="tile.framework < 0"
      :transform="plane(-1)"
      x="0"
      y="12"
      text-anchor="middle"
      fill="var(--color-white)"
      font-size="48"
      font-weight="700"
      font-family="Inter, sans-serif"
      >Void.</text
    >
  </g>
</template>
