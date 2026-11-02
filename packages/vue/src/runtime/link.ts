import {
  isModifiedEvent,
  mergeDataIntoHref,
  type PrefetchOptions,
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

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };

type VoidLinkProps = {
  href: Href;
  method?: LinkMethod | Lowercase<LinkMethod>;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  onNavigate?: (event: NavigateEvent) => void;
  prefetch?: boolean | PrefetchStrategy | ReadonlyArray<PrefetchStrategy>;
  cacheFor?: number | string | [string, string];
};

// Attributes and listeners fall through to the rendered <a> or <button>.
type LinkProps = VoidLinkProps &
  Omit<AnchorHTMLAttributes, keyof VoidLinkProps> &
  Omit<ButtonHTMLAttributes, keyof VoidLinkProps>;

const linkPropOptions = {
  href: { type: String as PropType<Href>, required: true },
  method: { type: String as PropType<LinkMethod | Lowercase<LinkMethod>>, default: 'GET' },
  data: { type: Object as PropType<Record<string, unknown>>, default: undefined },
  preserveScroll: { type: Boolean, default: false },
  preserveState: { type: Boolean, default: false },
  replace: { type: Boolean, default: false },
  reloadDocument: { type: Boolean, default: false },
  viewTransition: { type: Boolean, default: undefined },
  onNavigate: { type: Function as PropType<(event: NavigateEvent) => void>, default: undefined },
  prefetch: {
    type: [Boolean, String, Array] as PropType<
      boolean | PrefetchStrategy | ReadonlyArray<PrefetchStrategy>
    >,
    default: false,
  },
  cacheFor: {
    type: [Number, String, Array] as PropType<number | string | [string, string]>,
    default: undefined,
  },
} as const;

// isolatedDeclarations needs VoidLinkProps written out. This fails to compile if
// it drifts from the runtime props above.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const voidLinkPropsMatchRuntime: Same<
  ExtractPublicPropTypes<typeof linkPropOptions>,
  VoidLinkProps
> = true;
void voidLinkPropsMatchRuntime;

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
    const normalizedMethod = computed(() => props.method.toUpperCase() as LinkMethod);
    const isGet = computed(() => normalizedMethod.value === 'GET');
    const hrefWithData = computed(() =>
      isGet.value ? mergeDataIntoHref(props.href, props.data) : props.href,
    );
    const strategies = computed<ReadonlyArray<PrefetchStrategy>>(() => {
      if (props.prefetch === false || props.reloadDocument) {
        return [];
      }
      if (props.prefetch === true) {
        return ['hover'];
      }
      if (typeof props.prefetch === 'string') {
        return [props.prefetch];
      }
      return props.prefetch;
    });

    function doPrefetch() {
      if (!router?.prefetch) {
        return;
      }
      const current = window.location.pathname + window.location.search;
      if (hrefWithData.value === current) {
        return;
      }
      const options: PrefetchOptions = { method: normalizedMethod.value };
      if (props.cacheFor !== undefined) {
        options.cacheFor = props.cacheFor;
      }
      router.prefetch(hrefWithData.value, options);
    }

    function onClick(e: MouseEvent) {
      callHandler(attrs.onClick, e);
      if (props.reloadDocument || !router || e.defaultPrevented || isModifiedEvent(e)) {
        return;
      }
      if ((e.currentTarget as HTMLElement).hasAttribute('download')) {
        return;
      }
      const url = new URL(hrefWithData.value, window.location.href);
      if (url.origin !== window.location.origin) {
        return;
      }

      let navigatePrevented = false;
      props.onNavigate?.({
        preventDefault() {
          navigatePrevented = true;
        },
      });
      if (navigatePrevented) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      router.visit(hrefWithData.value, {
        method: normalizedMethod.value,
        data: isGet.value ? undefined : props.data,
        preserveScroll: props.preserveScroll,
        preserveState: props.preserveState,
        replace: props.replace,
        viewTransition: props.viewTransition,
      });
    }

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: IntersectionObserver | null = null;

    function onMouseEnter(e: MouseEvent) {
      callHandler(attrs.onMouseenter ?? attrs.onMouseEnter, e);
      if (e.defaultPrevented) {
        return;
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
        observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              doPrefetch();
              observer?.disconnect();
              observer = null;
            }
          },
          { rootMargin: '0px' },
        );
        observer.observe(elRef.value);
      }
    });

    onUnmounted(() => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    });

    return () => {
      if (props.prefetch !== false && !isGet.value) {
        throw new Error(
          'Link: prefetch only supports GET links. Remove `prefetch` or use method="GET".',
        );
      }
      if (props.reloadDocument && !isGet.value) {
        throw new Error('Link: reloadDocument only supports GET links.');
      }

      const tag = isGet.value ? 'a' : 'button';

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
          ...(isGet.value ? { href: hrefWithData.value } : { type: 'button' }),
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
// VoidLinkProps in step with the runtime props.
export const Link: DefineSetupFnComponent<LinkProps> =
  LinkComponent as DefineSetupFnComponent<LinkProps>;
