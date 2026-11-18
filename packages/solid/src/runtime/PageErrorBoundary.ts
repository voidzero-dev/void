import {
  createComponent,
  createEffect,
  ErrorBoundary,
  lazy,
  Suspense,
  type Component,
  type JSX,
} from 'solid-js';
import {
  clientPageError,
  showTerminalPageError,
  type ClientPageBoundary,
  type ErrorPageProps,
} from 'void/pages-client';

type Props = {
  boundaries?: Array<ClientPageBoundary>;
  terminal?: boolean;
  url?: string;
  server?: boolean;
  generation: number;
  onFailure(): void;
  dev?: boolean;
  children?: JSX.Element;
};
export function PageErrorBoundary(props: Props): JSX.Element {
  let previous = props.generation;
  let resetBoundary = () => {};
  createEffect(() => {
    if (previous !== props.generation) {
      previous = props.generation;
      resetBoundary();
    }
  });
  return createComponent(ErrorBoundary, {
    fallback(error, reset) {
      if (props.server) {
        throw error;
      }
      if (props.terminal) {
        props.onFailure();
        showTerminalPageError(props.url);
        return null;
      }
      const [boundary, ...outer] = props.boundaries ?? [];
      if (!boundary) {
        throw error;
      }
      const Fallback = lazy(boundary.load as () => Promise<{ default: Component<ErrorPageProps> }>);
      resetBoundary = reset;
      props.onFailure();
      return createComponent(PageErrorBoundary, {
        boundaries: outer,
        get generation() {
          return props.generation;
        },
        onFailure: props.onFailure,
        dev: props.dev,
        get children() {
          return createComponent(Suspense, {
            fallback: null,
            get children() {
              return createComponent(Fallback, { error: clientPageError(error, props.dev) });
            },
          });
        },
      });
    },
    get children() {
      return props.children;
    },
  });
}
