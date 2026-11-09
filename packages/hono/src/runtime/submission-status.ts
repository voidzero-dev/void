import { useEffect, useRef, useState } from 'hono/jsx';
import type { VoidActionError } from 'void/pages-client';

export type SubmissionStatus = {
  pending: boolean;
  error: VoidActionError | null;
  wasSuccessful: boolean;
  recentlySuccessful: boolean;
  setError(error: VoidActionError | null): void;
  begin(): void;
  succeed(): void;
  end(): void;
};

/** The flags `useForm()` and `useIslandForm()` report about their last submission. */
export function useSubmissionStatus(): SubmissionStatus {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<VoidActionError | null>(null);
  const [wasSuccessful, setWasSuccessful] = useState(false);
  const [recentlySuccessful, setRecentlySuccessful] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSuccessTimeout = () => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }
  };
  useEffect(() => clearSuccessTimeout, []);

  return {
    pending,
    error,
    wasSuccessful,
    recentlySuccessful,
    setError,
    begin() {
      setPending(true);
      setWasSuccessful(false);
      setRecentlySuccessful(false);
      clearSuccessTimeout();
      setError(null);
    },
    succeed() {
      setWasSuccessful(true);
      setRecentlySuccessful(true);
      successTimeoutRef.current = setTimeout(() => setRecentlySuccessful(false), 2000);
    },
    end() {
      setPending(false);
    },
  };
}
