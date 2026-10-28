<script setup lang="ts">
import { useData } from 'vitepress';

const { frontmatter } = useData();
const commandColumns = [
  [
    'auth',
    'build',
    'invitation',
    'user',
    'project',
    'deployment',
    'signup',
    'system',
    'email',
    'worker',
    'config auth',
    'list',
  ],
  [
    'use',
    'status',
    'discover',
    'domain set',
    'install',
    'upgrade',
    'rollback',
    'repair',
    'disable',
    'enable',
    'uninstall',
  ],
];
</script>

<template>
  <div class="platform-command-stage">
    <div
      class="platform-command-window"
      role="group"
      :aria-label="frontmatter.homeI18n?.platform_commands_label ?? 'Void platform commands'"
    >
      <div class="platform-command-header">
        <span class="platform-command-heading">void platform</span>
      </div>
      <div class="platform-command-columns">
        <ul v-for="(column, index) in commandColumns" :key="index" class="platform-command-list">
          <li v-for="command in column" :key="command">
            <svg class="platform-command-check" viewBox="0 0 16 16" aria-hidden="true">
              <rect width="16" height="16" rx="3" fill="currentColor" />
              <path d="m4 8 2.5 2.5L12 5" fill="none" stroke="#111111" stroke-width="1.5" />
            </svg>
            <code>{{ command }}</code>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.platform-command-stage {
  width: 100%;
  height: 30rem;
  min-width: 0;
  padding: 128px 32px 0;
}

.platform-command-window {
  width: 100%;
  max-width: 30rem;
  min-width: 0;
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid #ffffff40;
  border-radius: 8px 8px 0 0;
  background: #111111;
  box-shadow: 0 16px 48px #14003340;
  color: #e9e5f2;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 400;
  line-height: 26px;
  font-variant-ligatures: none;
  -webkit-font-smoothing: antialiased;
}

.platform-command-header {
  padding: 8px 10px;
  border-bottom: 1px solid #ffffff1a;
  background: #ffffff05;
}

.platform-command-heading {
  display: block;
  padding: 8px 12px;
  color: #aaa4b6;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}

.platform-command-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  padding: 28px 24px 36px;
}

.platform-command-list {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.platform-command-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: inherit;
  font: inherit;
  white-space: nowrap;
}

.platform-command-check {
  flex: none;
  width: 12px;
  height: 12px;
  color: #777280;
}

.platform-command-list code {
  display: block;
  min-width: 0;
  overflow: hidden;
  padding: 1px 6px;
  border: 0;
  border-radius: 4px;
  outline: none;
  background: #ffffff0d;
  color: inherit;
  font: inherit;
  text-overflow: clip;
}

@media (max-width: 1100px) {
  .platform-command-stage {
    padding: 112px 20px 0;
  }

  .platform-command-window {
    font-size: 11px;
    line-height: 23px;
  }

  .platform-command-columns {
    gap: 10px;
    padding: 24px 18px 32px;
  }

  .platform-command-list li {
    gap: 7px;
  }
}

@media (max-width: 640px) {
  .platform-command-stage {
    height: 22rem;
    padding-top: 96px;
  }
}
</style>
