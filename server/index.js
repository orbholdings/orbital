import express from 'express';
import path from 'node:path';
import { loadEnv, ROOT, uid } from './util.js';
import { chat, chatStream, providerStatus } from './providers.js';
import { isConfigured, publicConfig, getUserFromToken } from './supabase.js';
import { runAgent, runSkill } from './runtime.js';
import { BUILTIN_TOOL_NAMES, APPROVAL_TOOLS } from './tools.js';
import { waitForApproval, resolveApproval } from './approvals.js';
import * as db from './db.js';

loadEnv();

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const PORT = process.env.PORT || 4173;
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: String(e.message || e) }));

app.get('/api/health', (req, res) => res.json({ ok: true, supabase: isConfigured() }));
app.get('/api/config', (req, res) => res.json(publicConfig()));

app.use('/api', async (req, res, next) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Supabase not configured on the server.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.uid = user.id;
  req.userEmail = user.email;
  next();
});

async function buildMessages(uid, model, userMessages) {
  const parts = [];
  if (model.settings?.systemPrompt) parts.push(model.settings.systemPrompt);
  const mem = await db.memoryContextFor(uid, model);
  if (mem) parts.push(mem);
  const system = parts.join('\n\n');
  return system ? [{ role: 'system', content: system }, ...userMessages] : userMessages;
}

app.get('/api/status', wrap(async (req, res) => {
  await db.ensureSeed(req.uid);
  const [models, agents, harnesses, memory, ks] = await Promise.all([
    db.listModels(req.uid), db.listAgents(req.uid), db.listHarnesses(req.uid), db.listMemory(req.uid), db.keyStatus(req.uid),
  ]);
  // A provider is "ready" if the server has an env key OR the user set their own.
  const env = providerStatus();
  const providers = Object.fromEntries(Object.keys(env).map((p) => [p, env[p] || !!ks[p]]));
  res.json({
    ok: true, email: req.userEmail, providers,
    counts: { models: models.length, agents: agents.length, harnesses: harnesses.filter((h) => h.status === 'installed').length, memory: memory.length },
  });
}));

// ---------- provider keys (per user) -------------------------------------
app.get('/api/keys', wrap(async (req, res) => res.json(await db.keyStatus(req.uid))));
app.get('/api/keys/custom', wrap(async (req, res) => res.json(await db.listCustomKeys(req.uid))));
app.post('/api/keys', wrap(async (req, res) => res.json(await db.setUserKey(req.uid, req.body?.provider, req.body?.key))));
app.delete('/api/keys/:provider', wrap(async (req, res) => res.json(await db.deleteUserKey(req.uid, req.params.provider))));

app.get('/api/models', wrap(async (req, res) => res.json(await db.listModels(req.uid))));
app.post('/api/models', wrap(async (req, res) => res.json(await db.upsertModel(req.uid, req.body || {}))));
app.delete('/api/models/:id', wrap(async (req, res) => { await db.deleteModel(req.uid, req.params.id); res.json({ ok: true }); }));

app.post('/api/chat', wrap(async (req, res) => {
  const { modelId, messages } = req.body || {};
  const model = await db.getModel(req.uid, modelId);
  if (!model) return res.status(404).json({ error: 'model not found' });
  const keys = await db.getUserKeys(req.uid);
  const out = await chat({ provider: model.provider, model: model.model, messages: await buildMessages(req.uid, model, messages || []), settings: model.settings, keys });
  res.json(out);
}));

// Streaming chat over SSE, persisted to a conversation. Body: { conversationId,
// text, modelId? }. Saves the user message, streams the reply, saves the reply.
app.post('/api/chat/stream', async (req, res) => {
  try {
    const { conversationId, text, modelId } = req.body || {};
    if (!conversationId || !text) return res.status(400).json({ error: 'conversationId and text required' });
    const conv = await db.getConversation(req.uid, conversationId);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    const model = await db.getModel(req.uid, modelId || conv.model_id);
    if (!model) return res.status(400).json({ error: 'this chat has no valid model' });
    const keys = await db.getUserKeys(req.uid);

    // Build provider messages from saved history + the new turn.
    const prior = await db.getMessages(req.uid, conversationId);
    const convo = prior.map((m) => ({ role: m.role, content: m.content }));
    convo.push({ role: 'user', content: text });
    const built = await buildMessages(req.uid, model, convo);

    // Persist the user message; set title from first message + remember model.
    await db.addMessage(req.uid, conversationId, 'user', text);
    const patch = {};
    if (modelId && modelId !== conv.model_id) patch.model_id = modelId;
    if (!conv.title || conv.title === 'New chat') patch.title = text.slice(0, 60);
    if (Object.keys(patch).length) await db.touchConversation(req.uid, conversationId, patch);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let full = '';
    try {
      const out = await chatStream(
        { provider: model.provider, model: model.model, messages: built, settings: model.settings, keys },
        (token) => { full += token; send({ token }); }
      );
      full = out.text || full;
      await db.addMessage(req.uid, conversationId, 'assistant', full);
      send({ done: true, demo: !!out.demo });
    } catch (e) { send({ error: String(e.message || e) }); }
    res.end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- conversations (chat history) --------------------------------
app.get('/api/conversations', wrap(async (req, res) => res.json(await db.listConversations(req.uid))));
app.post('/api/conversations', wrap(async (req, res) => res.json(await db.createConversation(req.uid, req.body || {}))));
app.get('/api/conversations/search', wrap(async (req, res) => res.json(await db.searchMessages(req.uid, req.query.q || ''))));
app.get('/api/conversations/:id/messages', wrap(async (req, res) => res.json(await db.getMessages(req.uid, req.params.id))));
app.post('/api/conversations/:id/rename', wrap(async (req, res) => res.json(await db.renameConversation(req.uid, req.params.id, req.body?.title || 'Chat'))));
app.delete('/api/conversations/:id', wrap(async (req, res) => { await db.deleteConversation(req.uid, req.params.id); res.json({ ok: true }); }));

app.post('/api/chat/broadcast', wrap(async (req, res) => {
  const { modelIds = [], message } = req.body || {};
  const keys = await db.getUserKeys(req.uid);
  const results = await Promise.all(modelIds.map(async (id) => {
    const model = await db.getModel(req.uid, id);
    if (!model) return { modelId: id, error: 'not found' };
    try {
      const out = await chat({ provider: model.provider, model: model.model, messages: await buildMessages(req.uid, model, [{ role: 'user', content: message }]), settings: model.settings, keys });
      return { modelId: id, label: model.label, ...out };
    } catch (e) { return { modelId: id, label: model.label, error: String(e.message || e) }; }
  }));
  res.json(results);
}));

app.get('/api/memory', wrap(async (req, res) => res.json(await db.listMemory(req.uid, req.query.scope))));
app.post('/api/memory', wrap(async (req, res) => res.json(await db.addMemory(req.uid, req.body || {}))));
app.delete('/api/memory/:id', wrap(async (req, res) => { await db.deleteMemory(req.uid, req.params.id); res.json({ ok: true }); }));

app.get('/api/files', wrap(async (req, res) => res.json(await db.fileTree(req.uid))));
app.get('/api/files/all', wrap(async (req, res) => res.json(await db.listFiles(req.uid, req.query.scope))));
app.post('/api/files', wrap(async (req, res) => res.json(await db.upsertFile(req.uid, req.body || {}))));
app.post('/api/files/upload', wrap(async (req, res) => res.json(await db.uploadFile(req.uid, req.body || {}))));
app.get('/api/files/:id/url', wrap(async (req, res) => res.json({ url: await db.signedUrl(req.uid, req.params.id) })));
app.delete('/api/files/:id', wrap(async (req, res) => { await db.deleteFile(req.uid, req.params.id); res.json({ ok: true }); }));

app.get('/api/agents', wrap(async (req, res) => res.json(await db.listAgents(req.uid))));
app.post('/api/agents', wrap(async (req, res) => res.json(await db.upsertAgent(req.uid, req.body || {}))));
app.delete('/api/agents/:id', wrap(async (req, res) => { await db.deleteAgent(req.uid, req.params.id); res.json({ ok: true }); }));

// Run an agent with the real tool/skill loop, streaming each step over SSE.
app.post('/api/agents/:id/run', async (req, res) => {
  try {
    const agent = await db.getAgent(req.uid, req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });
    const model = agent.model_id ? await db.getModel(req.uid, agent.model_id) : null;
    if (!model) return res.status(400).json({ error: 'agent has no valid model' });
    const [keys, skills, autoList] = await Promise.all([
      db.getUserKeys(req.uid), db.listSkills(req.uid), db.listAutoApprovals(req.uid),
    ]);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const runId = uid('run');
    const autoApproved = new Set(autoList);
    send({ type: 'start', runId, agent: agent.name, model: model.label });

    let reqCounter = 0;
    const requestApproval = async (tool, input) => {
      if (autoApproved.has(tool)) return true;                 // "approve every time" already chosen
      const reqId = String(++reqCounter);
      send({ type: 'approval_request', reqId, tool, input });
      const decision = await waitForApproval(req.uid, runId, reqId);
      send({ type: 'approval_resolved', reqId, decision });
      if (decision === 'always') { autoApproved.add(tool); await db.addAutoApproval(req.uid, tool); }
      return decision === 'once' || decision === 'always';
    };

    try {
      await runAgent({ uid: req.uid, agent, model, keys, skills, task: req.body?.task, onEvent: send, requestApproval });
    } catch (e) { send({ type: 'error', text: String(e.message || e) }); }
    res.end();
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Resolve a pending approval request from a live agent run.
app.post('/api/agents/approve', wrap(async (req, res) => {
  const { runId, reqId, decision } = req.body || {};
  const ok = resolveApproval(req.uid, runId, reqId, decision);
  res.json({ ok });
}));

// Manage which tools are auto-approved ("approve every time").
app.get('/api/approvals', wrap(async (req, res) => res.json({ tools: await db.listAutoApprovals(req.uid), gated: APPROVAL_TOOLS })));
app.delete('/api/approvals/:tool', wrap(async (req, res) => res.json(await db.removeAutoApproval(req.uid, req.params.tool))));

// ---------- tools + skills ----------------------------------------------
app.get('/api/tools', wrap(async (req, res) => res.json(BUILTIN_TOOL_NAMES)));

app.get('/api/skills', wrap(async (req, res) => res.json(await db.listSkills(req.uid))));
app.post('/api/skills', wrap(async (req, res) => res.json(await db.upsertSkill(req.uid, req.body || {}))));
app.delete('/api/skills/:id', wrap(async (req, res) => { await db.deleteSkill(req.uid, req.params.id); res.json({ ok: true }); }));

// Test-run a skill directly against a chosen model.
app.post('/api/skills/:id/run', wrap(async (req, res) => {
  const skill = await db.getSkill(req.uid, req.params.id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  const modelId = req.body?.modelId;
  const model = modelId ? await db.getModel(req.uid, modelId) : (await db.listModels(req.uid))[0];
  if (!model) return res.status(400).json({ error: 'no model available' });
  const keys = await db.getUserKeys(req.uid);
  const text = await runSkill({ uid: req.uid, model, keys, skill, input: req.body?.input || '' });
  res.json({ skill: skill.name, model: model.label, text });
}));

app.get('/api/harnesses', wrap(async (req, res) => res.json(await db.listHarnesses(req.uid))));
app.post('/api/harnesses/:id/install', wrap(async (req, res) => res.json(await db.toggleHarness(req.uid, req.params.id))));

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('Orbital running at http://localhost:' + PORT);
  console.log('Supabase: ' + (isConfigured() ? 'configured' : 'NOT configured (set SUPABASE_* env vars)'));
});
// orbital v0.3 — tools, skills & agent runtime enabled
