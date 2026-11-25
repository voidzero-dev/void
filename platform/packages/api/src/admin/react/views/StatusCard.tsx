/** @jsxImportSource react */

import { Activity, CircleCheck, CircleHelp, CircleX, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AdminCard } from './AdminCard.tsx';

export function LastCheckedTime({
  checkedAt,
  unavailable,
}: {
  checkedAt?: number;
  unavailable: boolean;
}) {
  return (
    <span className="void-admin-health-checked-at" data-unavailable={unavailable || undefined}>
      {unavailable ? (
        <span role="status">Status unavailable</span>
      ) : checkedAt !== undefined ? (
        <CheckedTime key={checkedAt} checkedAt={checkedAt} />
      ) : null}
    </span>
  );
}

function CheckedTime({ checkedAt }: { checkedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  const age =
    seconds < 5
      ? 'just now'
      : seconds < 60
        ? `${seconds}s ago`
        : `${Math.floor(seconds / 60)}m ago`;
  return (
    <time
      dateTime={new Date(checkedAt).toISOString()}
      title={new Date(checkedAt).toLocaleTimeString()}
    >
      Checked {age}
    </time>
  );
}

export type StatusCardState = 'loading' | 'healthy' | 'error' | 'unavailable' | 'waiting';

export function StatusCard({
  id,
  title,
  state,
  statusLabel,
  headerAccessory,
  children,
}: {
  id?: string;
  title: string;
  state: StatusCardState;
  statusLabel: string;
  headerAccessory?: ReactNode;
  children: ReactNode;
}) {
  const Icon =
    state === 'healthy'
      ? CircleCheck
      : state === 'error'
        ? CircleX
        : state === 'waiting'
          ? Clock
          : state === 'loading'
            ? Activity
            : CircleHelp;
  return (
    <div id={id} className="void-admin-status-card" data-state={state}>
      <AdminCard
        title={title}
        titleIcon={
          <span className="void-admin-health-overall-icon" role="img" aria-label={statusLabel}>
            <Icon size={20} aria-hidden="true" />
          </span>
        }
        headerAccessory={headerAccessory}
      >
        {children}
      </AdminCard>
    </div>
  );
}
