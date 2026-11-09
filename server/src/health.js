// GET /api/health, contract demo-health/1 (demo-shelf docs/health-contract.md). Public, GET only, no extra fields.
// The state comes from the doctor checks, refreshed in the background every 60 s; a request never runs them.
import { allPassed, runChecks as defaultChecks } from './doctor.js';
import { DEMO } from './spec.js';

export function createHealth({ runChecks = defaultChecks, now = () => new Date(), intervalMs = 60_000, ctx } = {}) {
  let last = { state: 'unknown', at: null };
  async function refresh() {
    try { last = { state: allPassed(await runChecks(ctx)) ? 'ready' : 'broken', at: now().toISOString() }; }
    catch { last = { state: 'unknown', at: now().toISOString() }; }
  }
  const ready = refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref();
  return {
    ready, refresh, stop: () => clearInterval(timer),
    body: () => ({ schema: 'demo-health/1', at: last.at || now().toISOString(), state: last.state, runtime: 'offline', demo: DEMO }),
  };
}
