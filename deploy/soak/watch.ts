// Watches a Storbild screen URL during the soak test (docs/soak-test.md) and logs one JSON line
// per observation, so the run leaves evidence. Run it from a machine other than the server:
//
//   bun deploy/soak/watch.ts https://screen:password@screen.party.example.org/ > soak.jsonl
//
// It follows /events like a screen does, resuming with Last-Event-ID, and logs:
//   - `stream`: connects, disconnects and what each connect started with
//   - `gap`: a revision skipped within a stream, which should never happen
//   - `silent`: no event or heartbeat for longer than 35 s
//   - `time`: /time every minute, with the round trip and the offset from this machine's clock
// Ctrl-C prints a summary.

const HEARTBEAT_LIMIT_MS = 35_000;
const TIME_EVERY_MS = 60_000;
const RETRY_MS = 2_000;

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun deploy/soak/watch.ts <screen URL, with user:password@ if needed>");
  process.exit(1);
}
const base = new URL(arg);
const headers: Record<string, string> = {};
if (base.username || base.password) {
  const user = decodeURIComponent(base.username);
  const password = decodeURIComponent(base.password);
  headers.Authorization = `Basic ${btoa(`${user}:${password}`)}`;
  base.username = "";
  base.password = "";
}

const startedAt = Date.now();
const summary = {
  connects: 0,
  disconnects: 0,
  snapshots: 0,
  patches: 0,
  gaps: 0,
  silences: 0,
  timeFailures: 0,
  longestDownMs: 0,
  maxRoundTripMs: 0,
  offsetsMs: [] as number[],
};

function log(kind: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...fields }));
}

let revision: number | undefined;
let lastEventAt = Date.now();
let downSince: number | undefined;

/** Reads one SSE stream until it ends; returns normally or throws on a failed connect. */
async function follow() {
  const res = await fetch(new URL("/events", base), {
    headers: {
      ...headers,
      Accept: "text/event-stream",
      ...(revision !== undefined && { "Last-Event-ID": String(revision) }),
    },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  summary.connects++;
  if (downSince !== undefined) {
    const downMs = Date.now() - downSince;
    summary.longestDownMs = Math.max(summary.longestDownMs, downMs);
    log("stream", { event: "connected", afterMs: downMs, resumeFrom: revision });
    downSince = undefined;
  } else {
    log("stream", { event: "connected", resumeFrom: revision });
  }
  lastEventAt = Date.now();
  const decoder = new TextDecoder();
  let buffer = "";
  let first = true;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(
        block
          .split("\n")
          .filter((line) => line && !line.startsWith(":"))
          .map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon), line.slice(colon + 1).replace(/^ /, "")];
          }),
      );
      if (!fields.event) continue;
      lastEventAt = Date.now();
      if (fields.event === "ping") continue;
      const id = Number(fields.id);
      if (fields.event === "snapshot") {
        summary.snapshots++;
        if (first) log("stream", { event: "snapshot", revision: id, previous: revision });
      } else if (fields.event === "patch") {
        summary.patches++;
        if (first && revision !== undefined) log("stream", { event: "resumed", revision: id });
        if (revision !== undefined && id !== revision + 1) {
          summary.gaps++;
          log("gap", { expected: revision + 1, got: id });
        }
      }
      first = false;
      if (Number.isFinite(id)) revision = id;
    }
  }
}

async function streamLoop() {
  for (;;) {
    try {
      await follow();
      log("stream", { event: "ended" });
    } catch (error) {
      log("stream", {
        event: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    summary.disconnects++;
    downSince ??= Date.now();
    await Bun.sleep(RETRY_MS);
  }
}

setInterval(() => {
  const silentMs = Date.now() - lastEventAt;
  if (downSince === undefined && silentMs > HEARTBEAT_LIMIT_MS) {
    summary.silences++;
    log("silent", { forMs: silentMs });
    lastEventAt = Date.now();
  }
}, 5_000);

setInterval(async () => {
  const sent = Date.now();
  try {
    const res = await fetch(new URL("/time", base), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const { now } = (await res.json()) as { now: number };
    const received = Date.now();
    const roundTripMs = received - sent;
    const offsetMs = Math.round(now - (sent + received) / 2);
    summary.maxRoundTripMs = Math.max(summary.maxRoundTripMs, roundTripMs);
    summary.offsetsMs.push(offsetMs);
    log("time", { roundTripMs, offsetMs });
  } catch (error) {
    summary.timeFailures++;
    log("time", { error: error instanceof Error ? error.message : String(error) });
  }
}, TIME_EVERY_MS);

process.on("SIGINT", () => {
  const { offsetsMs, ...counts } = summary;
  const hours = ((Date.now() - startedAt) / 3_600_000).toFixed(2);
  console.error(
    JSON.stringify(
      {
        hours,
        ...counts,
        offsetMs: offsetsMs.length
          ? { min: Math.min(...offsetsMs), max: Math.max(...offsetsMs) }
          : undefined,
        lastRevision: revision,
      },
      null,
      2,
    ),
  );
  process.exit(0);
});

log("start", { url: base.href });
void streamLoop();
