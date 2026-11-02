import {
  handleLinkClick,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
  type BaseLinkProps,
  type LinkNavigateEvent,
  type LinkPrefetchStrategy,
  type VoidRouter,
} from 'void/pages-client';
import type { Href } from 'void/routes';
import {
  computed,
  defineComponent,
  h,
  inject,
  onMounted,
  onUnmounted,
  ref,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type DefineSetupFnComponent,
  type ExtractPublicPropTypes,
  type PropType,
} from 'vue';

type LinkMethod = NonNullable<BaseLinkProps['method']>;

// Attributes and listeners fall through to the rendered <a> or <button>.
type LinkProps = BaseLinkProps &
  Omit<AnchorHTMLAttributes, keyof BaseLinkProps> &
  Omit<ButtonHTMLAttributes, keyof BaseLinkProps>;

const linkPropOptions = {
  href: { type: String as PropType<Href>, required: true },
  method: { type: String as PropType<LinkMethod>, default: 'GET' },
  data: { type: Object as PropType<Record<string, unknown>>, default: undefined },
  preserveScroll: { type: Boolean, default: false },
  preserveState: { type: Boolean, default: false },
  replace: { type: Boolean, default: false },
  reloadDocument: { type: Boolean, default: false },
  viewTransition: { type: Boolean, default: undefined },
  onNavigate: {
    type: Function as PropType<(event: LinkNavigateEvent) => void>,
    default: undefined,
  },
  prefetch: {
    type: [Boolean, String, Array] as PropType<
      boolean | LinkPrefetchStrategy | ReadonlyArray<LinkPrefetchStrategy>
    >,
    default: false,
  },
  cacheFor: {
    type: [Number, String, Array] as PropType<number | string | [string, string]>,
    default: undefined,
  },
} as const;

// isolatedDeclarations needs the public props written out. This fails to compile if
// the runtime props above drift from the shared Link props.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const linkPropsMatchRuntime: Same<
  ExtractPublicPropTypes<typeof linkPropOptions>,
  BaseLinkProps
> = true;
void linkPropsMatchRuntime;

function callHandler(handler: unknown, event: Event): void {
  if (Array.isArray(handler)) {
    for (const fn of handler) {
      if (typeof fn === 'function') {
        fn(event);
      }
    }
  } else if (typeof handler === 'function') {
    handler(event);
  }
}

const LinkComponent = defineComponent({
  name: 'Link',
  props: linkPropOptions,
  setup(props, { slots, attrs }) {
    const router = inject<VoidRouter | null>('__void_router', null);
    const elRef = ref<HTMLElement | null>(null);
    const link = computed(() => resolveLink(props));
    const strategies = computed(() => linkPrefetchStrategies(props));

    function doPrefetch() {
      prefetchLink(router, link.value.href, props.cacheFor);
    }

    function onClick(e: MouseEvent) {
      callHandler(attrs.onClick, e);
      handleLinkClick(e, router, link.value, props);
    }

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let stopObserving: (() => void) | null = null;

    function onMouseEnter(e: MouseEvent) {
      callHandler(attrs.onMouseenter ?? attrs.onMouseEnter, e);
      if (e.defaultPrevented) {
        return;
      }
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
    }

    function onMouseLeave(e: MouseEvent) {
      callHandler(attrs.onMouseleave ?? attrs.onMouseLeave, e);
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
    }

    function onFocus(e: FocusEvent) {
      callHandler(attrs.onFocus, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    function onMouseDown(e: MouseEvent) {
      callHandler(attrs.onMousedown ?? attrs.onMouseDown, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    function onTouchStart(e: TouchEvent) {
      callHandler(attrs.onTouchstart ?? attrs.onTouchStart, e);
      if (!e.defaultPrevented) {
        doPrefetch();
      }
    }

    onMounted(() => {
      if (strategies.value.includes('mount')) {
        doPrefetch();
      }
      if (strategies.value.includes('visible') && elRef.value) {
        stopObserving = observeLinkVisible(elRef.value, doPrefetch);
      }
    });

    onUnmounted(() => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      stopObserving?.();
    });

    return () => {
      const { href, isGet } = link.value;
      const tag = isGet ? 'a' : 'button';

      const eventHandlers: Record<string, unknown> = { onClick };

      if (strategies.value.includes('hover')) {
        eventHandlers.onMouseenter = onMouseEnter;
        eventHandlers.onMouseleave = onMouseLeave;
        eventHandlers.onFocus = onFocus;
        eventHandlers.onTouchstart = onTouchStart;
      }

      if (strategies.value.includes('click')) {
        eventHandlers.onMousedown = onMouseDown;
        eventHandlers.onTouchstart = onTouchStart;
      }

      return h(
        tag,
        {
          ...attrs,
          ref: elRef,
          ...(isGet ? { href } : { type: 'button' }),
          style: [{ touchAction: 'manipulation' }, (attrs as { style?: unknown }).style],
          ...eventHandlers,
        },
        slots.default?.(),
      );
    };
  },
});

// isolatedDeclarations needs an explicit type. `DefineComponent<LinkProps>` would
// treat LinkProps as runtime prop options and widen `href` to an optional `any`.
// The options component is not assignable to it, so cast; the check above keeps
// the runtime props in step with BaseLinkProps.
export const Link: DefineSetupFnComponent<LinkProps> =
  LinkComponent as DefineSetupFnComponent<LinkProps>;
