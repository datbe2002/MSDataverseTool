// Data read once per environment (and key) while the app runs: the plug-in
// catalog, users, roles, a role's privileges… Refresh reads it again.
import { useEffect } from "react";
import { create } from "zustand";
import { friendlyError } from "./errors";

interface CacheState<T> {
  data: Record<string, T>;
  errors: Record<string, string>;
  loading: Record<string, boolean>;
}

export interface CacheEntry<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

export function createEnvCache<T>(fetch: (connId: string, key: string) => Promise<T>) {
  const useStore = create<CacheState<T>>(() => ({ data: {}, errors: {}, loading: {} }));
  const inflight = new Map<string, Promise<T>>();
  const id = (connId: string, key: string) => `${connId}|${key}`;

  /** The value, read if it isn't cached yet (or `force`). */
  function load(connId: string, key = "", force = false): Promise<T> {
    const k = id(connId, key);
    const s = useStore.getState();
    if (!force && k in s.data) return Promise.resolve(s.data[k]);
    const pending = inflight.get(k);
    if (pending) return pending;
    useStore.setState((st) => ({ loading: { ...st.loading, [k]: true }, errors: omit(st.errors, k) }));
    const p = fetch(connId, key)
      .then((v) => {
        useStore.setState((st) => ({ data: { ...st.data, [k]: v }, loading: omit(st.loading, k) }));
        return v;
      })
      .catch((e) => {
        useStore.setState((st) => ({ errors: { ...st.errors, [k]: friendlyError(String(e)) }, loading: omit(st.loading, k) }));
        throw e;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  /** The cached entry for `key`, read on first use (unless `connId` is null). */
  function useEntry(connId: string | null, key = ""): CacheEntry<T> & { reload: () => void } {
    const k = connId ? id(connId, key) : "";
    const data = useStore((s) => (k ? s.data[k] : undefined));
    const error = useStore((s) => (k ? s.errors[k] : undefined));
    const loading = useStore((s) => (k ? !!s.loading[k] : false));
    // Also when the value is dropped (forget) while shown.
    const missing = data === undefined && error === undefined && !loading;
    useEffect(() => {
      if (connId && missing) load(connId, key).catch(() => {});
    }, [connId, key, missing]);
    return { data, error, loading, reload: () => connId && load(connId, key, true).catch(() => {}) };
  }

  /** Drops everything read for `connId` (Refresh); what's on screen reads again. */
  function forget(connId: string) {
    const keep = <V,>(r: Record<string, V>) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith(`${connId}|`)));
    useStore.setState((s) => ({ data: keep(s.data), errors: keep(s.errors) }));
  }

  return { useStore, load, useEntry, forget };
}

function omit<V>(r: Record<string, V>, k: string): Record<string, V> {
  const { [k]: _, ...rest } = r;
  return rest;
}
