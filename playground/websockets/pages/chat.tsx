import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { WebSocketRouteMap } from 'void/routes';
import { connect } from 'void/ws';
import type { VoidSocket } from 'void/ws';
import type { Props } from './chat.server.ts';

type ChatSocket = VoidSocket<'/ws/chat/:room'>;
type ChatClientEvent = WebSocketRouteMap['/ws/chat/:room']['client'];
type ChatServerEvent = WebSocketRouteMap['/ws/chat/:room']['server'];

type TimelineEntry = {
  id: string;
  kind: 'system' | 'message';
  title: string;
  body: string;
  meta: string;
};

function toTimelineEntry(event: ChatServerEvent): TimelineEntry {
  if (event.type === 'chat.message') {
    return {
      id: event.id,
      kind: 'message',
      title: event.name,
      body: event.text,
      meta: new Date(event.sentAt).toLocaleTimeString(),
    };
  }

  return {
    id: event.id,
    kind: 'system',
    title: 'Room event',
    body: event.text,
    meta: `${event.activeConnections} active connection${event.activeConnections === 1 ? '' : 's'}`,
  };
}

export default function ChatPage({ initialRoom, initialName }: Props) {
  const [roomInput, setRoomInput] = useState(initialRoom);
  const [nameInput, setNameInput] = useState(initialName);
  const [activeRoom, setActiveRoom] = useState(initialRoom);
  const [activeName, setActiveName] = useState(initialName);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('connecting');
  const [timeline, setTimeline] = useState<ReadonlyArray<TimelineEntry>>([]);
  const socketRef = useRef<ChatSocket | null>(null);

  const appendEvent = useEffectEvent((event: ChatServerEvent) => {
    startTransition(() => {
      setTimeline((current) => [...current, toTimelineEntry(event)]);
    });
  });

  useEffect(() => {
    const socket: ChatSocket = connect('/ws/chat/:room', {
      params: { room: activeRoom },
    });
    socketRef.current = socket;

    const disposeOpen = socket.on('open', () => {
      setStatus('open');
      socket.send({ type: 'chat.join', name: activeName });
    });
    const disposeMessage = socket.on('message', appendEvent);
    const disposeClose = socket.on('close', () => {
      setStatus('closed');
    });
    const disposeError = socket.on('error', () => {
      setStatus('error');
    });

    return () => {
      disposeOpen();
      disposeMessage();
      disposeClose();
      disposeError();
      socket.close(1000, 'Switching rooms');
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeName, activeRoom]);

  const reconnect = () => {
    const nextRoom = roomInput.trim() || 'general';
    const nextName = nameInput.trim() || initialName;
    setStatus('connecting');
    setTimeline([]);
    setActiveRoom(nextRoom);
    setActiveName(nextName);
  };

  const send = (event: ChatClientEvent) => {
    socketRef.current?.send(event);
  };

  const sendMessage = () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    send({ type: 'chat.message', text });
    setDraft('');
  };

  return (
    <div>
      <h1>Chat Room</h1>
      <p>
        This page connects to <code>/ws/chat/:room</code>, sends a typed join event on open, and
        broadcasts typed room messages through <code>defineRoom()</code>.
      </p>

      <p>
        <label>
          Room:{' '}
          <input value={roomInput} onChange={(event) => setRoomInput(event.currentTarget.value)} />
        </label>{' '}
        <label>
          Display name:{' '}
          <input value={nameInput} onChange={(event) => setNameInput(event.currentTarget.value)} />
        </label>{' '}
        <button type="button" onClick={reconnect}>
          Reconnect
        </button>
      </p>

      <p>
        status: <strong>{status}</strong> | room: <strong>{activeRoom}</strong> | name:{' '}
        <strong>{activeName}</strong>
      </p>

      <p>
        <label>
          Message:{' '}
          <input
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
        </label>{' '}
        <button type="button" onClick={sendMessage} disabled={status !== 'open'}>
          Send
        </button>{' '}
        <button type="button" onClick={() => setTimeline([])}>
          Clear timeline
        </button>
      </p>

      <h2>Timeline</h2>
      {timeline.length === 0 ? (
        <p>No events yet. Join a room to start the stream.</p>
      ) : (
        <ul>
          {timeline.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.title}</strong> ({entry.meta}): {entry.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
