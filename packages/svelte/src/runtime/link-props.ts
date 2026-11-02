import type { Snippet } from 'svelte';
import type { Href } from 'void/routes';

export type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
export type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };
type EventHandler<T extends Event> = (event: T) => void;

export type LinkProps = {
  href: Href;
  method?: LinkMethod | Lowercase<LinkMethod>;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | Array<PrefetchStrategy>;
  cacheFor?: number | string | [string, string];
  onNavigate?: (event: NavigateEvent) => void;
  children?: Snippet;
  onclick?: EventHandler<MouseEvent>;
  onmouseenter?: EventHandler<MouseEvent>;
  onmouseleave?: EventHandler<MouseEvent>;
  onfocus?: EventHandler<FocusEvent>;
  onmousedown?: EventHandler<MouseEvent>;
  ontouchstart?: EventHandler<TouchEvent>;
  style?: string;
  [key: string]: unknown;
};
