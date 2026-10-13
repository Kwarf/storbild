// The container health check (ADR 0024): the viewer app answers /time.
export {};

const port = process.env.STORBILD_VIEWER_PORT || "3000";
try {
  const res = await fetch(`http://127.0.0.1:${port}/time`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
