import type { ReactNode } from 'react';

export function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 28,
        width: '100%',
        height: '100%',
        padding: 72,
        background: '#0f172a',
        color: '#f8fafc',
      }}
    >
      {children}
    </div>
  );
}
