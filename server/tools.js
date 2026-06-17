// Real, executable tools for the agent runtime. Each tool runs server-side,
// scoped to the calling user, and returns a string "observation".
//
// ctx = { uid, keys, model, runSkill(name, input) }
import * as db from './db.js';

function clip(s, n = 4000) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s; }

export const TOOLS = {
  'memory.write': {
    description: 'Save a note to memory so any model can use it later.',
    args: '{ "text": "the note", "scope": "shared" | "<modelId>" (optional, default shared) }',
    needsApproval: true,
    run: async (ctx, a) => {
      const e = await db.addMemory(ctx.uid, { scope: a.scope || 'shared', author: 'agent', text: a.text });
      return `Saved memory note ${e.id} in scope "${e.scope}".`;
    },
  },
  'memory.search': {
    description: 'Search saved memory notes for a query string.',
    args: '{ "query": "text to find" }',
    run: async (ctx, a) => {
      const all = await db.listMemory(ctx.uid);
      const q = String(a.query || '').toLowerCase();
      const hits = all.filter((m) => m.text.toLowerCase().includes(q)).slice(0, 10);
      if (!hits.length) return 'No matching memory notes.';
      return hits.map((m) => `- (${m.scope}) ${m.text}`).join('\n');
    },
  },
  'files.list': {
    description: 'List files in a scope.',
    args: '{ "scope": "combined" | "<modelId>" (optional, default combined) }',
    run: async (ctx, a) => {
      const files = await db.listFiles(ctx.uid, a.scope || 'combined');
      if (!files.length) return 'No files in this scope.';
      return files.map((f) => `- ${f.path}${f.storage_path ? ' [uploaded]' : ''}`).join('\n');
    },
  },
  'files.read': {
    description: 'Read the text content of a file by its path.',
    args: '{ "path": "notes/idea.md", "scope": "combined" | "<modelId>" (optional) }',
    run: async (ctx, a) => {
      const files = await db.listFiles(ctx.uid, a.scope || undefined);
      const f = files.find((x) => x.path === a.path);
      if (!f) return `No file found at path "${a.path}".`;
      if (f.storage_path && !f.content) return `"${a.path}" is an uploaded binary file; text content is not available.`;
      return clip(f.content);
    },
  },
  'files.write': {
    description: 'Create or overwrite a text file at a path.',
    args: '{ "path": "notes/out.md", "content": "...", "scope": "combined" | "<modelId>" (optional) }',
    needsApproval: true,
    run: async (ctx, a) => {
      const scope = a.scope || 'combined';
      const existing = (await db.listFiles(ctx.uid, scope)).find((x) => x.path === a.path);
      const f = await db.upsertFile(ctx.uid, existing
        ? { id: existing.id, path: a.path, content: a.content ?? '' }
        : { scope, path: a.path, content: a.content ?? '' });
      return `${existing ? 'Updated' : 'Created'} "${f.path}" in scope "${scope}".`;
    },
  },
  'web.fetch': {
    description: 'Fetch a public web page and return its readable text.',
    args: '{ "url": "https://example.com" }',
    needsApproval: true,
    run: async (ctx, a) => {
      const url = String(a.url || '');
      if (!/^https?:\/\//i.test(url)) return 'Error: url must start with http:// or https://';
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'OrbitalAgent/1.0' } });
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return clip(text, 6000);
      } catch (e) { return `Error fetching: ${e.name === 'AbortError' ? 'timed out' : e.message}`; }
      finally { clearTimeout(t); }
    },
  },
  'skill.run': {
    description: 'Run one of your saved skills by name on some input.',
    args: '{ "name": "summarize", "input": "text to run the skill on" }',
    run: async (ctx, a) => {
      if (!ctx.runSkill) return 'Error: skills unavailable.';
      return clip(await ctx.runSkill(a.name, a.input || ''), 6000);
    },
  },
  'ask_model': {
    description: 'Ask another AI model one question and get its answer.',
    args: '{ "model": "model name", "input": "your question" }',
    run: async (ctx, a) => {
      if (!ctx.askModel) return 'Error: model delegation unavailable.';
      return clip(await ctx.askModel(a.model, a.input ?? a.prompt ?? ''), 6000);
    },
  },
  'ask_agent': {
    description: 'Delegate a task to another agent and get its result.',
    args: '{ "agent": "agent name", "input": "the task" }',
    run: async (ctx, a) => {
      if (!ctx.askAgent) return 'Error: agent delegation unavailable.';
      return clip(await ctx.askAgent(a.agent, a.input ?? a.task ?? ''), 6000);
    },
  },
};

export const BUILTIN_TOOL_NAMES = Object.keys(TOOLS);

// Tools that change state or reach the network — gated behind user approval.
export const APPROVAL_TOOLS = Object.keys(TOOLS).filter((n) => TOOLS[n].needsApproval);
export const toolNeedsApproval = (name) => !!TOOLS[name]?.needsApproval;

// Build the catalog text injected into the agent's system prompt.
export function toolCatalog(enabledNames, skills = []) {
  const names = enabledNames?.length ? enabledNames.filter((n) => TOOLS[n]) : BUILTIN_TOOL_NAMES;
  const lines = names.map((n) => `- ${n} — ${TOOLS[n].description} args: ${TOOLS[n].args}`);
  if (skills.length) {
    lines.push(`- skill.run — run a saved skill. args: { "name": "...", "input": "..." }. Available skills: ${skills.map((s) => `${s.name} (${s.description})`).join('; ')}`);
  }
  return lines.join('\n');
}

export async function executeTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return `Error: unknown tool "${name}".`;
  try { return await tool.run(ctx, args || {}); }
  catch (e) { return `Error running ${name}: ${e.message || e}`; }
}
