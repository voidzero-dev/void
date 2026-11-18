declare module 'virtual:tags' {
  export const tags: ReadonlyArray<string>;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, unknown>;
  export default component;
}
