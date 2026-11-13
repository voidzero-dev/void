/** @jsxImportSource react */

import { Component, type ReactNode } from 'react';
import { AdminErrorPage } from './views/AdminErrorPage.tsx';

function isFateRequestError(error: unknown): error is Error & { status: number } {
  return (
    error instanceof Error &&
    error.name === 'FateRequestError' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

export class AdminFateErrorBoundary extends Component<
  { children: ReactNode; platformName: string },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error) {
      const status = isFateRequestError(error) ? error.status : 500;
      const message = isFateRequestError(error)
        ? error.message
        : 'The admin page could not be loaded.';
      return (
        <AdminErrorPage message={message} status={status} platformName={this.props.platformName} />
      );
    }
    return this.props.children;
  }
}
