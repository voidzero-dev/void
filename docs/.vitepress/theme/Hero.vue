<script setup lang="ts">
import RiveAnimation from '@components/shared/RiveAnimation.vue';
import { useData } from 'vitepress';
import heroAnimation from './assets/animations/640_x_630_vite_to_void_box_vertical_v3.riv';

if (typeof document !== 'undefined') {
  const preload = document.createElement('link');
  preload.rel = 'preload';
  preload.href = heroAnimation;
  preload.as = 'fetch';
  preload.crossOrigin = 'anonymous';
  document.head.appendChild(preload);
}

const { frontmatter } = useData();
</script>

<template>
  <div
    v-if="frontmatter.hero"
    class="home-hero wrapper wrapper--ticks grid lg:grid-cols-2 w-full border-nickel md:divide-x"
  >
    <div class="flex flex-col p-15 sm:p-20 justify-between gap-20 items-center md:items-start">
      <div class="flex flex-col gap-5 items-center md:items-start text-center md:text-left">
        <a class="flex items-center gap-2" href="https://voidzero.dev" target="_blank">
          <span class="text-grey text-xs font-mono uppercase tracking-wide">{{
            frontmatter.homeI18n?.hero_by ?? 'By'
          }}</span>
          <img src="@assets/logos/voidzero-light.svg" alt="VoidZero" class="h-2.5" />
        </a>
        <h1 v-if="frontmatter.hero.text" class="text-white text-pretty max-w-[30rem]">
          {{ frontmatter.hero.text }}
        </h1>
        <p
          v-if="frontmatter.hero.tagline"
          class="text-white/70 md:text-lg max-w-[27rem] text-pretty"
        >
          {{ frontmatter.hero.tagline }}
        </p>
        <div class="flex flex-col min-[410px]:flex-row flex-wrap items-center gap-5 mt-8">
          <a
            v-for="action in frontmatter.hero.actions"
            :key="action.text"
            :href="action.link"
            :target="action.link?.startsWith('http') ? '_blank' : ''"
            class="button inline-block w-fit"
            :class="{ 'button--primary': action.theme === 'brand' }"
          >
            {{ action.text }}
          </a>
        </div>
      </div>
    </div>
    <div class="flex flex-col min-h-[22rem] sm:min-h-[30rem]">
      <div
        class="relative px-10 pb-10 md:pt-10 h-full flex flex-col justify-center overflow-clip"
        role="img"
        :aria-label="
          frontmatter.homeI18n?.hero_animation_label ??
          'Animation showing a Vite app becoming a Void app'
        "
      >
        <RiveAnimation
          :desktop-src="heroAnimation"
          :mobile-src="heroAnimation"
          :desktop-width="640"
          :desktop-height="630"
          :mobile-width="640"
          :mobile-height="630"
          canvas-class="w-full"
        />
      </div>
    </div>
  </div>
</template>
