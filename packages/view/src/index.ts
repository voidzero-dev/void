export type ViewChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | ViewResult
  | Array<ViewChild>;
/** Opaque compiled HTML on the server, DOM on the client. */
export interface ViewResult {
  readonly __view: true;
}
export interface BaseProps {
  children?: ViewChild;
}
