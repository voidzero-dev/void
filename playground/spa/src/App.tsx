import { useState, useEffect } from 'react';
import { fetch } from 'void/client';

export default function App() {
  const [hello, setHello] = useState<{ message: string; timestamp: number } | null>(null);
  const [users, setUsers] = useState<
    ReadonlyArray<{ id: number; name: string; email: string; createdAt: string | null }>
  >([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    void fetch('/api/hello').then(setHello);
    void fetch('/api/users').then(setUsers);
  }, []);

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/users', {
      method: 'POST',
      body: { name, email },
    });
    setName('');
    setEmail('');
    void fetch('/api/users').then(setUsers);
  }

  return (
    <div>
      <h1>Void Playground</h1>

      <h2>Hello API</h2>
      <pre>{JSON.stringify(hello, null, 2)}</pre>

      <h2>Users</h2>
      <pre>{JSON.stringify(users, null, 2)}</pre>

      <h2>Create User</h2>
      <form onSubmit={createUser}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">Create</button>
      </form>
    </div>
  );
}
