import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** 重新載入（保留目前資料直到新資料回來） */
  reload: () => Promise<void>;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/**
 * 簡易資料載入 hook：deps 改變時重新載入；元件卸載或 deps 再變動時忽略過期的回應。
 * 用法：const { data, loading, error, reload } = useQuery(() => api.get<Brand[]>('/brands'), []);
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (id === seq.current) setDataState(result);
    } catch (err) {
      if (id === seq.current) setError(err);
    } finally {
      if (id === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | undefined) => T)(prev) : updater));
  }, []);

  return { data, error, loading, reload: load, setData };
}
