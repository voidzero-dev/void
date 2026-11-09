import React, { Component, Suspense, lazy, type ReactNode } from 'react';
import { clientPageError, type ClientPageBoundary, type ErrorPageProps } from 'void/pages-client';

type Props = {
  boundary: ClientPageBoundary;
  generation: number;
  dev?: boolean;
  children?: ReactNode;
  onFailure(): void;
};

const fallbacks = new Map<string, React.LazyExoticComponent<React.ComponentType<ErrorPageProps>>>();
function fallbackFor(boundary: ClientPageBoundary) {
  let fallback = fallbacks.get(boundary.id);
  if (!fallback) {
    fallback = lazy(
      boundary.load as () => Promise<{ default: React.ComponentType<ErrorPageProps> }>,
    );
    fallbacks.set(boundary.id, fallback);
  }
  return fallback;
}

/** Native boundaries recover only descendants, so fallback failures reach the parent. */
export class PageErrorBoundary extends Component<
  Props,
  { generation: number; error: unknown; failed: boolean }
> {
  state: { generation: number; error: unknown; failed: boolean } = {
    generation: this.props.generation,
    error: null as unknown,
    failed: false,
  };
  static getDerivedStateFromProps(
    props: Props,
    state: { generation: number },
  ): { generation: number; error: unknown; failed: boolean } | null {
    return props.generation !== state.generation
      ? { generation: props.generation, error: null, failed: false }
      : null;
  }
  static getDerivedStateFromError(error: unknown): { error: unknown; failed: boolean } {
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
