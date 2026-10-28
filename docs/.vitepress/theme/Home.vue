<script setup>
import Footer from '@components/oss/Footer.vue';
import Spacer from '@components/shared/Spacer.vue';
import { useData } from 'vitepress';
import Hero from './Hero.vue';
import HomeCli from './HomeCli.vue';
import HomeFeatures from './HomeFeatures.vue';
import HomePlatform from './HomePlatform.vue';

const { frontmatter } = useData();
</script>

<template>
  <Hero />

  <Spacer />

  <HomeCli />

  <Spacer class="bg-primary" />

  <div class="platform-surface bg-white text-primary">
    <section
      class="wrapper border-t border-stroke px-5 sm:px-10 h-70 sm:h-80 flex flex-col justify-center items-center gap-5 text-center"
      aria-labelledby="full-stack-heading"
    >
      <a
        :href="frontmatter.homeI18n?.platform_link ?? '/guide/self-hosted-platform'"
        class="section-label-link"
        :aria-label="frontmatter.homeI18n?.platform_label ?? 'Self-host Void Platform guide'"
      >
        <img src="/void-platform-dark.svg" alt="" class="section-label" />
      </a>
      <h2 id="full-stack-heading" class="text-primary text-2xl md:text-[2.5rem]">
        {{ frontmatter.homeI18n?.platform_heading ?? 'Deploy with your Security Built-In' }}
      </h2>
      <p class="max-w-md text-pretty text-primary/70">
        {{
          frontmatter.homeI18n?.platform_description ??
          "Self-host your team's Void Platform & customize it to fit your security needs."
        }}
      </p>
    </section>

    <HomePlatform />
    <Spacer />
  </div>

  <section
    class="wrapper border-t border-nickel px-5 sm:px-10 h-70 sm:h-[22rem] flex flex-col justify-center gap-6 text-center items-center"
    aria-labelledby="features-heading"
  >
    <a
      :href="frontmatter.homeI18n?.sdk_link ?? '/guide/'"
      class="section-label-link"
      :aria-label="frontmatter.homeI18n?.sdk_label ?? 'Void SDK guide'"
    >
      <img src="/void-sdk.svg" alt="" class="section-label section-label--sdk" />
    </a>
    <h2 id="features-heading" class="text-white">
      {{ frontmatter.homeI18n?.sdk_heading ?? 'Turn Vite Apps Full-Stack' }}
    </h2>
    <p class="max-w-md text-white/70 text-balance sm:text-pretty">
      {{
        frontmatter.homeI18n?.sdk_description ??
        'Use your favorite Vite framework, add the backend features you need, and let Void infer your resources.'
      }}
    </p>
  </section>

  <HomeFeatures />

  <Footer
    :heading="frontmatter.footer_heading"
    :subheading="frontmatter.footer_subheading"
    :button-text="frontmatter.homeI18n?.get_started ?? 'Get Started'"
    :button-link="frontmatter.homeI18n?.sdk_link ?? '/guide/'"
  />
</template>

<style scoped>
.section-label {
  height: 0.9rem;
  width: auto;
}

.section-label--sdk {
  width: 6rem;
  height: auto;
}

.section-label-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 0.9rem;
  line-height: 0;
}

.section-label-link:focus-visible {
  outline: 2px solid var(--color-electric);
  outline-offset: 4px;
}

.platform-surface :deep(.wrapper) {
  border-color: var(--color-stroke);
}

.platform-surface :deep(.wrapper--ticks::before) {
  border-left-color: var(--color-stroke);
}

.platform-surface :deep(.wrapper--ticks::after) {
  border-right-color: var(--color-stroke);
}
</style>
