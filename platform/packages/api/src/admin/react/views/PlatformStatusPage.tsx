/** @jsxImportSource react */

import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Text';
import type { PlatformLifecycleOperation } from '@void/platform';
import { Activity, Check, Clock, Minus, Pause, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PlatformStatusSnapshot } from '../../platform-status.ts';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { PageStack } from './PageStack.tsx';
import { SectionStack } from './SectionStack.tsx';
import { LastCheckedTime, StatusCard, type StatusCardState } from './StatusCard.tsx';

const PHASE_LABELS: Record<PlatformLifecycleOperation['phase'], string> = {
  preparing: 'Preparing the platform',
  deploying: 'Deploying services',
  verifying: 'Verifying the platform',
  enabling: 'Enabling traffic and verifying cutover',
  'waiting-for-dns': 'Waiting for DNS',
  'waiting-for-sandbox-drain': 'Waiting for Sandbox drain',
  complete: 'Operation complete',
  failed: 'Operation needs attention',
};
const ACTION_LABELS: Record<PlatformLifecycleOperation['action'], string> = {
  install: 'Installation',
  upgrade: 'Upgrade',
  rollback: 'Rollback',
  repair: 'Repair',
  enable: 'Enable',
};

export function PlatformStatusPage({
  platformName,
  username,
  snapshot,
}: {
  platformName: string;
  username?: string;
  snapshot: PlatformStatusSnapshot | null;
}) {
  const [current, setCurrent] = useState(snapshot);
  const [connection, setConnection] = useState<'current' | 'unavailable' | 'expired'>(
    snapshot ? 'current' : 'unavailable',
  );
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 5000);
        return;
      }
      try {
        const response = await fetch('/admin/status.json', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (stopped) {
          return;
        }
        if (response.redirected || response.status === 401 || response.status === 403) {
          setConnection('expired');
          return;
        }
        if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
          throw new Error('Status unavailable');
        }
        const next: PlatformStatusSnapshot = await response.json();
        if (stopped) {
          return;
        }
        setCurrent(next);
        setConnection('current');
      } catch {
        if (stopped) {
          return;
        }
        setConnection('unavailable');
      }
      if (!stopped) {
        timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  const operation = current?.checkpoint?.operation;
  const waiting =
    operation?.phase === 'waiting-for-dns' || operation?.phase === 'waiting-for-sandbox-drain';
  const failed =
    operation?.phase === 'failed' ||
    (current?.checkpoint?.status === 'failed' && (!operation || operation.phase === 'complete'));
  const needsAttention = failed || waiting;
  const trafficLabel = !current
    ? 'Unknown'
    : current.traffic === 'paused'
      ? 'Traffic paused'
      : 'Traffic enabled';
  const phaseLabel = failed
    ? 'Operation needs attention'
    : operation
      ? PHASE_LABELS[operation.phase]
      : current?.checkpoint
        ? `Installation ${current.checkpoint.status}`
        : 'Installation status unavailable';
  const lifecycleState: StatusCardState = failed
    ? 'error'
    : waiting
      ? 'waiting'
      : operation?.phase === 'complete' ||
          (!operation && current?.checkpoint?.status === 'installed')
        ? 'healthy'
        : operation || current?.checkpoint
          ? 'loading'
          : 'unavailable';
  const state: StatusCardState =
    connection !== 'current'
      ? 'unavailable'
      : failed
        ? 'error'
        : waiting || current?.traffic === 'paused'
          ? 'waiting'
          : lifecycleState === 'loading'
            ? 'loading'
            : 'healthy';
  const LifecycleIcon =
    lifecycleState === 'error'
      ? X
      : lifecycleState === 'waiting'
        ? Clock
        : lifecycleState === 'healthy'
          ? Check
          : lifecycleState === 'loading'
            ? Activity
            : Minus;
  const TrafficIcon = !current ? Minus : current.traffic === 'paused' ? Pause : Check;

  return (
    <Layout platformName={platformName} username={username} title="Platform status">
      <PageStack className="void-platform-status">
        <div className="void-platform-status-heading">
          <SectionStack as="div">
            <Heading level={1}>Platform status</Heading>
            <p>Follow upgrade and rollback progress. This page is read-only during maintenance.</p>
          </SectionStack>
          <Button
            type="button"
            label="Refresh status"
            size="sm"
            variant="secondary"
            onClick={() => setRefresh((value) => value + 1)}
          />
        </div>

        <StatusCard
          title="Current status"
          state={state}
          statusLabel={
            connection !== 'current'
              ? 'Live status unavailable'
              : needsAttention || lifecycleState === 'loading'
                ? phaseLabel
                : trafficLabel
          }
          headerAccessory={
            <LastCheckedTime
              checkedAt={current ? Date.parse(current.checkedAt) : undefined}
              unavailable={connection !== 'current'}
            />
          }
        >
          <ul className="void-platform-status-summary" aria-label="Installation and traffic">
            {(operation || failed) && (
              <li data-state={connection !== 'current' ? 'unavailable' : lifecycleState}>
                <span className="void-admin-health-indicator" aria-hidden="true">
                  <LifecycleIcon size={16} />
                </span>
                <span>
                  <span className="void-platform-status-summary-label">
                    {operation ? ACTION_LABELS[operation.action] : 'Installation'}
                  </span>
                  <strong>{phaseLabel}</strong>
                </span>
              </li>
            )}
            <li
              data-state={
                connection !== 'current' || !current
                  ? 'unavailable'
                  : current.traffic === 'paused'
                    ? 'waiting'
                    : 'healthy'
              }
            >
              <span className="void-admin-health-indicator" aria-hidden="true">
                <TrafficIcon size={16} />
              </span>
              <span>
                <span className="void-platform-status-summary-label">Application traffic</span>
                <strong>
                  {trafficLabel}
                  {current && connection !== 'current' ? ' (last confirmed)' : ''}
                </strong>
              </span>
            </li>
          </ul>

          <div
            className="void-platform-status-notice"
            data-state={connection}
            role="status"
            aria-live="polite"
          >
            {connection === 'expired' ? (
              <SectionStack as="div">
                <p>Sign in again to confirm the current status.</p>
                <Button as="a" href="/admin/login" label="Sign in again" size="sm" />
              </SectionStack>
            ) : connection === 'unavailable' ? (
              <p>
                Live status is unavailable.{' '}
                {current
                  ? 'Showing the last confirmed snapshot; it may be out of date.'
                  : 'The current operation and traffic state could not be confirmed.'}{' '}
                Progress is saved independently of this page.
              </p>
            ) : (
              <p>
                Refreshes every 5 seconds.
                {operation && ' Saved progress may remain unchanged during a phase.'}
              </p>
            )}
          </div>

          <div className="void-platform-status-grid">
            {current?.checkpoint && (
              <SectionStack aria-labelledby="platform-operation-heading">
                <Heading level={3} id="platform-operation-heading">
                  {operation ? ACTION_LABELS[operation.action] : 'Installation'}
                </Heading>
                {operation ? (
                  <>
                    <p className="void-platform-status-version">
                      {operation.fromVersion ?? 'New installation'} <span aria-label="to">→</span>{' '}
                      {operation.toVersion}
                    </p>
                    <dl>
                      <dt>Started</dt>
                      <dd>{formatDateTime(operation.startedAt)}</dd>
                      <dt>Progress saved</dt>
                      <dd>{formatDateTime(operation.updatedAt)}</dd>
                      <dt>Installation state</dt>
                      <dd>{current?.checkpoint?.status}</dd>
                    </dl>
                  </>
                ) : (
                  <dl>
                    <dt>Version</dt>
                    <dd>{current.checkpoint.platformVersion}</dd>
                    <dt>Updated</dt>
                    <dd>{formatDateTime(current.checkpoint.updatedAt)}</dd>
                  </dl>
                )}
                {operation && !needsAttention && operation.phase !== 'complete' && (
                  <p>
                    Keep the CLI command running until it finishes. Refreshing this page won’t
                    interrupt it.
                  </p>
                )}
              </SectionStack>
            )}

            <SectionStack aria-labelledby="platform-traffic-heading">
              <Heading level={3} id="platform-traffic-heading">
                Traffic availability
              </Heading>
              <p>
                {!current
                  ? 'Traffic status is unavailable. Try refreshing.'
                  : current.traffic === 'paused'
                    ? 'App traffic and dashboard changes are paused for maintenance. You can still sign in and follow progress here.'
                    : 'Maintenance mode is off. The platform is allowing requests to your apps.'}
              </p>
              {current?.traffic === 'enabled' &&
                operation &&
                ['deploying', 'verifying', 'enabling'].includes(operation.phase) && (
                  <p>Some apps may be temporarily unavailable while services are being updated.</p>
                )}
            </SectionStack>
          </div>

          {needsAttention && (
            <SectionStack
              className="void-platform-status-recovery"
              aria-labelledby="platform-recovery-heading"
            >
              <Heading level={3} id="platform-recovery-heading">
                Next step
              </Heading>
              <p>
                {operation?.phase === 'waiting-for-dns'
                  ? 'Wait for the zone to become active, then rerun the lifecycle command.'
                  : operation?.phase === 'waiting-for-sandbox-drain'
                    ? 'Complete the remaining Sandbox drain work using the CLI, then rerun the lifecycle command. Traffic stays paused until the cutover is verified.'
                    : 'Review the CLI error and saved installation state. Resolve the error before resuming the same lifecycle command.'}
              </p>
              <p>
                Use the recovery commands printed by the CLI and keep the same runtime files
                {operation?.action === 'rollback' ? ', including the rollback source runtime' : ''}.
                Reloading this page does not resume an operation.
              </p>
            </SectionStack>
          )}
        </StatusCard>
      </PageStack>
    </Layout>
  );
}
