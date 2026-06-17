// Agent runtime: a provider-agnostic ReAct loop. The model is asked to reply
// with a single JSON action each turn; the server executes the tool and feeds
// back an observation, looping until the model returns a final answer.
//
// Works with any chat model (no native function-calling required), including
// Ollama. In demo mode (no API key) it returns the demo text as the answer.
import { chat } from './providers.js';
import { toolCatalog, executeTool, toolNeedsApproval } from './tools.js';
import * as db from './db.js';

const MAX_STEPS = 8;

// Pull the first usable JSON object out of a model response.
function extractAction(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  // also try the largest {...} span
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try { const o = JSON.parse(c.trim()); if (o && typeof o === 'object') return o; } catch {}
  }
  return null;
}

// Run a single skill as a focused LLM task.
export async function runSkill({ uid, model, keys, skill, input }) {
  const out = await chat({
    provider: model.provider, model: model.model, settings: model.settings, keys,
    messages: [
      { role: 'system', content: `You are running the skill "${skill.name}". ${skill.instructions}` },
      { role: 'user', content: String(input || '') },
    ],
  });
  return out.text;
}

function systemPrompt(agent, model, catalog, memory) {
  return [
    `You are "${agent.name}", a ${agent.kind} agent. ${agent.instructions}`,
    memory,
    `You can use tools. Available tools:\n${catalog}`,
    `On EACH turn reply with ONE JSON object and nothing else, in this exact shape:`,
    `{"thought":"brief reasoning","action":"<tool name>","action_input":{ ...args }}`,
    `When you are done, use the special action "final":`,
    `{"thought":"why you're done","action":"final","action_input":{"answer":"your full answer to the user"}}`,
    `Only call tools from the list. Keep thoughts short. Do not wrap the JSON in extra prose.`,
  ].filter(Boolean).join('\n\n');
}

// Run an agent on a task. onEvent({type,...}) streams the trace:
//   {type:'thought',text} {type:'action',tool,input} {type:'observation',text}
//   {type:'final',text} {type:'error',text}
// requestApproval(tool, input) -> resolves true (proceed) or false (denied).
// Defaults to auto-approve when not provided (e.g. internal/test callers).
export async function runAgent({ uid, agent, model, keys, task, skills = [], models = [], agents = [], depth = 0, onEvent = () => {}, requestApproval = async () => true }) {
  const otherModels = models.map((m) => m.label).join(', ');
  const otherAgents = agents.filter((a) => a.id !== agent.id).map((a) => a.name).join(', ');
  const catalog = toolCatalog(agent.tools, skills)
    + (models.length ? `\n- ask_model — ask another model one question. args: { "model": "name", "prompt": "..." }. Models: ${otherModels}` : '')
    + (otherAgents ? `\n- ask_agent — delegate a task to another agent. args: { "agent": "name", "task": "..." }. Agents: ${otherAgents}` : '');
  const memory = await db.memoryContextFor(uid, model);
  const messages = [
    { role: 'system', content: systemPrompt(agent, model, catalog, memory) },
    { role: 'user', content: String(task || 'Introduce yourself and your capabilities.') },
  ];
  const skillByName = (name) => skills.find((s) => s.name?.toLowerCase() === String(name).toLowerCase());
  const ctx = {
    uid, keys, model,
    runSkill: async (name, input) => {
      const s = skillByName(name);
      if (!s) return `Error: no skill named "${name}".`;
      return runSkill({ uid, model, keys, skill: s, input });
    },
    // Multi-AI: ask any other model one-shot.
    askModel: async (ref, prompt) => {
      const m = models.find((x) => x.id === ref || x.label?.toLowerCase() === String(ref).toLowerCase());
      if (!m) return `Error: no model named "${ref}".`;
      const out = await chat({ provider: m.provider, model: m.model, settings: m.settings, keys, messages: [{ role: 'user', content: String(prompt || '') }] });
      return out.text;
    },
    // Multi-AI: delegate to a sub-agent (depth-capped); its steps feed the trace.
    askAgent: async (ref, subTask) => {
      if (depth >= 2) return 'Error: max delegation depth reached.';
      const sub = agents.find((a) => a.name?.toLowerCase() === String(ref).toLowerCase());
      if (!sub) return `Error: no agent named "${ref}".`;
      const subModel = sub.model_id ? models.find((m) => m.id === sub.model_id) : model;
      if (!subModel) return `Error: agent "${ref}" has no model.`;
      const r = await runAgent({
        uid, agent: sub, model: subModel, keys, task: subTask, skills, models, agents, depth: depth + 1,
        requestApproval, onEvent: (ev) => onEvent({ ...ev, sub: sub.name }),
      });
      return r.text;
    },
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const out = await chat({ provider: model.provider, model: model.model, settings: model.settings, keys, messages });

    // Demo mode (or any provider with no key) can't reason in JSON — finish gracefully.
    if (out.demo) { onEvent({ type: 'final', text: out.text, demo: true }); return { text: out.text, demo: true, steps: step }; }

    const action = extractAction(out.text);
    if (!action || !action.action || action.action === 'final') {
      const answer = action?.action_input?.answer || action?.action_input || out.text;
      const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
      onEvent({ type: 'final', text });
      return { text, steps: step };
    }

    if (action.thought) onEvent({ type: 'thought', text: action.thought });
    onEvent({ type: 'action', tool: action.action, input: action.action_input || {} });

    let obs;
    if (toolNeedsApproval(action.action)) {
      const ok = await requestApproval(action.action, action.action_input || {});
      if (!ok) {
        obs = '⛔ The user denied this action. Do not retry it; continue or finish.';
        onEvent({ type: 'observation', text: obs });
        messages.push({ role: 'assistant', content: out.text });
        messages.push({ role: 'user', content: `Observation from ${action.action}:\n${obs}\n\nContinue. Reply with the next JSON action (use "final" when done).` });
        continue;
      }
    }

    obs = await executeTool(action.action, action.action_input || {}, ctx);
    onEvent({ type: 'observation', text: obs });

    messages.push({ role: 'assistant', content: out.text });
    messages.push({ role: 'user', content: `Observation from ${action.action}:\n${obs}\n\nContinue. Reply with the next JSON action (use "final" when done).` });
  }

  const text = `Stopped after ${MAX_STEPS} steps without a final answer.`;
  onEvent({ type: 'final', text });
  return { text, steps: MAX_STEPS, truncated: true };
}
