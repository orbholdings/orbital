// In-memory registry of pending tool approvals. When an agent run hits a tool
// that needs approval, it parks a Promise here and emits an approval_request
// over SSE; a separate POST /api/agents/approve resolves it. Single-process
// (Coolify one instance) — state lives in memory and is fine to lose on restart.
const pending = new Map(); // key: `${uid}:${runId}:${reqId}` -> { resolve, timer }

const key = (uid, runId, reqId) => `${uid}:${runId}:${reqId}`;

// Park a decision; resolves to 'once' | 'always' | 'deny'. Times out as 'deny'.
export function waitForApproval(uid, runId, reqId, timeoutMs = 180000) {
  const k = key(uid, runId, reqId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(k); resolve('deny'); }, timeoutMs);
    pending.set(k, { resolve, timer });
  });
}

// Called by the approve route. Returns true if a pending request was resolved.
export function resolveApproval(uid, runId, reqId, decision) {
  const k = key(uid, runId, reqId);
  const p = pending.get(k);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(k);
  p.resolve(['once', 'always', 'deny'].includes(decision) ? decision : 'deny');
  return true;
}
