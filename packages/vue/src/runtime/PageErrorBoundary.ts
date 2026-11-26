import { clientPageError } from 'void/pages-client';
import type { ClientPageBoundary, PageError } from 'void/pages-client';
import {
  computed,
  defineAsyncComponent,
  defineComponent,
  h,
  onErrorCaptured,
  shallowRef,
  watch,
} from 'vue';
import type { Component, PropType } from 'vue';

export const PageErrorBoundary: Component = defineComponent({
  props: {
    boundary: { type: Object as PropType<ClientPageBoundary>, required: true },
    generation: { type: Number, required: true },
    onFailure: { type: Function as PropType<() => void>, required: true },
    dev: Boolean,
  },
  setup(props, { slots }) {
    const error = shallowRef<PageError | null>(null);
    const Fallback = computed(() =>
      defineAsyncComponent(props.boundary.load as () => Promise<{ default: Component }>),
    );
    watch(
      () => props.generation,
      () => {
        error.value = null;
      },
    );
    onErrorCaptured((failure) => {
      if (error.value) {
        return;
      }
      error.value = clientPageError(failure, props.dev);
      props.onFailure();
      return false;
    });
    return () => (error.value ? h(Fallback.value, { error: error.value }) : slots.default?.()[0]);
  },
});
