import {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
} from 'void/pages-client';
import type { FormModel, FormMethod, VoidActionError } from 'void/pages-client';
import { defineComponent, h, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Component, PropType, VNodeChild } from 'vue';

export const Form: Component = defineComponent({
  name: 'VoidForm',
  inheritAttrs: false,
  props: {
    form: { type: Object as PropType<FormModel>, required: true },
    method: { type: String as PropType<FormMethod>, default: 'post' },
    renderError: Function as PropType<(error: VoidActionError) => VNodeChild>,
  },
  setup(props, { attrs, slots }) {
    const now = ref(Date.now());
    let cancel = () => {};
    onMounted(() =>
      watch(
        () => props.form.error,
        (error) => {
          cancel();
          cancel = scheduleFormRetry(error, () => {
            now.value = Date.now();
          });
        },
        { immediate: true },
      ),
    );
    onUnmounted(() => cancel());
    return () => {
      const form = props.form;
      const message = formErrorMessage(form),
        retry = formRetryMessage(form.error);
      return h(
        'form',
        {
          ...attrs,
          'aria-busy': form.pending,
          onSubmit: async (event: Event) => {
            event.preventDefault();
            if (!formSubmissionBlocked(form, now.value)) {
              await form[props.method]();
            }
          },
        },
        [
          message
            ? h('div', { role: 'alert', 'data-void-form-error': '' }, [
                form.error && props.renderError ? props.renderError(form.error) : message,
                retry ? h('p', retry) : null,
              ])
            : null,
          slots.default?.(),
        ],
      );
    };
  },
});
