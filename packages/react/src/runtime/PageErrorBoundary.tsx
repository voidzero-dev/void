import React, { Component, Suspense, lazy } from 'react';
import type { ReactNode } from 'react';
import { clientPageError } from 'void/pages-client';
import type { ClientPageBoundary, ErrorPageProps } from 'void/pages-client';

type ReactPageBoundary = ClientPageBoundary<React.ComponentType<ErrorPageProps>>;

type Props = {
  boundary: ReactPageBoundary;
  generation: number;
  dev?: boolean;
  children?: ReactNode;
  onFailure(): void;
};

type RecoveryState = {
  error: unknown;
  failed: boolean;
};

type BoundaryState = RecoveryState & {
  generation: number;
};

const fallbacks = new Map<string, React.LazyExoticComponent<React.ComponentType<ErrorPageProps>>>();
function fallbackFor(boundary: ReactPageBoundary) {
  let fallback = fallbacks.get(boundary.id);
  if (!fallback) {
    fallback = lazy(boundary.load);
    fallbacks.set(boundary.id, fallback);
  }
  return fallback;
}

/** Native boundaries recover only descendants, so fallback failures reach the parent. */
export class PageErrorBoundary extends Component<Props, BoundaryState> {
  state: BoundaryState = {
    generation: this.props.generation,
    error: null,
    failed: false,
  };
  static getDerivedStateFromProps(
    props: Props,
    state: { generation: number },
  ): BoundaryState | null {
    return props.generation !== state.generation
      ? { generation: props.generation, error: null, failed: false }
      : null;
  }
  static getDerivedStateFromError(error: unknown): RecoveryState {
    return { error, failed: true };
  }
  componentDidCatch(): void {
    this.props.onFailure();
  }
  render(): ReactNode {
    if (this.state.failed) {
      const Fallback = fallbackFor(this.props.boundary);
      return (
        <Suspense fallback={null}>
          <Fallback error={clientPageError(this.state.error, this.props.dev)} />
        </Suspense>
      );
    }
    return this.props.children;
  }
}
