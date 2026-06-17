// Data access layer. Every function is scoped to a user_id. Uses the Supabase
// admin client (service role) and filters by user_id for isolation.
import { admin, BUCKET } from './supabase.js';
import { encrypt, decrypt } from './util.js';

const PROVIDERS = ['openrouter', 'openai', 'claude', 'gemini', 'glm', 'kimi'];

const must = () => {
  if (!admin) throw new Error('Supabase is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.');
};
const rows = (r) => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};

// ---------- MODELS -------------------------------------------------------
export async function listModels(uid) {
  must();
  return rows(await admin.from('models').select('*').eq('user_id', uid).order('created_at'));
}
export async function getModel(uid, id) {
  must();
  return rows(await admin.from('models').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}
export async function upsertModel(uid, body) {
  must();
  const settings = { temperature: 0.7, maxTokens: 1024, systemPrompt: '', useSharedMemory: true, ...(body.settings || {}) };
  if (body.id) {
    const patch = { label: body.label, provider: body.provider, model: body.model, settings };
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    return rows(await admin.from('models').update(patch).eq('user_id', uid).eq('id', body.id).select().single());
  }
  return rows(await admin.from('models').insert({
    user_id: uid, label: body.label || 'New model', provider: body.provider || 'openrouter',
    model: body.model || '', enabled: body.enabled ?? true, settings,
  }).select().single());
}
export async function deleteModel(uid, id) {
  must();
  rows(await admin.from('models').delete().eq('user_id', uid).eq('id', id));
}

// ---------- AGENTS -------------------------------------------------------
export async function listAgents(uid) {
  must();
  return rows(await admin.from('agents').select('*').eq('user_id', uid).order('created_at'));
}
export async function getAgent(uid, id) {
  must();
  return rows(await admin.from('agents').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}
export async function upsertAgent(uid, body) {
  must();
  if (body.id) {
    return rows(await admin.from('agents').update({
      name: body.name, kind: body.kind, model_id: body.modelId || body.model_id,
      instructions: body.instructions, tools: body.tools || [],
    }).eq('user_id', uid).eq('id', body.id).select().single());
  }
  return rows(await admin.from('agents').insert({
    user_id: uid, name: body.name || 'New agent', kind: body.kind || 'hermes',
    model_id: body.modelId || null, instructions: body.instructions || '', tools: body.tools || [],
  }).select().single());
}
export async function deleteAgent(uid, id) {
  must();
  rows(await admin.from('agents').delete().eq('user_id', uid).eq('id', id));
}

// ---------- MEMORY -------------------------------------------------------
export async function listMemory(uid, scope) {
  must();
  let q = admin.from('memory').select('*').eq('user_id', uid).order('created_at');
  if (scope) q = q.eq('scope', scope);
  return rows(await q);
}
export async function addMemory(uid, { scope = 'shared', author = 'user', text, tags = [] }) {
  must();
  if (!text || !text.trim()) throw new Error('memory text required');
  return rows(await admin.from('memory').insert({ user_id: uid, scope, author, text: text.trim(), tags }).select().single());
}
export async function deleteMemory(uid, id) {
  must();
  rows(await admin.from('memory').delete().eq('user_id', uid).eq('id', id));
}
// Build the memory block injected into a model's system prompt.
export async function memoryContextFor(uid, model) {
  const useShared = model?.settings?.useSharedMemory !== false;
  const all = await listMemory(uid);
  const entries = all.filter((m) => (useShared && m.scope === 'shared') || m.scope === model?.id);
  if (!entries.length) return '';
  const lines = entries.slice(-40).map(
    (m) => `- (${m.scope === 'shared' ? 'shared' : 'private'}, by ${m.author}) ${m.text}`
  );
  return `Known facts and notes from the team memory:\n${lines.join('\n')}`;
}

// ---------- FILES --------------------------------------------------------
export async function listFiles(uid, scope) {
  must();
  let q = admin.from('files').select('*').eq('user_id', uid).order('updated_at', { ascending: false });
  if (scope) q = q.eq('scope', scope);
  return rows(await q);
}
export async function getFile(uid, id) {
  must();
  return rows(await admin.from('files').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}
export async function upsertFile(uid, body) {
  must();
  if (body.id) {
    return rows(await admin.from('files').update({
      path: body.path, content: body.content ?? '', updated_at: new Date().toISOString(),
    }).eq('user_id', uid).eq('id', body.id).select().single());
  }
  if (!body.path) throw new Error('path required');
  return rows(await admin.from('files').insert({
    user_id: uid, scope: body.scope || 'combined', path: body.path, content: body.content || '',
    storage_path: body.storage_path || null, size_bytes: body.size_bytes || null,
  }).select().single());
}
export async function deleteFile(uid, id) {
  must();
  const f = await getFile(uid, id);
  if (f?.storage_path) await admin.storage.from(BUCKET).remove([f.storage_path]);
  rows(await admin.from('files').delete().eq('user_id', uid).eq('id', id));
}
export async function fileTree(uid) {
  const all = await listFiles(uid);
  const scopes = {};
  for (const f of all) {
    (scopes[f.scope] ||= []).push({ id: f.id, path: f.path, updatedAt: f.updated_at, storage: !!f.storage_path });
  }
  return scopes;
}

// ---------- STORAGE ------------------------------------------------------
export async function uploadFile(uid, { scope = 'combined', filename, base64, contentType }) {
  must();
  if (!filename || !base64) throw new Error('filename and base64 required');
  const buffer = Buffer.from(base64, 'base64');
  const storagePath = `${uid}/${Date.now()}_${filename.replace(/[^\w.\-]/g, '_')}`;
  const up = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: contentType || 'application/octet-stream', upsert: false,
  });
  if (up.error) throw new Error(up.error.message);
  return upsertFile(uid, {
    scope, path: filename, content: '', storage_path: storagePath, size_bytes: buffer.length,
  });
}
export async function signedUrl(uid, id) {
  must();
  const f = await getFile(uid, id);
  if (!f?.storage_path) throw new Error('file has no stored object');
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(f.storage_path, 60 * 10);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

// ---------- HARNESSES ----------------------------------------------------
export async function listHarnesses(uid) {
  must();
  return rows(await admin.from('harnesses').select('*').eq('user_id', uid).order('name'));
}
export async function toggleHarness(uid, id) {
  must();
  const h = rows(await admin.from('harnesses').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
  if (!h) throw new Error('not found');
  const status = h.status === 'installed' ? 'available' : 'installed';
  return rows(await admin.from('harnesses').update({ status, updated_at: new Date().toISOString() })
    .eq('user_id', uid).eq('id', id).select().single());
}

// ---------- SKILLS -------------------------------------------------------
export async function listSkills(uid) {
  must();
  return rows(await admin.from('skills').select('*').eq('user_id', uid).order('name'));
}
export async function getSkill(uid, id) {
  must();
  return rows(await admin.from('skills').select('*').eq('user_id', uid).eq('id', id).maybeSingle());
}
export async function getSkillByName(uid, name) {
  must();
  return rows(await admin.from('skills').select('*').eq('user_id', uid).ilike('name', name).maybeSingle());
}
export async function upsertSkill(uid, body) {
  must();
  if (body.id) {
    return rows(await admin.from('skills').update({
      name: body.name, description: body.description || '', instructions: body.instructions || '',
    }).eq('user_id', uid).eq('id', body.id).select().single());
  }
  if (!body.name) throw new Error('skill name required');
  return rows(await admin.from('skills').insert({
    user_id: uid, name: body.name, description: body.description || '', instructions: body.instructions || '',
  }).select().single());
}
export async function deleteSkill(uid, id) {
  must();
  rows(await admin.from('skills').delete().eq('user_id', uid).eq('id', id));
}

// ---------- AUTO-APPROVALS (per user) -----------------------------------
export async function listAutoApprovals(uid) {
  must();
  return rows(await admin.from('auto_approvals').select('tool').eq('user_id', uid)).map((r) => r.tool);
}
export async function addAutoApproval(uid, tool) {
  must();
  rows(await admin.from('auto_approvals').upsert({ user_id: uid, tool }, { onConflict: 'user_id,tool' }));
  return { tool, auto: true };
}
export async function removeAutoApproval(uid, tool) {
  must();
  rows(await admin.from('auto_approvals').delete().eq('user_id', uid).eq('tool', tool));
  return { tool, auto: false };
}

// ---------- PROVIDER KEYS (per user, encrypted) -------------------------
export const PROVIDER_LIST = PROVIDERS;

// Decrypted map { provider: key } — SERVER ONLY, never sent to the browser.
export async function getUserKeys(uid) {
  must();
  const data = rows(await admin.from('provider_keys').select('provider, enc_key').eq('user_id', uid));
  const out = {};
  for (const r of data) { const k = decrypt(r.enc_key); if (k) out[r.provider] = k; }
  return out;
}

// Booleans only — safe to send to the browser.
export async function keyStatus(uid) {
  must();
  const data = rows(await admin.from('provider_keys').select('provider').eq('user_id', uid));
  const set = new Set(data.map((r) => r.provider));
  return Object.fromEntries(PROVIDERS.map((p) => [p, set.has(p)]));
}

export async function setUserKey(uid, provider, key) {
  must();
  if (!PROVIDERS.includes(provider)) throw new Error('unknown provider');
  if (!key || !key.trim()) throw new Error('key required');
  rows(await admin.from('provider_keys').upsert({
    user_id: uid, provider, enc_key: encrypt(key.trim()), updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' }));
  return { provider, set: true };
}

export async function deleteUserKey(uid, provider) {
  must();
  rows(await admin.from('provider_keys').delete().eq('user_id', uid).eq('provider', provider));
  return { provider, set: false };
}

// ---------- SEED defaults for a new user --------------------------------
const DEFAULT_MODELS = [
  { label: 'Claude', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', settings: { systemPrompt: 'You are Claude, thoughtful and precise.' } },
  { label: 'ChatGPT', provider: 'openrouter', model: 'openai/gpt-4o' },
  { label: 'Gemini', provider: 'openrouter', model: 'google/gemini-2.0-flash-001' },
  { label: 'GLM 5.2', provider: 'openrouter', model: 'z-ai/glm-4.6' },
  { label: 'Kimi', provider: 'openrouter', model: 'moonshotai/kimi-k2' },
  { label: 'Llama (local)', provider: 'ollama', model: 'llama3.1', settings: { temperature: 0.8 } },
];
const DEFAULT_AGENTS = [
  { name: 'Hermes', kind: 'hermes', modelLabel: 'Claude', instructions: 'You are a fast research-and-summarize agent. Gather, condense, and report clearly.', tools: ['web.search', 'memory.write', 'files.read'] },
  { name: 'OpenClaw', kind: 'openclaw', modelLabel: 'ChatGPT', instructions: 'You are a tool-using automation agent. Break tasks into steps and execute them.', tools: ['files.read', 'files.write', 'shell.run'] },
  { name: 'OpenCode', kind: 'opencode', modelLabel: 'GLM 5.2', instructions: 'You are a coding agent. Read the repo, plan a change, and write clean code.', tools: ['files.read', 'files.write', 'code.run'] },
];
const DEFAULT_HARNESSES = [
  { key: 'openrouter', name: 'OpenRouter', category: 'gateway', description: 'One API key for Claude, GPT, Gemini, GLM, Kimi and hundreds more.', docs_url: 'https://openrouter.ai/docs', status: 'installed' },
  { key: 'ollama', name: 'Ollama', category: 'local', description: 'Run open models locally with no API key.', docs_url: 'https://ollama.com', status: 'installed' },
  { key: 'notebooklm', name: 'NotebookLM', category: 'research', description: 'Source-grounded notebook for documents.', docs_url: 'https://notebooklm.google.com', status: 'available' },
  { key: 'hermes', name: 'Hermes', category: 'agent', description: 'Fast research + summarize agent harness.', docs_url: 'https://nousresearch.com', status: 'available' },
  { key: 'openclaw', name: 'OpenClaw', category: 'agent', description: 'Tool-using automation agent harness.', docs_url: 'https://github.com', status: 'available' },
  { key: 'opencode', name: 'OpenCode', category: 'agent', description: 'Open-source terminal coding agent harness.', docs_url: 'https://opencode.ai', status: 'available' },
  { key: 'langchain', name: 'LangChain', category: 'framework', description: 'Chains, tools and retrieval for agent workflows.', docs_url: 'https://www.langchain.com', status: 'available' },
];

// Insert defaults once, the first time a user signs in.
export async function ensureSeed(uid) {
  must();
  const existing = rows(await admin.from('models').select('id').eq('user_id', uid).limit(1));
  if (existing.length) return false;

  const insertedModels = rows(await admin.from('models').insert(
    DEFAULT_MODELS.map((m) => ({
      user_id: uid, label: m.label, provider: m.provider, model: m.model,
      settings: { temperature: 0.7, maxTokens: 1024, systemPrompt: '', useSharedMemory: true, ...(m.settings || {}) },
    }))
  ).select());
  const byLabel = Object.fromEntries(insertedModels.map((m) => [m.label, m.id]));

  await admin.from('agents').insert(DEFAULT_AGENTS.map((a) => ({
    user_id: uid, name: a.name, kind: a.kind, model_id: byLabel[a.modelLabel] || null,
    instructions: a.instructions, tools: a.tools,
  })));
  await admin.from('harnesses').insert(DEFAULT_HARNESSES.map((h) => ({ user_id: uid, ...h })));
  await admin.from('memory').insert({
    user_id: uid, scope: 'shared', author: 'user',
    text: 'Project name is Orbital. Keep replies concise and friendly.', tags: ['preferences'],
  });
  await admin.from('files').insert({
    user_id: uid, scope: 'combined', path: 'notes/welcome.md',
    content: '# Shared workspace\n\nEvery model can read and write files here. Private per-model files live in their own tree.',
  });
  await admin.from('skills').insert([
    { user_id: uid, name: 'summarize', description: 'Condense text into a tight summary.', instructions: 'Summarize the input into 3-5 concise bullet points. Keep only what matters.' },
    { user_id: uid, name: 'outline', description: 'Turn an idea into a structured outline.', instructions: 'Produce a clear hierarchical outline (headings + sub-points) for the given topic.' },
    { user_id: uid, name: 'extract-actions', description: 'Pull action items out of notes.', instructions: 'Read the input and list every action item as "- [ ] owner: task". If no owner is stated, use "?".' },
  ]);
  return true;
}
