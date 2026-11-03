import type { Snippet } from 'svelte';
import type { BaseLinkProps } from 'void/pages-client';

type EventHandler<T extends Event> = (event: T) => void;

export type LinkProps = BaseLinkProps & {
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
