import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { actionInputSchema, callPayloadSchema, workStateSchema, type ActionInput, type CallPayload, type DeckCard, type Receipt } from "./contract";
import type { DeckStore, TaskPatch } from "./store";

export function registerDeckCli(bb: BbPluginApi, store: DeckStore, handlers: {
  changed: () => void;
  ask: (taskId: string, expectedRevision: number, payload: CallPayload, threadId?: string) => Promise<DeckCard>;
  action: (input: ActionInput, provenance: "local-cli") => Promise<{ task: DeckCard | null; receipt: Receipt }>;
}) {
  const commands = [
    { name: "chart", summary: "Add work to Charted Next", usage: "bb deck chart --title <title> [--brief <text>] [--kind ship|scout] [--project <id>] [--bot <name>] [--thread <id>]" },
    { name: "start", summary: "Move work to Underway", usage: "bb deck start <task-id> [--thread <id>] [--revision <n>]" },
    { name: "ask", summary: "Open a typed local Captain's Call; native sources are not invented", usage: "bb deck ask <task-id> --question <text> [--kind DO|DECIDE|APPROVE] [--option '<label> :: <detail>'] [--recommend <number|label>] [--recommendation <text>] [--context <text>] [--revision <n>] [--scope-action <text> --scope-target <text> --scope-constraints <text> --expires-at <epoch-ms>]" },
    { name: "note", summary: "Set a work status note", usage: "bb deck note <task-id> --text <text> [--revision <n>]" },
    { name: "merge", summary: "Move work to Awaiting Merge", usage: "bb deck merge <task-id> [--pr <url>] [--revision <n>]" },
    { name: "land", summary: "Mark underlying work landed", usage: "bb deck land <task-id> [--revision <n>]" },
    { name: "fail", summary: "Mark underlying work failed", usage: "bb deck fail <task-id> [--reason <text>] [--revision <n>]" },
    { name: "move", summary: "Set the work lane, independently of Captain actions", usage: "bb deck move <task-id> <charted|underway|decision|merge|landed|failed> [--revision <n>]" },
    { name: "list", summary: "Page all Deck cards", usage: "bb deck list [--cursor <cursor>] [--limit <1..100>] [--json]" },
    { name: "show", summary: "Show a card, call and history", usage: "bb deck show <task-id> [--json]" },
    { name: "bearings", summary: "Page the fleet digest", usage: "bb deck bearings [--cursor <cursor>] [--limit <1..100>] [--json]" },
    { name: "remove", summary: "Remove work; preserve action receipts and generation history", usage: "bb deck remove <task-id> [--revision <n>]" },
    ...["answer", "complete", "defer", "dismiss", "reopen"].map((name) => ({ name, summary: `Record ${name} on the current Captain action, not the work lane`, usage: `bb deck ${name} <task-id> --revision <n> --generation <n> --operation <id> [--response <text>] [--option <id>] [--decision approve|decline] [--until <epoch-ms>|--indefinite] [--json]` })),
    { name: "export", summary: "Export all authoritative Deck state for recovery", usage: "bb deck export --json" },
    { name: "import", summary: "Restore an empty Deck or replay an exact snapshot", usage: "bb deck import --snapshot <json> --json" },
  ];
  const usage = ["Usage:", ...commands.map((command) => `  ${command.usage}`)].join("\n");
  bb.cli.register({ name: "deck", summary: "Chart and move work; record typed Captain calls and actions", commands, async run(argv) {
    const flags = new Map<string, string[]>();
    const positionals: string[] = [];
    const booleanFlags: Record<string, true> = { json: true, indefinite: true };
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]!;
      if (!arg.startsWith("--")) { positionals.push(arg); continue; }
      const name = arg.slice(2);
      let value = "true";
      if (!booleanFlags[name] && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) value = argv[++index]!;
      flags.set(name, [...(flags.get(name) ?? []), value]);
    }
    const flag = (name: string) => flags.get(name)?.at(-1) ?? null;
    const json = flags.has("json");
    const [command, id, ...rest] = positionals;
    const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
    const formatTask = (task: DeckCard) => `${task.id}  ${task.title}  [${task.state} · ${task.kind}${task.bot ? ` · ${task.bot}` : ""}${task.threadId ? ` · thread ${task.threadId}` : ""}${task.prUrl ? ` · ${task.prUrl}` : ""}] revision ${task.revision}${task.call ? `; ${task.call.kind} generation ${task.call.generation} ${task.call.status}` : ""}`;
    try {
      if (!command || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      if (command === "chart") {
        const title = flag("title") ?? positionals.slice(1).join(" ").trim();
        if (!title) throw new Error("A title is required");
        const kind = flag("kind") ?? "ship";
        if (kind !== "ship" && kind !== "scout") throw new Error('--kind must be "ship" or "scout"');
        const task = store.createTask({ title, brief: flag("brief"), kind, projectId: flag("project"), bot: flag("bot"), threadId: flag("thread") });
        handlers.changed(); return reply(task, `Charted ${formatTask(task)}`);
      }
      if (command === "list" || command === "bearings") {
        const page = store.listBoard({ ...(flag("cursor") ? { cursor: flag("cursor")! } : {}), limit: flag("limit") ? Number(flag("limit")) : 50 });
        if (command === "list") return reply(page, [...page.tasks.map(formatTask), ...(page.nextCursor ? [`Next page: --cursor ${page.nextCursor}`] : [])].join("\n") || "No deck tasks.");
        // Unresolved calls are queried directly: an old call must not slide off
        // the lane page while newer cards churn.
        const calls = store.listCalls({ threadId: "cli", view: "attention", limit: 100 });
        const deferred = store.listCalls({ threadId: "cli", view: "deferred", limit: 100 });
        const sections = [
          { title: "Charted Next", tasks: page.tasks.filter((task) => task.state === "charted") },
          { title: "Underway", tasks: page.tasks.filter((task) => task.state === "underway" || task.state === "failed") },
          { title: "Captain's Call", tasks: [...calls.tasks, ...deferred.tasks.filter((task) => !calls.tasks.some((open) => open.id === task.id))] },
          { title: "Awaiting Merge", tasks: page.tasks.filter((task) => task.state === "merge") },
          { title: "Recently Landed", tasks: page.tasks.filter((task) => task.state === "landed") },
        ];
        return reply({ ...page, sections, callsNextCursor: calls.nextCursor }, ["Bearings (lanes on this page; calls across the whole Deck)",
          ...sections.flatMap((section) => [section.title, ...section.tasks.map(formatTask)]),
          `Unresolved ${page.counts.unresolved}; unseen ${page.counts.unseen}`,
          ...(calls.nextCursor ? [`More unresolved calls remain beyond this page.`] : []),
          ...(page.nextCursor ? [`Next lane page: --cursor ${page.nextCursor}`] : [])].join("\n"));
      }
      if (command === "export") return reply(store.exportSnapshot(), "Use --json to export the complete recovery snapshot.");
      if (command === "import") {
        const snapshot = flag("snapshot");
        if (!snapshot) throw new Error("--snapshot JSON is required; no server-local file paths are read");
        const result = store.importSnapshot(JSON.parse(snapshot)); handlers.changed(); return reply(result, `Restored ${result.imported} cards`);
      }
      if (!id) throw new Error("A task id is required");
      if (["answer", "complete", "defer", "dismiss", "reopen"].includes(command)) {
        if (!flag("revision") || !flag("generation") || !flag("operation")) throw new Error("--revision, --generation and --operation are required; inspect bb deck show first");
        if (flags.has("until") && flags.has("indefinite")) throw new Error("Choose --until or --indefinite, not both");
        const input = actionInputSchema.parse({ taskId: id, expectedRevision: Number(flag("revision")), generation: Number(flag("generation")), operationId: flag("operation"), action: command, ...(flag("response") !== null || flag("note") !== null ? { response: flag("response") ?? flag("note")! } : {}), ...(flag("option") ? { optionId: flag("option") } : {}), ...(flag("decision") ? { decision: flag("decision") } : {}), ...(flags.has("indefinite") ? { deferUntil: null } : flag("until") ? { deferUntil: Number(flag("until")) } : {}) });
        const result = await handlers.action(input, "local-cli");
        return reply(result, `Recorded ${command}: receipt ${result.receipt.id}; notice ${result.receipt.delivery.state}${result.receipt.delivery.error ? ` — ${result.receipt.delivery.error}` : ""}. ${result.task ? `Work lane ${result.task.state}.` : "Card removed; immutable receipt retained."}`);
      }
      const current = store.getTask(id);
      const expectedRevision = flag("revision") === null ? current.revision : Number(flag("revision"));
      if (command === "show") return reply(current, [formatTask(current), current.brief ? `Brief: ${current.brief}` : "", current.note ? `Note: ${current.note}` : "", ...(current.call ? [`${current.call.kind}: ${current.call.ask}`, ...current.call.options.map((option) => `${current.call?.recommendedId === option.id ? "*" : " "} ${option.id}: ${option.label}${option.detail ? ` — ${option.detail}` : ""}`), `Source: ${current.call.source ? `${current.call.source.threadId}/${current.call.source.rowId}` : `unavailable (${current.call.provenance})`}`, `Answer: ${current.call.answerLabel ?? current.call.status}`] : []), `Previous calls: ${current.history.length}`, ...(current.pendingCall ? [`Pending publication generation ${current.pendingCall.generation}: ${current.pendingCall.state} ${current.pendingCall.error ?? ""}`] : [])].filter(Boolean).join("\n"));
      if (command === "ask") {
        const ask = flag("question");
        if (!ask) throw new Error("--question is required");
        const options = (flags.get("option") ?? []).map((value, index) => {
          const separator = value.indexOf(" :: ");
          return { id: `o${index + 1}`, label: (separator < 0 ? value : value.slice(0, separator)).trim(), detail: separator < 0 ? null : value.slice(separator + 4).trim() || null };
        });
        const recommend = flag("recommend")?.trim() ?? "";
        const index = Number.parseInt(recommend, 10);
        const recommendedId = Number.isInteger(index) && index >= 1 && index <= options.length ? options[index - 1]!.id : options.find((option) => option.label.toLowerCase() === recommend.toLowerCase())?.id ?? null;
        const kind = flag("kind") ?? "DECIDE";
        const payload = callPayloadSchema.parse({ kind, ask, recommendation: flag("recommendation"), options, recommendedId, context: flag("context") ?? flag("note"), evidence: [], approvalScope: kind === "APPROVE" ? { action: flag("scope-action"), target: flag("scope-target"), constraints: flag("scope-constraints"), ...(flag("expires-at") ? { expiresAt: Number(flag("expires-at")) } : {}) } : null });
        const task = await handlers.ask(id, expectedRevision, payload, flag("thread") ?? undefined);
        return reply(task, `Captain's Call opened: ${formatTask(task)}; source unavailable (local CLI)`);
      }
      let patch: TaskPatch;
      switch (command) {
        case "start": patch = { state: "underway", threadId: flag("thread") ?? current.threadId, note: flag("note") ?? current.note }; break;
        case "note": { const note = flag("text") ?? rest.join(" ").trim(); if (!note) throw new Error("--text is required"); patch = { note }; break; }
        case "merge": patch = { state: "merge", prUrl: flag("pr") ?? current.prUrl }; break;
        case "land": patch = { state: "landed", landedAt: new Date().toISOString() }; break;
        case "fail": patch = { state: "failed", note: flag("reason") ?? current.note }; break;
        case "move": { const state = workStateSchema.parse(rest[0]); patch = { state, landedAt: state === "landed" ? current.landedAt ?? new Date().toISOString() : current.landedAt }; break; }
        case "remove": store.removeTask(id, expectedRevision); handlers.changed(); return reply({ removed: true, id }, `Removed ${id}`);
        default: throw new Error(usage);
      }
      const task = store.updateTask(id, patch, expectedRevision); handlers.changed(); return reply(task, formatTask(task));
    } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
  } });
}
