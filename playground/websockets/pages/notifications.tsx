import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { WebSocketRouteMap } from 'void/routes';
import { connect } from 'void/ws';
import type { VoidSocket } from 'void/ws';
import type { Props } from './notifications.server.ts';

type NotificationSocket = VoidSocket<'/ws/notifications'>;
type NotificationClientEvent = WebSocketRouteMap['/ws/notifications']['client'];
type NotificationServerEvent = WebSocketRouteMap['/ws/notifications']['server'];

type NotificationItemView = {
  id: string;
  title: string;
  body: string;
  sentAt: string;
  index: number;
  total: number;
  acknowledged: boolean;
};

type ActivityEntry = {
  id: string;
  text: string;
};

export default function NotificationsPage({ defaultCount }: Props) {
  const [status, setStatus] = useState('connecting');
  const [count, setCount] = useState(defaultCount);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState(0);
  const [items, setItems] = useState<ReadonlyArray<NotificationItemView>>([]);
  const [activity, setActivity] = useState<ReadonlyArray<ActivityEntry>>([]);
  const socketRef = useRef<NotificationSocket | null>(null);

  const appendActivity = useEffectEvent((text: string) => {
    startTransition(() => {
      setActivity((current) => [
        {
          id: crypto.randomUUID(),
          text,
        },
        ...current,
      ]);
    });
  });

  const handleEvent = useEffectEvent((event: NotificationServerEvent) => {
    startTransition(() => {
      if (event.type === 'notifications.status') {
        setStreaming(event.streaming);
        setPending(event.pending);
        appendActivity(
          event.streaming
            ? `stream active, ${event.pending} notification${event.pending === 1 ? '' : 's'} remaining`
            : 'stream idle',
        );
        return;
      }

      if (event.type === 'notifications.item') {
        setItems((current) => [
          {
            ...event,
            acknowledged: false,
          },
          ...current,
        ]);
        appendActivity(`received item ${event.index} of ${event.total}`);
        return;
      }

      if (event.type === 'notifications.acked') {
        setItems((current) =>
          current.map((item) => (item.id === event.id ? { ...item, acknowledged: true } : item)),
        );
        appendActivity(`acknowledged ${event.id}`);
        return;
      }

      appendActivity(`stream finished after ${event.sent} item${event.sent === 1 ? '' : 's'}`);
    });
  });

  useEffect(() => {
    const socket: NotificationSocket = connect('/ws/notifications');
    socketRef.current = socket;

    const disposeOpen = socket.on('open', () => {
      setStatus('open');
    });
    const disposeMessage = socket.on('message', handleEvent);
    const disposeClose = socket.on('close', () => {
      setStatus('closed');
      setStreaming(false);
      setPending(0);
    });
    const disposeError = socket.on('error', () => {
      setStatus('error');
    });

    return () => {
      disposeOpen();
      disposeMessage();
      disposeClose();
      disposeError();
      socket.close(1000, 'Leaving notifications demo');
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  const send = (event: NotificationClientEvent) => {
    socketRef.current?.send(event);
  };

  return (
    <div>
      <h1>Notifications</h1>
      <p>
        This demo keeps one websocket open at <code>/ws/notifications</code>. The server starts a
        timed notification stream when the client sends a typed start event, then echoes typed ack
        events back for individual items.
      </p>

      <p>
        <label>
          Items per stream:{' '}
          <select value={count} onChange={(event) => setCount(Number(event.currentTarget.value))}>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={8}>8</option>
          </select>
        </label>{' '}
        <button type="button" onClick={() => send({ type: 'notifications.start', count })}>
          Start stream
        </button>{' '}
        <button type="button" onClick={() => send({ type: 'notifications.stop' })}>
          Stop
        </button>{' '}
        <button type="button" onClick={() => setItems([])}>
          Clear items
        </button>
      </p>

      <p>
        status: <strong>{status}</strong> | streaming: <strong>{streaming ? 'yes' : 'no'}</strong> |
        pending: <strong>{pending}</strong>
      </p>

      <h2>Activity log</h2>
      {activity.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ul>
          {activity.map((entry) => (
            <li key={entry.id}>{entry.text}</li>
          ))}
        </ul>
      )}

      <h2>Received items</h2>
      {items.length === 0 ? (
        <p>Start a stream to receive notifications.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong> ({item.index}/{item.total},{' '}
              {new Date(item.sentAt).toLocaleTimeString()}) - {item.body}{' '}
              <button
                type="button"
                onClick={() => send({ type: 'notifications.ack', id: item.id })}
                disabled={item.acknowledged}
              >
                {item.acknowledged ? 'Acked' : 'Acknowledge'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
