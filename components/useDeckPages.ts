import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { CardsPage, DeckCard } from "../contract";
import type { rpcContract } from "../rpc";

export function useDeckRefresh(refresh: () => void, nextDueAt: number | null = null, serverNow?: number) {
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  const connectedOnce = useRef(connection === "connected");
  useRealtime("deck-changed", refresh);
  useEffect(() => {
    const was = previousConnection.current;
    previousConnection.current = connection;
    if (connection === "connected") {
      if (connectedOnce.current && was !== "connected") refresh();
      connectedOnce.current = true;
    }
  }, [connection, refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (nextDueAt === null) return;
    // The server's clock determines due eligibility, not this client's clock.
    const delay = Math.min(2_147_483_647, Math.max(1, nextDueAt - (serverNow ?? Date.now()) + 25));
    const timer = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timer);
  }, [nextDueAt, serverNow, refresh]);
}

export function useDeckPages(threadId?: string, view: "attention" | "deferred" | "closed" = "attention") {
  const rpc = useRpc<typeof rpcContract>();
  const [tasks, setTasks] = useState<DeckCard[] | null>(null);
  const [page, setPage] = useState<CardsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const loadedPages = useRef(1);
  const busy = useRef(false);
  const cursor = useRef<string | null>(null);
  const fetchPage = useCallback((next?: string) => threadId
    ? rpc.call("deck_calls", { threadId, view, ...(next === undefined ? {} : { cursor: next }), limit: 100 })
    : rpc.call("deck_board", { ...(next === undefined ? {} : { cursor: next }), limit: 100 }), [rpc, threadId, view]);

  const refresh = useCallback(() => {
    const request = ++epoch.current;
    busy.current = true;
    setLoading(true);
    void (async () => {
      try {
        const all: DeckCard[] = [];
        let result: CardsPage | null = null;
        let next: string | undefined;
        let pages = 0;
        // Replay the loaded window against a fresh cursor snapshot atomically.
        // A realtime refresh must not silently drop pages already loaded.
        for (; pages < loadedPages.current; pages++) {
          result = await fetchPage(next);
          if (request !== epoch.current) return;
          all.push(...result.tasks);
          if (!result.nextCursor) { pages++; break; }
          next = result.nextCursor;
        }
        if (request !== epoch.current || result === null) return;
        loadedPages.current = pages;
        cursor.current = result.nextCursor;
        setTasks([...new Map(all.map((task) => [task.id, task])).values()]);
        setPage(result);
        setError(null);
      } catch (cause) {
        if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request === epoch.current) { busy.current = false; setLoading(false); }
      }
    })();
  }, [fetchPage]);

  useEffect(() => {
    loadedPages.current = 1;
    cursor.current = null;
    setTasks(null);
    setPage(null);
    refresh();
    return () => { epoch.current++; busy.current = false; };
  }, [refresh]);
  useDeckRefresh(refresh, page?.nextDueAt ?? null, page?.serverNow);

  const loadMore = async () => {
    if (busy.current || cursor.current === null) return;
    const request = epoch.current;
    const next = cursor.current;
    busy.current = true;
    setLoading(true);
    try {
      const result = await fetchPage(next);
      if (request !== epoch.current) return;
      loadedPages.current++;
      cursor.current = result.nextCursor;
      setTasks((previous) => [...new Map([...(previous ?? []), ...result.tasks].map((task) => [task.id, task])).values()]);
      setPage(result);
      setError(null);
    } catch (cause) {
      if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === epoch.current) { busy.current = false; setLoading(false); }
    }
  };
  return { tasks, page, error, loading, refresh, loadMore };
}
