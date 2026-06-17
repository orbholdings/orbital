// Provider adapters with two entry points:
//   chat({ provider, model, messages, settings, keys })            -> { text, demo, provider }
//   chatStream({ ... }, onToken)  streams tokens via onToken(str)  -> { text, demo, provider }
//
// `keys` is the per-user decrypted key map { provider: apiKey }. A user's key
// takes priority over the server env key. Missing key => demo mode.

const ENV_KEY = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  glm: 'ZHIPU_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};

// Per-user key first, then server env.
function resolveKey(provider, keys) {
  const p = provider === 'anthropic' ? 'claude' : provider;
  return (keys && keys[p]) || process.env[ENV_KEY[provider]] || '';
}

const OPENAI_COMPAT = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Orbital' } },
  openai: { url: 'https://api.openai.com/v1/chat/completions' },
  glm: { url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  kimi: { url: 'https://api.moonshot.cn/v1/chat/completions' },
  xai: { url: 'https://api.x.ai/v1/chat/completions' },
};

const OPENAI_COMPAT_PROVIDERS = ['openrouter', 'openai', 'glm', 'kimi', 'xai', 'custom'];

// Resolve the endpoint + key for any OpenAI-compatible provider, including a
// user-defined "custom" one (base URL + a named key, both from the model/settings).
function compatTarget(provider, settings, keys) {
  if (provider === 'custom') {
    let base = (settings?.baseUrl || '').trim().replace(/\/$/, '');
    if (base && !/\/chat\/completions$/.test(base)) base += '/chat/completions';
    const keyName = settings?.keyName || 'custom';
    return { url: base, key: (keys && keys[keyName]) || '', headers: {}, label: keyName || 'custom' };
  }
  const cfg = OPENAI_COMPAT[provider];
  return { url: cfg?.url, key: resolveKey(provider, keys), headers: cfg?.headers || {}, label: provider };
}

const body = (model, messages, settings, stream) => JSON.stringify({
  model, messages, stream,
  temperature: settings?.temperature ?? 0.7,
  max_tokens: settings?.maxTokens ?? 1024,
});

// ---------- non-streaming ------------------------------------------------
async function callOpenAICompat(kind, { model, messages, settings, keys }) {
  const { url, key, headers, label } = compatTarget(kind, settings, keys);
  if (kind === 'custom' && !url) return demo('custom', model, messages, 'no Base URL set');
  if (!key) return demo(label, model, messages, 'no API key set');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers }, body: body(model, messages, settings, false) });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { provider: kind, text: data.choices?.[0]?.message?.content ?? '', raw: data };
}

async function callOllama({ model, messages, settings }) {
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  try {
    const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: false, options: { temperature: settings?.temperature ?? 0.7 } }) });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    return { provider: 'ollama', text: data.message?.content ?? '', raw: data };
  } catch { return demo('ollama', model, messages, 'Ollama not running locally'); }
}

async function callAnthropic({ model, messages, settings, keys }) {
  const key = resolveKey('claude', keys);
  if (!key) return demo('claude', model, messages, 'no API key set');
  const system = messages.find((m) => m.role === 'system')?.content;
  const turns = messages.filter((m) => m.role !== 'system');
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, system, messages: turns, max_tokens: settings?.maxTokens ?? 1024, temperature: settings?.temperature ?? 0.7 }) });
  if (!res.ok) throw new Error(`claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { provider: 'claude', text: data.content?.[0]?.text ?? '', raw: data };
}

function geminiParts(messages) {
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const sys = messages.find((m) => m.role === 'system')?.content;
  return { contents, ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}) };
}
async function callGemini({ model, messages, settings, keys }) {
  const key = resolveKey('gemini', keys);
  if (!key) return demo('gemini', model, messages, 'no API key set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...geminiParts(messages), generationConfig: { temperature: settings?.temperature ?? 0.7 } }) });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { provider: 'gemini', text: data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '', raw: data };
}

function demo(provider, model, messages, reason) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  return { provider, demo: true, raw: null,
    text: `🛰️ [demo:${provider}/${model}] (${reason}). You said: "${String(last).slice(0, 280)}". Add a key in Settings to get real responses.` };
}

export async function chat({ provider, model, messages, settings, keys }) {
  switch (provider) {
    case 'openrouter': case 'openai': case 'glm': case 'kimi': case 'xai': case 'custom':
      return callOpenAICompat(provider, { model, messages, settings, keys });
    case 'ollama': return callOllama({ model, messages, settings });
    case 'claude': case 'anthropic': return callAnthropic({ model, messages, settings, keys });
    case 'gemini': return callGemini({ model, messages, settings, keys });
    default: return demo(provider || 'unknown', model, messages, 'unknown provider');
  }
}

// ---------- streaming ----------------------------------------------------
// Reads a fetch response body line-by-line and feeds each line to `extract`,
// which returns the text delta (or '' to skip). Calls onToken for each delta.
async function streamLines(res, extract, onToken) {
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = extract(line);
      if (t) { full += t; onToken(t); }
    }
  }
  if (buf) { const t = extract(buf); if (t) { full += t; onToken(t); } }
  return full;
}

const exOpenAI = (line) => { line = line.trim(); if (!line.startsWith('data:')) return ''; const d = line.slice(5).trim(); if (!d || d === '[DONE]') return ''; try { return JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch { return ''; } };
const exAnthropic = (line) => { line = line.trim(); if (!line.startsWith('data:')) return ''; try { const o = JSON.parse(line.slice(5).trim()); return o.type === 'content_block_delta' ? (o.delta?.text || '') : ''; } catch { return ''; } };
const exGemini = (line) => { line = line.trim(); if (!line.startsWith('data:')) return ''; try { return JSON.parse(line.slice(5).trim()).candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || ''; } catch { return ''; } };
const exOllama = (line) => { line = line.trim(); if (!line) return ''; try { return JSON.parse(line).message?.content || ''; } catch { return ''; } };

async function demoStream(provider, model, messages, reason, onToken) {
  const d = demo(provider, model, messages, reason);
  for (const word of d.text.split(/(\s+)/)) { onToken(word); await new Promise((r) => setTimeout(r, 12)); }
  return { provider, demo: true, text: d.text };
}

export async function chatStream({ provider, model, messages, settings, keys }, onToken) {
  // OpenAI-compatible (incl. xAI and user-defined custom endpoints)
  if (OPENAI_COMPAT_PROVIDERS.includes(provider)) {
    const { url, key, headers, label } = compatTarget(provider, settings, keys);
    if (provider === 'custom' && !url) return demoStream('custom', model, messages, 'no Base URL set', onToken);
    if (!key) return demoStream(label, model, messages, 'no API key set', onToken);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...headers }, body: body(model, messages, settings, true) });
    const text = await streamLines(res, exOpenAI, onToken);
    return { provider, text };
  }
  // Ollama
  if (provider === 'ollama') {
    const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    try {
      const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true, options: { temperature: settings?.temperature ?? 0.7 } }) });
      const text = await streamLines(res, exOllama, onToken);
      return { provider: 'ollama', text };
    } catch { return demoStream('ollama', model, messages, 'Ollama not running locally', onToken); }
  }
  // Anthropic
  if (provider === 'claude' || provider === 'anthropic') {
    const key = resolveKey('claude', keys);
    if (!key) return demoStream('claude', model, messages, 'no API key set', onToken);
    const system = messages.find((m) => m.role === 'system')?.content;
    const turns = messages.filter((m) => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, system, messages: turns, max_tokens: settings?.maxTokens ?? 1024, temperature: settings?.temperature ?? 0.7, stream: true }) });
    const text = await streamLines(res, exAnthropic, onToken);
    return { provider: 'claude', text };
  }
  // Gemini
  if (provider === 'gemini') {
    const key = resolveKey('gemini', keys);
    if (!key) return demoStream('gemini', model, messages, 'no API key set', onToken);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...geminiParts(messages), generationConfig: { temperature: settings?.temperature ?? 0.7 } }) });
    const text = await streamLines(res, exGemini, onToken);
    return { provider: 'gemini', text };
  }
  return demoStream(provider || 'unknown', model, messages, 'unknown provider', onToken);
}

// Which providers have a SERVER env key? (per-user keys are merged in the route)
export function providerStatus() {
  return {
    openrouter: !!process.env.OPENROUTER_API_KEY,
    ollama: true,
    claude: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    glm: !!process.env.ZHIPU_API_KEY,
    kimi: !!process.env.MOONSHOT_API_KEY,
    xai: !!process.env.XAI_API_KEY,
  };
}
