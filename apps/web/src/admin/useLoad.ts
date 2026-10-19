'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type LoadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly error: unknown };

/** Loads data once on mount; `reload()` fetches it again after a change. */
export function useLoad<T>(load: () => Promise<T>): {
  readonly state: LoadState<T>;
  readonly reload: () => Promise<void>;
} {
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const reload = useCallback(async () => {
    try {
      setState({ status: 'ready', data: await loader.current() });
    } catch (error) {
      setState({ status: 'error', error });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { state, reload };
}
