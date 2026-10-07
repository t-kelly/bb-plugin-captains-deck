import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../rpc";
import { Button } from "./ui/button";
import { CallDetail } from "./CallDetail";
import { useDeckPages, useDeckRefresh } from "./useDeckPages";

type Setup = { firstMateThreadId: string; valid: boolean; reason: string | null };

function ScopedAttention({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const [view, setView] = useState<"attention" | "deferred" | "closed">("attention");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const { tasks, page, loading, error, loadMore, refresh } = useDeckPages(threadId, view);
  return <div className="deck-attention">
    <header className="deck-attention-header deck-stack">
      <h1>Needs my attention</h1>
      <p className="deck-muted">Explicit Captain calls only. Your native conversation stays in the thread alongside this tab.</p>
      <p role="status">{page ? `${page.counts.unresolved} unresolved · ${page.counts.unseen} unseen · ${page.counts.attention} open or due` : "Loading counts…"}</p>
      <p className="deck-muted">Unseen is a reading badge, not unresolved work. Opening a call marks it seen, never resolves it.</p>
      <div className="deck-actions" role="group" aria-label="Call views">
        <Button size="sm" variant={view === "attention" ? "default" : "outline"} onClick={() => { setView("attention"); setActiveTaskId(null); }}>Open / due ({page?.counts.attention ?? "…"})</Button>
        <Button size="sm" variant={view === "deferred" ? "default" : "outline"} onClick={() => { setView("deferred"); setActiveTaskId(null); }}>Deferred ({page?.counts.deferred ?? "…"})</Button>
        <Button size="sm" variant={view === "closed" ? "default" : "outline"} onClick={() => { setView("closed"); setActiveTaskId(null); }}>Closed ({page?.counts.closed ?? "…"})</Button>
      </div>
      <Button size="sm" variant="ghost" disabled={loading} onClick={refresh}>Refresh calls</Button>
    </header>
    <main className="deck-attention-scroll">
      {error ? <p role="alert">{error}</p> : null}
      {activeTaskId ? <>
        <div className="deck-actions"><Button variant="outline" size="sm" onClick={() => setActiveTaskId(null)}>Back to calls</Button><Button variant="outline" size="sm" onClick={() => navigate.toPluginPanel("board", { subPath: `task/${encodeURIComponent(activeTaskId)}` })}>Open card on full Deck</Button></div>
        <CallDetail key={activeTaskId} taskId={activeTaskId} threadId={threadId} onChanged={refresh} />
      </> : <div className="deck-stack">
        {tasks === null ? <p>Loading calls…</p> : tasks.length === 0 ? <p>{view === "attention" ? "No explicit open or due Captain calls. Worker failures and finished notices do not belong here." : `No ${view} calls.`}</p> : tasks.map((task) => <button type="button" key={task.id} className="deck-attention-card" onClick={() => setActiveTaskId(task.id)}>
          <span className="deck-muted">{task.call?.kind} · {task.call?.status} · work: {task.state}{task.call && task.seenGeneration < task.call.generation ? " · unseen" : ""}</span>
          <strong>{task.title}</strong>
          <span>{task.call?.ask}</span>
          {task.call?.recommendation ? <span className="deck-muted">Recommendation: {task.call.recommendation}</span> : null}
          {task.call?.approvalScope ? <span className="deck-muted">Scope: {task.call.approvalScope.action} · {task.call.approvalScope.target}</span> : null}
        </button>)}
        {tasks ? <p className="deck-muted">Showing {tasks.length} of {page ? view === "attention" ? page.counts.attention : view === "deferred" ? page.counts.deferred : page.counts.closed : "…"} calls</p> : null}
        {page?.nextCursor ? <Button variant="outline" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more calls"}</Button> : null}
      </div>}
    </main>
  </div>;
}

export function AttentionPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [scope, setScope] = useState<{ threadId: string; setup: Setup } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(() => {
    const request = ++epoch.current;
    void rpc.call("getSetup", null).then((setup) => {
      if (request !== epoch.current) return;
      setScope({ threadId, setup }); setError(null);
    }, (cause: unknown) => {
      if (request !== epoch.current) return;
      setScope(null); setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, threadId]);
  useEffect(() => { setScope(null); setError(null); refresh(); return () => { epoch.current++; }; }, [refresh]);
  useDeckRefresh(refresh);
  if (error) return <div className="deck-detail deck-stack"><h1>Needs my attention unavailable</h1><p role="alert">{error}</p><Button variant="outline" onClick={refresh}>Check setup again</Button></div>;
  if (scope === null || scope.threadId !== threadId) return <div className="deck-detail"><p>Checking configured conversation…</p></div>;
  if (!scope.setup.valid || scope.setup.firstMateThreadId !== threadId) return <div className="deck-detail deck-stack"><h1>Needs my attention</h1><p>This tab is only available inside the configured Chief of Staff conversation. No Deck contents or actions are loaded in this thread.</p>{scope.setup.reason ? <p className="deck-muted">{scope.setup.reason}</p> : null}<p className="deck-muted">The public host launcher may show this entry in other threads; it does not grant access.</p><Button variant="outline" onClick={refresh}>Check setup again</Button></div>;
  return <ScopedAttention key={threadId} threadId={threadId} />;
}
