import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ActionInput, CaptainCall, DeckCard, NativeRow, Receipt, SourceDetail, SourceRef } from "../contract";
import type { rpcContract } from "../rpc";
import { Button } from "./ui/button";
import { useDeckRefresh } from "./useDeckPages";

const DELIVERY_LABEL: Record<Receipt["delivery"]["state"], string> = {
  pending: "Notice pending", sent: "Notice sent", queued: "Notice queued",
  failed: "Notice failed", uncertain: "Notice delivery uncertain", disabled: "Notice disabled",
};
const PROVENANCE_LABEL: Record<Receipt["provenance"], string> = {
  "panel-local": "Local client record — not human-attested",
  "chat-selected": "Explicitly selected committed native chat row — not human-attested",
  "producer-selected": "Producer-selected committed native chat row — not human-attested",
  "local-cli": "Local CLI record — not human-attested",
};

// The source prefixes anything it refused before committing; everything else
// (transport, crash, timeout) stays unconfirmed and keeps its retry identity.
const REJECTED_PREFIX = "Rejected: ";

function ReceiptDetail({ receipt, threadId, onUpdated }: { receipt: Receipt; threadId?: string; onUpdated: (receipt: Receipt) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delivery = async (retry: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onUpdated(retry
        ? await rpc.call("deck_delivery_retry", { receiptId: receipt.id, ...(threadId === undefined ? {} : { threadId }), acknowledgeDuplicateRisk: acknowledged })
        : await rpc.call("deck_delivery_check", { receiptId: receipt.id, ...(threadId === undefined ? {} : { threadId }) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="deck-receipt">
    <p><strong>Action receipt saved</strong> · {receipt.input.action} · generation {receipt.generation}</p>
    <p className="deck-muted">{new Date(receipt.createdAt).toLocaleString()} · {PROVENANCE_LABEL[receipt.provenance]}</p>
    {receipt.input.response ? <pre className="deck-original">{receipt.input.response}</pre> : null}
    {receipt.input.decision ? <p>Explicit decision: {receipt.input.decision}</p> : null}
    {receipt.input.optionId ? <p>Selected option: {receipt.input.optionId}</p> : null}
    {receipt.input.action === "defer" ? <p>{receipt.input.deferUntil == null ? "Explicit indefinite deferral" : `Deferred until ${new Date(receipt.input.deferUntil).toLocaleString()}`}</p> : null}
    {receipt.source ? <p className="deck-muted">Native row {receipt.source.rowId} · sequence {receipt.source.sourceSeqStart}–{receipt.source.sourceSeqEnd}</p> : null}
    <p role="status">{DELIVERY_LABEL[receipt.delivery.state]} · attempts {receipt.delivery.attempts}</p>
    {receipt.delivery.queueId ? <p>Queue: {receipt.delivery.queueId}</p> : null}
    {receipt.delivery.error ? <p role="alert">{receipt.delivery.error}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {receipt.delivery.state !== "disabled" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void delivery(false)}>Check delivery</Button> : null}
    {["failed", "uncertain", "pending", "queued"].includes(receipt.delivery.state) ? <div className="deck-stack">
      <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand retrying the notice may deliver a duplicate.</label>
      <Button size="sm" variant="outline" disabled={busy || !acknowledged} onClick={() => void delivery(true)}>Retry notice only</Button>
    </div> : null}
  </article>;
}

function CallSource({ taskId, call, threadId }: { taskId: string; call: CaptainCall; threadId?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setDetail(null); setText(""); setLoaded(false); setError(null); setBusy(false);
    return () => { epoch.current++; };
  }, [taskId, call.generation, threadId]);
  const load = async () => {
    const request = epoch.current;
    setBusy(true);
    try {
      const result = await rpc.call("deck_source", { taskId, generation: call.generation, ...(threadId === undefined ? {} : { threadId }), offset: loaded ? detail?.nextOffset ?? 0 : 0, limit: 8000 });
      if (request !== epoch.current) return;
      setText((previous) => loaded ? previous + (result?.text ?? "") : result?.text ?? "");
      setDetail(result); setLoaded(true); setError(null);
    } catch (cause) { if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === epoch.current) setBusy(false); }
  };
  return <section className="deck-stack" aria-label="Exact source">
    <h3>Exact source</h3>
    {call.source === null ? <p className="deck-muted">{call.provenance === "legacy" ? "Legacy call: no exact native source was recorded." : "Local CLI call: no exact native source was recorded."}</p> : <>
      <p className="deck-muted">Row {call.source.rowId} · turn {call.source.turnId} · sequence {call.source.sourceSeqStart}–{call.source.sourceSeqEnd}</p>
      <Button size="sm" variant="outline" onClick={() => navigate.toThread(call.source!.threadId)}>Open source thread</Button>
      {!loaded ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>Read exact source row</Button> : null}
    </>}
    {loaded && detail === null ? <p>No exact native source is available.</p> : null}
    {detail ? <>
      <p role="status">Source {detail.status}{detail.sourceCreatedAt === null ? "" : ` · ${new Date(detail.sourceCreatedAt).toLocaleString()}`}</p>
      {detail.status === "missing" ? <p>The original row is no longer available. The stored ask is not a verified substitute.</p> : null}
      {detail.status === "changed" ? <p>The native row no longer matches its recorded hash. Do not treat it as the original source.</p> : null}
      {detail.status === "too-large" ? <p>The source exceeds the safe detail bound. Open its native thread; no truncated replacement is treated as evidence.</p> : null}
      {text ? <pre className="deck-original">{text}</pre> : null}
      <p className="deck-muted">{text.length} of {detail.totalLength} characters</p>
      {detail.nextOffset !== null ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>Load more source text</Button> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

export function CallDetail({ taskId, threadId, onChanged }: { taskId: string; threadId?: string; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [task, setTask] = useState<DeckCard | null>(null);
  const [cardRemoved, setCardRemoved] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptCursor, setReceiptCursor] = useState<string | null>(null);
  const [historyCount, setHistoryCount] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState("");
  const [optionId, setOptionId] = useState<string | null>(null);
  const [deferDate, setDeferDate] = useState("");
  const [indefinite, setIndefinite] = useState(false);
  const [approval, setApproval] = useState<"approve" | "decline" | "">("");
  const [producerThread, setProducerThread] = useState<string | null>(threadId ?? null);
  const [candidates, setCandidates] = useState<NativeRow[] | null>(null);
  const [omittedRows, setOmittedRows] = useState<SourceRef[]>([]);
  const [candidateSeq, setCandidateSeq] = useState<number | undefined>();
  const [candidatesMore, setCandidatesMore] = useState(false);
  const [selectedRow, setSelectedRow] = useState<NativeRow | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [uncertain, setUncertain] = useState<ActionInput | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [cancellation, setCancellation] = useState<{ taskId: string; threadId?: string; generation: number; expectedRevision: number; operationId: string } | null>(null);
  const [cancelledGeneration, setCancelledGeneration] = useState<number | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const seen = useRef("");
  const requestKey = `captains-deck:operation:${threadId ?? "board"}:${taskId}`;
  const refresh = useCallback(() => {
    const request = ++epoch.current;
    void rpc.call("deck_get", { taskId, ...(threadId === undefined ? {} : { threadId }) }).then((result) => {
      if (request !== epoch.current) return;
      setTask(result.task);
      setReceipts((previous) => [...new Map([...previous, ...result.receipts].map((receipt) => [receipt.id, receipt])).values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
      setReceiptCursor(result.nextCursor);
      if (result.task.call) {
        const key = `${result.task.id}:${result.task.call.generation}`;
        if (seen.current !== key) {
          seen.current = key;
          void rpc.call("deck_seen", { taskId, generation: result.task.call.generation, ...(threadId === undefined ? {} : { threadId }) }).catch((cause) => {
            if (request === epoch.current) setError(`Could not mark seen: ${cause instanceof Error ? cause.message : String(cause)}`);
          });
        }
      }
    }, (cause: unknown) => {
      if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [rpc, taskId, threadId]);
  useEffect(() => {
    setTask(null); setCardRemoved(false); setReceipts([]); setReceiptCursor(null); setError(null); setCancelledGeneration(null);
    setResponse(""); setOptionId(null); setApproval(""); setCandidates(null); setOmittedRows([]); setSelectedRow(null); setCandidateSeq(undefined); setHistoryCount(5); seen.current = "";
    try { const stored = sessionStorage.getItem(requestKey); setUncertain(stored ? JSON.parse(stored) as ActionInput : null); } catch { setUncertain(null); }
    try { const stored = sessionStorage.getItem(`${requestKey}:cancel`); setCancellation(stored ? JSON.parse(stored) : null); } catch { setCancellation(null); }
    refresh();
    if (!threadId) void rpc.call("getSetup", null).then((setup) => setProducerThread(setup.valid ? setup.firstMateThreadId : null), () => setProducerThread(null));
    return () => { epoch.current++; };
  }, [refresh, rpc, requestKey, threadId]);
  useDeckRefresh(refresh, task?.call?.approvalScope?.expiresAt !== undefined && task.call.approvalScope.expiresAt > Date.now() ? task.call.approvalScope.expiresAt : null);
  useEffect(() => { setResponse(""); setOptionId(null); setApproval(""); setDeferDate(""); setIndefinite(false); setCandidates(null); setOmittedRows([]); setSelectedRow(null); setCandidateSeq(undefined); setCandidatesMore(false); setCandidateError(null); }, [task?.call?.generation]);
  const call = task?.call ?? null;

  const submit = async (input: ActionInput) => {
    if (inFlight.current) return;
    inFlight.current = true;
    epoch.current++;
    setBusy(true); setError(null); setUncertain(input);
    try { sessionStorage.setItem(requestKey, JSON.stringify(input)); } catch { /* Retry identity remains in memory. */ }
    try {
      const { response: _localResponse, ...association } = input;
      const result = input.source
        ? await rpc.call("deck_associate", { ...association, threadId: input.threadId!, source: input.source })
        : await rpc.call("deck_action", input);
      const updatedTask = result.task;
      if (updatedTask === null) { setTask(null); setCardRemoved(true); }
      else setTask((previous) => previous && previous.revision > updatedTask.revision ? previous : updatedTask);
      setReceipts((previous) => [result.receipt, ...previous.filter((receipt) => receipt.id !== result.receipt.id)]);
      setUncertain(null); setResponse(""); setSelectedRow(null);
      setCandidates(null);
      setOmittedRows([]);
      try { sessionStorage.removeItem(requestKey); } catch { /* Presentation storage is optional. */ }
      onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith(REJECTED_PREFIX)) {
        setUncertain(null);
        try { sessionStorage.removeItem(requestKey); } catch { /* Optional retry storage. */ }
        setError(`Action rejected: ${message.slice(REJECTED_PREFIX.length)}`);
        refresh();
      } else setError(`The response was not confirmed. It may already be saved. Retry the same operation safely: ${message}`);
    } finally { inFlight.current = false; setBusy(false); }
  };
  const action = (kind: ActionInput["action"], decision?: "approve" | "decline") => {
    if (!task || !call || uncertain) return;
    let deferUntil: number | null | undefined;
    if (kind === "defer") {
      deferUntil = indefinite ? null : new Date(deferDate).getTime();
      if (!indefinite && (!Number.isFinite(deferUntil) || deferUntil! <= Date.now())) { setError("Choose a future date or explicitly defer indefinitely."); return; }
    }
    void submit({ taskId, ...(threadId === undefined ? {} : { threadId }), expectedRevision: task.revision, generation: call.generation, operationId: crypto.randomUUID(), action: kind,
      ...(kind === "answer" ? { ...(response.trim() ? { response } : {}), optionId, ...(decision ? { decision } : {}) } : {}),
      ...(kind === "defer" ? { deferUntil } : {}) });
  };
  const loadCandidates = async (reset = false) => {
    if (!producerThread || !call || candidateBusy) return;
    const generation = call.generation;
    const request = epoch.current;
    setCandidateBusy(true);
    if (reset) setSelectedRow(null);
    try {
      const result = await rpc.call("deck_candidates", { threadId: producerThread, taskId, generation, ...(!reset && candidateSeq !== undefined ? { afterSeq: candidateSeq } : {}), limit: 30 });
      if (request !== epoch.current) return;
      setCandidates((previous) => [...new Map([...(reset ? [] : previous ?? []), ...result.rows].map((row) => [row.rowId, row])).values()]);
      setOmittedRows((previous) => [...new Map([...(reset ? [] : previous), ...result.omitted].map((ref) => [ref.rowId, ref])).values()]);
      setCandidateSeq(result.nextSeq); setCandidatesMore(result.hasMore); setCandidateError(null);
    } catch (cause) { if (request === epoch.current) setCandidateError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCandidateBusy(false); }
  };
  const associate = () => {
    if (!task || !call || !selectedRow || !producerThread || uncertain) return;
    const { threadId: sourceThread, turnId, rowId, sourceSeqStart, sourceSeqEnd, contentSha256 } = selectedRow;
    void submit({ taskId, threadId: producerThread, expectedRevision: task.revision, generation: call.generation, operationId: crypto.randomUUID(), action: "answer", optionId,
      ...(call.kind === "APPROVE" && approval ? { decision: approval } : {}),
      source: { threadId: sourceThread, turnId, rowId, sourceSeqStart, sourceSeqEnd, contentSha256 } });
  };
  const cancelPublication = async () => {
    if (inFlight.current || (!cancellation && !task?.pendingCall)) return;
    const input = cancellation ?? { taskId, ...(threadId === undefined ? {} : { threadId }), generation: task!.pendingCall!.generation, expectedRevision: task!.revision, operationId: crypto.randomUUID() };
    inFlight.current = true;
    epoch.current++;
    setBusy(true); setError(null); setCancellation(input);
    try { sessionStorage.setItem(`${requestKey}:cancel`, JSON.stringify(input)); } catch { /* Identity remains in memory. */ }
    try {
      const result = await rpc.call("deck_cancel_call", input);
      setTask((previous) => previous && previous.revision > result.revision ? previous : result); setCancellation(null);
      setCancelledGeneration(input.generation);
      try { sessionStorage.removeItem(`${requestKey}:cancel`); } catch { /* Optional presentation storage. */ }
      onChanged();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "Stale publication revision" || message === "No matching pending call") {
        setCancellation(null);
        try { sessionStorage.removeItem(`${requestKey}:cancel`); } catch { /* Optional retry storage. */ }
        setError(`Cancellation rejected: ${message}`);
        refresh();
      } else setError(`Cancellation is unconfirmed; retry the same cancellation: ${message}`);
    }
    finally { inFlight.current = false; setBusy(false); }
  };
  const loadReceipts = async () => {
    if (!receiptCursor || receiptBusy) return;
    const request = epoch.current;
    setReceiptBusy(true);
    try {
      const result = await rpc.call("deck_receipts", { taskId, threadId, cursor: receiptCursor, limit: 30 });
      if (request !== epoch.current) return;
      setReceipts((previous) => [...new Map([...previous, ...result.receipts].map((receipt) => [receipt.id, receipt])).values()]);
      setReceiptCursor(result.nextCursor);
    } catch (cause) { if (request === epoch.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setReceiptBusy(false); }
  };
  if (cardRemoved) return <div className="deck-detail deck-stack">
    <h2>Card removed</h2>
    <p>The action receipt remains saved. Removing a card does not erase its receipt or mean its notice was delivered.</p>
    {error ? <p role="alert">{error}</p> : null}
    <section className="deck-stack" aria-label="Action receipts">
      {receipts.map((receipt) => <ReceiptDetail key={receipt.id} receipt={receipt} threadId={threadId} onUpdated={(updated) => setReceipts((previous) => previous.map((item) => item.id === updated.id ? updated : item))} />)}
    </section>
    <Button variant="outline" onClick={() => navigate.toPluginPanel("board")}>Open full Deck</Button>
  </div>;
  if (!task) return <div className="deck-detail deck-stack">
    {error ? <p role="alert">{error}</p> : <p>Loading card…</p>}
    {uncertain ? <><p>An action response is unconfirmed. Retry its retained operation even if the card has since been removed.</p><Button disabled={busy} onClick={() => void submit(uncertain)}>Retry same action</Button></> : null}
    {cancellation ? <Button disabled={busy} onClick={() => void cancelPublication()}>Retry same cancellation</Button> : null}
    <Button variant="outline" onClick={refresh}>Refresh card</Button>
  </div>;
  const open = call?.status === "open" || call?.status === "deferred";
  const expired = call?.approvalScope?.expiresAt !== undefined && call.approvalScope.expiresAt <= Date.now();
  const selectedApprovalExpired = call?.approvalScope?.expiresAt !== undefined && call.approvalScope.expiresAt <= (selectedRow?.createdAt ?? Date.now());
  const publicationPending = task.pendingCall?.state === "pending";
  const publicationCancelled = task.pendingCall?.state === "failed" && task.pendingCall.error === "Cancelled";
  return <div className="deck-detail deck-stack">
    <header><h2>{task.title}</h2><p className="deck-muted">{task.id} · {task.kind.toUpperCase()} · work lane: {task.state} · revision {task.revision}</p></header>
    {task.brief ? <Markdown content={task.brief} /> : null}
    {task.threadId ? <Button variant="outline" size="sm" onClick={() => navigate.toThread(task.threadId!)}>Open worker thread</Button> : null}
    {task.prUrl ? <UrlLink href={task.prUrl}>Pull request</UrlLink> : null}
    {error ? <p role="alert">{error}</p> : null}
    {cancelledGeneration !== null ? <p role="status">Unpublished generation {cancelledGeneration} cancelled. The existing Captain call and work lane were preserved.</p> : null}
    {task.pendingCall ? <section className="deck-receipt" aria-label="Pending publication">
      <h3>Call publication {publicationCancelled ? "cancelled" : task.pendingCall.state}</h3>
      <p>Generation {task.pendingCall.generation} · {task.pendingCall.payload.ask}</p>
      {task.pendingCall.error ? <p role={publicationCancelled ? "status" : "alert"}>{task.pendingCall.error}</p> : null}
      <p>The existing call remains current. Only a pending publication temporarily locks its controls; failed or cancelled proposals do not close it.</p>
      {!publicationCancelled || cancellation ? <Button size="sm" variant="outline" disabled={busy || !!uncertain} onClick={() => void cancelPublication()}>{cancellation ? "Retry same cancellation" : "Cancel unpublished call"}</Button> : null}
    </section> : cancellation ? <section className="deck-receipt"><p>Publication cancellation is unconfirmed; its operation key is retained.</p><Button disabled={busy || !!uncertain} onClick={() => void cancelPublication()}>Retry same cancellation</Button></section> : null}
    {call ? <>
      <section className="deck-stack" aria-label="Current Captain call"><p><strong>{call.kind}</strong> · {call.status} · generation {call.generation}</p><h3>Ask</h3><Markdown content={call.ask} />
        <p className="deck-muted">Asked {call.askedAt}{call.answeredAt ? ` · answered ${call.answeredAt}` : ""}</p>
        {!open && call.options.length ? <ul>{call.options.map((option) => <li key={option.id}>{option.label}{option.id === call.recommendedId ? " — recommended" : ""}{option.detail ? <p>{option.detail}</p> : null}</li>)}</ul> : null}
        {call.answerLabel || call.answerNote ? <section aria-label="Current recorded response"><h3>{call.kind === "DO" && open ? "Latest recorded clarification" : "Recorded response"}</h3>{call.answerLabel ? <p>{call.answerLabel}</p> : null}{call.answerNote ? <pre className="deck-original">{call.answerNote}</pre> : null}</section> : null}
        {call.recommendation ? <><h3>Recommendation</h3><Markdown content={call.recommendation} /></> : null}
        {call.context ? <><h3>Context</h3><Markdown content={call.context} /></> : null}
        {call.deferUntil !== null && call.status === "deferred" ? <p>Deferred until {new Date(call.deferUntil).toLocaleString()}</p> : call.status === "deferred" ? <p>Deferred indefinitely; still unresolved.</p> : null}
        {call.approvalScope ? <section className="deck-receipt" aria-label="Exact approval scope"><h3>Exact approval scope</h3><dl><dt>Action</dt><dd>{call.approvalScope.action}</dd><dt>Target</dt><dd>{call.approvalScope.target}</dd><dt>Constraints</dt><dd>{call.approvalScope.constraints}</dd><dt>Expiry</dt><dd>{call.approvalScope.expiresAt === undefined ? "No expiry specified" : new Date(call.approvalScope.expiresAt).toLocaleString()}</dd></dl>{expired ? <p role="alert">This approval scope has expired.</p> : null}<p>Recording approval does not execute external work.</p></section> : null}
        {call.evidence.length ? <section aria-label="Evidence"><h3>Evidence</h3><ul>{call.evidence.map((item, index) => <li key={index}>{item.url ? <UrlLink href={item.url}>{item.label}</UrlLink> : item.label}{item.threadId ? <Button size="sm" variant="link" onClick={() => navigate.toThread(item.threadId!)}>Open evidence thread</Button> : null}{item.rowId ? <span className="deck-muted"> row {item.rowId} (thread link is not an exact row link)</span> : null}</li>)}</ul></section> : null}
      </section>
      <CallSource key={`${taskId}:${call.generation}`} taskId={taskId} call={call} threadId={threadId} />
      {uncertain ? <section className="deck-receipt"><p role="status">An action response is unconfirmed. Its operation key is retained; retry will not repeat the action.</p><Button disabled={busy} onClick={() => void submit(uncertain)}>{busy ? "Saving…" : "Retry same action"}</Button><Button variant="outline" onClick={refresh}>Refresh saved state</Button></section> : null}
      {open ? <fieldset className="deck-stack" disabled={busy || !!uncertain || !!cancellation || publicationPending}>
        <legend>Record a response</legend>
        <p className="deck-muted">Local client record, not a human attestation. {call.kind === "DO" ? "Answer records clarification; only Complete DO clears this action. Neither lands the work." : "Answer resolves this action only; it does not change the work lane."}</p>
        {call.options.length ? <div role="radiogroup" aria-label="Call options" className="deck-stack">{call.options.map((option) => <label key={option.id} className="deck-option"><input type="radio" name={`option-${taskId}`} checked={optionId === option.id} onChange={() => setOptionId(option.id)} /><span>{option.label}{option.id === call.recommendedId ? " — recommended" : ""}{option.detail ? <small>{option.detail}</small> : null}</span></label>)}<Button variant="ghost" size="sm" onClick={() => setOptionId(null)}>Clear option</Button></div> : null}
        <label>Response<textarea aria-label="Response" rows={3} maxLength={16000} value={response} onChange={(event) => setResponse(event.target.value)} /></label>
        <div className="deck-actions">{call.kind === "APPROVE" ? <><Button disabled={expired} onClick={() => action("answer", "approve")}>Approve exact scope</Button><Button variant="outline" onClick={() => action("answer", "decline")}>Decline exact scope</Button></> : <Button disabled={!response.trim() && !optionId} onClick={() => action("answer")}>{call.kind === "DO" ? "Save clarification" : "Save answer"}</Button>}{call.kind === "DO" ? <Button onClick={() => action("complete")}>Complete DO</Button> : null}</div>
        <div className="deck-receipt deck-stack"><label>Defer until<input aria-label="Defer until" type="datetime-local" value={deferDate} disabled={indefinite} onChange={(event) => setDeferDate(event.target.value)} /></label><label><input type="checkbox" checked={indefinite} onChange={(event) => setIndefinite(event.target.checked)} /> Defer indefinitely (still unresolved)</label><Button variant="outline" onClick={() => action("defer")}>Defer call</Button></div>
        <Button variant="outline" onClick={() => action("dismiss")}>Dismiss without approval or completion</Button>
      </fieldset> : <Button disabled={busy || !!uncertain || !!cancellation || publicationPending} onClick={() => action("reopen")}>Reopen call as a new generation</Button>}
      {open ? <section className="deck-stack" aria-label="Associate native chat response"><h3>Choose a committed native chat response</h3><p>No chat row is associated automatically. Select the exact original row for this card and generation {call.generation}. Selection does not establish keyboard-human authority.</p>{producerThread && call.replyThreadId === producerThread ? <Button variant="outline" size="sm" disabled={candidateBusy} onClick={() => void loadCandidates(true)}>{candidates === null ? "Browse native responses" : "Refresh native responses"}</Button> : <p>No matching reply thread was bound to this call; native association is unavailable.</p>}
        {candidateError ? <p role="alert">Native responses unavailable: {candidateError}. Oversized rows cannot be substituted with truncated text.</p> : null}
        {omittedRows.map((ref) => <p key={ref.rowId} className="deck-muted">Native row {ref.rowId} exceeds the association limit; no truncated substitute is used. <Button variant="link" size="sm" onClick={() => navigate.toThread(ref.threadId)}>Open original conversation</Button></p>)}
        {candidates?.length === 0 ? <p>No eligible committed native user rows in this page.</p> : null}
        {candidates?.map((row) => <label className="deck-option" key={row.rowId}><input type="radio" name={`native-${taskId}`} disabled={row.role !== "user" || !row.completed} checked={selectedRow?.rowId === row.rowId} onChange={() => setSelectedRow(row)} /><span><strong>{row.rowId}</strong> · {new Date(row.createdAt).toLocaleString()}<small>Native {row.role} · initiator {row.initiator ?? "unspecified"} · sender {row.senderThreadId ?? "not recorded"} · {row.completed ? "committed" : "not committed"}</small><pre className="deck-original">{row.text}</pre></span></label>)}
        {candidatesMore ? <Button variant="outline" size="sm" disabled={candidateBusy} onClick={() => void loadCandidates()}>Load more native responses</Button> : null}
        {call.kind === "APPROVE" ? <label>Explicit selected-row decision<select aria-label="Selected native decision" value={approval} onChange={(event) => setApproval(event.target.value as "approve" | "decline" | "")}><option value="">Choose, never inferred</option><option value="approve">Approve exact scope</option><option value="decline">Decline exact scope</option></select></label> : null}
        {call.kind === "APPROVE" && selectedRow ? <p className="deck-muted">The whole original response must be an unqualified “approve” or “decline” (“I approve” is accepted) matching your selection. Conditional or negated wording stays open for a fresh response. Expiry is checked against that row&apos;s timestamp, not the time you associate it.</p> : null}
        <Button disabled={!selectedRow || busy || !!uncertain || !!cancellation || publicationPending || (call.kind === "APPROVE" && (!approval || (approval === "approve" && selectedApprovalExpired)))} onClick={associate}>Associate selected row as {call.kind === "DO" ? "clarification" : "answer"}</Button>
      </section> : null}
    </> : <p>No current Captain call. Work and worker status do not create one.</p>}
    {task.history.length ? <section className="deck-stack" aria-label="Earlier calls">
      <h3>Earlier calls ({task.history.length})</h3>
      {task.history.slice(0, historyCount).map((previous) => <details key={previous.generation}>
        <summary>{previous.kind} · generation {previous.generation} · {previous.status} · {previous.ask}</summary>
        <div className="deck-stack">
          <Markdown content={previous.ask} />
          <p className="deck-muted">Asked {previous.askedAt}{previous.answeredAt ? ` · answered ${previous.answeredAt}` : ""}</p>
          {previous.recommendation ? <><h3>Recommendation</h3><Markdown content={previous.recommendation} /></> : null}
          {previous.context ? <><h3>Context</h3><Markdown content={previous.context} /></> : null}
          {previous.options.length ? <ul>{previous.options.map((option) => <li key={option.id}>{option.label}{option.id === previous.recommendedId ? " — recommended" : ""}{option.detail ? <p>{option.detail}</p> : null}</li>)}</ul> : null}
          {previous.approvalScope ? <div><h3>Exact approval scope</h3><p>{previous.approvalScope.action} · {previous.approvalScope.target}</p><p>{previous.approvalScope.constraints}</p><p>Expiry: {previous.approvalScope.expiresAt === undefined ? "None specified" : new Date(previous.approvalScope.expiresAt).toLocaleString()}</p></div> : null}
          {previous.evidence.length ? <ul>{previous.evidence.map((item, index) => <li key={index}>{item.url ? <UrlLink href={item.url}>{item.label}</UrlLink> : item.label}{item.threadId ? <Button size="sm" variant="link" onClick={() => navigate.toThread(item.threadId!)}>Open evidence thread</Button> : null}{item.rowId ? ` · row ${item.rowId}` : ""}</li>)}</ul> : null}
          <p>{previous.answerLabel ?? "No selected answer"}</p>
          {previous.answerNote ? <pre className="deck-original">{previous.answerNote}</pre> : null}
          <CallSource taskId={taskId} call={previous} threadId={threadId} />
        </div>
      </details>)}
      {historyCount < task.history.length ? <Button variant="outline" size="sm" onClick={() => setHistoryCount((count) => count + 5)}>Load more earlier calls</Button> : null}
    </section> : null}
    <section className="deck-stack" aria-label="Action receipts"><h3>Action receipts and notice delivery</h3>{receipts.length === 0 ? <p>No recorded action receipts.</p> : null}{receipts.map((receipt) => <ReceiptDetail key={receipt.id} receipt={receipt} threadId={threadId} onUpdated={(updated) => setReceipts((previous) => previous.map((item) => item.id === updated.id ? updated : item))} />)}{receiptCursor ? <Button variant="outline" size="sm" disabled={receiptBusy} onClick={() => void loadReceipts()}>Load more receipts</Button> : null}</section>
  </div>;
}
