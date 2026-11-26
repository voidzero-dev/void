import { useNavigation } from '@void/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import preventDragging from '../lib/preventDragging.ts';
import '../app.css';

export default function Layout({ children }: { children: ReactNode }) {
  const navigation = useNavigation();
  const isLoading = navigation.state !== 'idle';

  useEffect(() => preventDragging(), []);

  return (
    <>
      {isLoading && <div className="nav-progress loading" />}
      {children}
    </>
  );
}
