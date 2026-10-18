import { createContext, type Context } from 'solid-js';
import type { ImagePreloadCollector } from 'void/image';
import type { NavigationState, VoidRouter } from 'void/pages-client';

export const SharedContext: Context<Record<string, unknown> | null> = createContext<Record<
  string,
  unknown
> | null>(null);
export const ErrorsContext: Context<
  Record<string, string> | (() => Record<string, string>) | null
> = createContext<Record<string, string> | (() => Record<string, string>) | null>(null);
export const ParamsContext: Context<Record<string, string> | null> = createContext<Record<
  string,
  string
> | null>(null);
export const RouterContext: Context<VoidRouter | null> = createContext<VoidRouter | null>(null);
export const NavigationContext: Context<(() => NavigationState) | null> = createContext<
  (() => NavigationState) | null
>(null);
/**
 * Collects the `<link rel="preload" as="image">` tags of one server render
 * for the page `<head>`. `null` in the browser.
 */
export const ImagePreloadContext: Context<ImagePreloadCollector | null> =
  createContext<ImagePreloadCollector | null>(null);
