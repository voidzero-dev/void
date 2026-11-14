import type { ViewChild, ViewResult } from './index.ts';
export namespace JSX {
  export type Element = ViewResult;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  type Events = {
    [K in keyof GlobalEventHandlersEventMap as `on${K}`]?: (
      event: GlobalEventHandlersEventMap[K],
    ) => unknown;
  };
  type Attributes = Events & {
    children?: ViewChild;
    class?: string;
    style?: string;
    [attribute: string]: unknown;
  };
  export type IntrinsicElements = { [K in keyof HTMLElementTagNameMap]: Attributes } & {
    [K in keyof SVGElementTagNameMap]: Attributes;
  };
}
