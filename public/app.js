// ---------- tiny helpers -------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let sb = null;          // supabase client
let accessToken = null; // current JWT

const api = async (path, opts = {}) => {
  const r = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(opts.headers || {}) },
  });
  if (r.status === 401) { showAuth('Your session expired. Please sign in again.'); throw new Error('signed out'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

// Stream a chat reply token-by-token. Calls onToken(str) per chunk; resolves
// with { text, demo }. Uses fetch (not EventSource) so we can send the JWT.
async function streamChat({ conversationId, text, modelId }, onToken) {
  const r = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ conversationId, text, modelId }),
  });
  if (r.status === 401) { showAuth('Your session expired. Please sign in again.'); throw new Error('signed out'); }
  if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', acc = '', demo = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const p of parts) {
      const line = p.trim(); if (!line.startsWith('data:')) continue;
      let obj; try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (obj.token) { acc += obj.token; onToken(acc); }
      if (obj.error) throw new Error(obj.error);
      if (obj.done) demo = !!obj.demo;
    }
  }
  return { text: acc, demo };
}

// Generic SSE reader: POST with auth, parse each `data:` line as JSON, call onEvent.
async function streamSSE(path, body, onEvent) {
  const r = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { showAuth('Your session expired. Please sign in again.'); throw new Error('signed out'); }
  if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const p of parts) {
      const line = p.trim(); if (!line.startsWith('data:')) continue;
      try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
    }
  }
}

const PROVIDER_ICONS = { claude: '🟣', openai: '🟢', gpt: '🟢', gemini: '🔷', glm: '🟠', kimi: '🌙', ollama: '🦙', openrouter: '🛰', xai: '⚡', custom: '🔧' };
const icon = (p) => PROVIDER_ICONS[p] || '◍';

const state = { view: 'overview', chatModel: null };

// ===================================================================
//  AUTH / BOOT
// ===================================================================
async function boot() {
  let cfg;
  try { cfg = await (await fetch('/api/config')).json(); } catch { cfg = { configured: false }; }

  if (!cfg.configured || !window.supabase) {
    return showSetupNeeded();
  }
  sb = window.supabase.createClient(cfg.url, cfg.anonKey);

  const { data } = await sb.auth.getSession();
  if (data.session) { onSignedIn(data.session); } else { showAuth(); }

  sb.auth.onAuthStateChange((_e, sessionObj) => {
    if (sessionObj) onSignedIn(sessionObj);
    else { accessToken = null; showAuth(); }
  });
}

function showSetupNeeded() {
  $('#app').hidden = true;
  const a = $('#auth-screen'); a.hidden = false;
  $('.auth-card', a).innerHTML = `
    <div class="brand" style="justify-content:center;padding-bottom:8px"><div class="brand-mark">🛰</div>
      <div class="brand-text"><span class="brand-name">Orbital</span><span class="brand-sub">needs Supabase</span></div></div>
    <div class="setup-note">
      <p class="muted small">The server isn't connected to Supabase yet. Set these environment
      variables (in Coolify → your app → Environment), then redeploy:</p>
      <pre>SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...</pre>
      <p class="muted small">And run <b>supabase/schema.sql</b> once in the Supabase SQL editor. See the README.</p>
    </div>`;
}

function showAuth(message) {
  $('#app').hidden = true;
  $('#auth-screen').hidden = false;
  if (message) $('#auth-error').textContent = message;
}

let authMode = 'signin';
function wireAuth() {
  const submit = $('#auth-submit'), toggle = $('#auth-toggle');
  const setMode = (m) => {
    authMode = m;
    submit.textContent = m === 'signin' ? 'Sign in' : 'Create account';
    $('#auth-msg').textContent = m === 'signin' ? 'Sign in to your workspace' : 'Create your workspace';
    $('#auth-toggle-text').textContent = m === 'signin' ? 'No account?' : 'Already have one?';
    toggle.textContent = m === 'signin' ? 'Create one' : 'Sign in';
  };
  toggle.onclick = (e) => { e.preventDefault(); setMode(authMode === 'signin' ? 'signup' : 'signin'); };
  const go = async () => {
    $('#auth-error').textContent = '';
    const email = $('#auth-email').value.trim(), password = $('#auth-pass').value;
    if (!email || !password) return ($('#auth-error').textContent = 'Email and password required.');
    submit.disabled = true; submit.textContent = '…';
    try {
      const fn = authMode === 'signin' ? sb.auth.signInWithPassword({ email, password }) : sb.auth.signUp({ email, password });
      const { data, error } = await fn;
      if (error) throw error;
      if (!data.session) $('#auth-error').textContent = 'Check your email to confirm, then sign in.';
    } catch (err) { $('#auth-error').textContent = err.message || 'Authentication failed.'; }
    finally { submit.disabled = false; setMode(authMode); }
  };
  submit.onclick = go;
  $('#auth-pass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function onSignedIn(sessionObj) {
  accessToken = sessionObj.access_token;
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  $('#user-email').textContent = sessionObj.user?.email || '';
  bootDots();
  go('overview');
}

$('#signout').onclick = async () => { await sb.auth.signOut(); };

// ===================================================================
//  MODAL
// ===================================================================
function openModal(title, bodyNode) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body'); body.innerHTML = ''; body.appendChild(bodyNode);
  $('#modal').hidden = false;
}
const closeModal = () => { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } $('#modal').hidden = true; };
$('#modal-close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

// ===================================================================
//  NAV
// ===================================================================
const TITLES = {
  overview: ['Overview', 'Your constellation at a glance'],
  chat: ['Chat', 'Talk to any model, or broadcast to all'],
  models: ['Models', 'Each LLM with its own settings'],
  memory: ['Memory', 'Shared + private notes every AI can use'],
  files: ['Files', 'Combined workspace and per-model trees'],
  agents: ['Agents', 'Hermes, OpenClaw, OpenCode and more'],
  skills: ['Skills', 'Reusable instructions your agents can run'],
  harnesses: ['Harnesses', 'Install gateways, tools and integrations'],
  settings: ['Settings', 'Your provider API keys, stored encrypted'],
};
function go(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-title').textContent = TITLES[view][0];
  $('#view-sub').textContent = TITLES[view][1];
  $('#topbar-actions').innerHTML = '';
  render();
}
$('#nav').onclick = (e) => { const b = e.target.closest('.nav-item'); if (b) go(b.dataset.view); };

async function render() {
  const c = $('#content');
  c.innerHTML = '<div class="spinner"></div>';
  try {
    const fn = { overview: renderOverview, chat: renderChat, models: renderModels, memory: renderMemory, files: renderFiles, agents: renderAgents, skills: renderSkills, harnesses: renderHarnesses, settings: renderSettings }[state.view];
    if (fn) await fn(c);
  } catch (e) {
    if (e.message === 'signed out') return;
    c.innerHTML = `<div class="empty">Couldn't load: ${esc(e.message)}</div>`;
  }
}

// ===================================================================
//  OVERVIEW
// ===================================================================
async function renderOverview(c) {
  const [status, models, agents, harnesses] = await Promise.all([api('/status'), api('/models'), api('/agents'), api('/harnesses')]);
  const installed = harnesses.filter((h) => h.status === 'installed');
  c.innerHTML = '';
  c.appendChild(el(`<div class="grid cols-4" style="margin-bottom:18px">
    <div class="card stat"><span class="num">${models.length}</span><span class="lbl">Models connected</span></div>
    <div class="card stat"><span class="num">${agents.length}</span><span class="lbl">Agents ready</span></div>
    <div class="card stat"><span class="num">${status.counts.memory}</span><span class="lbl">Memory notes</span></div>
    <div class="card stat"><span class="num">${installed.length}</span><span class="lbl">Harnesses installed</span></div></div>`));

  const orbit = el(`<div class="card" style="margin-bottom:18px"><h3>Your orbit</h3><p class="muted small">Models orbiting one shared memory.</p><div class="tag-row" id="orbit-row"></div></div>`);
  c.appendChild(orbit);
  models.forEach((m) => $('#orbit-row', orbit).appendChild(el(`<span class="pill ${m.enabled ? 'on' : ''}">${icon(m.provider)} ${esc(m.label)}</span>`)));

  c.appendChild(el(`<div class="grid cols-2">
    <div class="card"><h3>Quick start</h3>
      <ol class="muted small" style="line-height:1.9;padding-left:18px;margin:8px 0 0">
        <li>Add provider keys server-side (OpenRouter covers most models with one key).</li>
        <li>Open <b>Chat</b> and pick a model — or broadcast to all at once.</li>
        <li>Save facts in <b>Memory</b>; every model can read and add to it.</li>
        <li>Upload files, run an <b>Agent</b>, or install a <b>Harness</b> like NotebookLM.</li>
      </ol></div>
    <div class="card"><h3>Providers</h3>
      <div class="tag-row" style="margin-top:12px">
        ${Object.entries(status.providers).map(([p, on]) => `<span class="pill ${on ? 'on' : ''}">${icon(p)} ${p}${on ? '' : ' · no key'}</span>`).join('')}
      </div>
      <p class="muted small" style="margin-top:14px">Green = ready. Others run in demo mode until a key is set.</p></div></div>`));
}

// ===================================================================
//  CHAT
// ===================================================================
async function renderChat(c) {
  const models = await api('/models');
  if (!state.chatModel && models[0]) state.chatModel = models[0].id;
  const modelLabel = (id) => models.find((m) => m.id === id)?.label || 'model';
  const actions = el(`<div style="display:flex;gap:10px"><button class="btn small" id="single-mode">Single</button><button class="btn small primary" id="bcast-mode">Broadcast</button></div>`);
  $('#topbar-actions').innerHTML = ''; $('#topbar-actions').appendChild(actions);
  let mode = 'single';
  const draw = () => {
    $('#single-mode').classList.toggle('primary', mode === 'single');
    $('#bcast-mode').classList.toggle('primary', mode === 'broadcast');
    mode === 'single' ? drawSingle() : drawBroadcast();
  };
  $('#single-mode').onclick = () => { mode = 'single'; draw(); };
  $('#bcast-mode').onclick = () => { mode = 'broadcast'; draw(); };

  async function drawSingle() {
    c.innerHTML = '';
    const opts = models.map((m) => `<option value="${m.id}" ${m.id === state.chatModel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    const wrap = el(`<div class="chat-layout">
      <aside class="chat-side">
        <button class="btn small primary" id="new-chat" style="width:100%">+ New chat</button>
        <input id="chat-search" placeholder="Search chats…" style="margin:10px 0" />
        <div class="convo-list" id="convo-list"></div>
      </aside>
      <div class="chat-pane">
        <div class="chat-head"><select id="chat-model" style="width:auto">${opts}</select><span class="muted small" id="convo-title"></span></div>
        <div class="chat-log" id="log"></div>
        <div class="chat-input"><input id="chat-text" placeholder="Message the model…" /><button class="btn primary" id="send">Send</button></div>
      </div></div>`);
    c.appendChild(wrap);
    const log = $('#log', wrap), listEl = $('#convo-list', wrap), titleEl = $('#convo-title', wrap);
    $('#chat-model', wrap).onchange = (e) => (state.chatModel = e.target.value);

    const bubble = (role, content, who) => {
      const cls = role === 'user' ? 'user' : 'bot';
      return el(`<div class="msg ${cls}"><div class="who">${esc(who || (role === 'user' ? 'you' : 'assistant'))}</div><span class="body">${esc(content)}</span></div>`);
    };
    const showMessages = (msgs) => {
      log.innerHTML = '';
      if (!msgs.length) { log.appendChild(el('<div class="empty" style="margin:auto">Say something to start this chat.</div>')); return; }
      msgs.forEach((m) => log.appendChild(bubble(m.role, m.content, m.role === 'assistant' ? modelLabel(state.chatModel) : 'you')));
      log.scrollTop = log.scrollHeight;
    };

    async function loadList() {
      const convos = await api('/conversations');
      listEl.innerHTML = '';
      if (!convos.length) { listEl.appendChild(el('<p class="muted small" style="padding:8px">No saved chats yet.</p>')); return; }
      convos.forEach((cv) => {
        const item = el(`<div class="convo-item ${cv.id === state.currentConvo ? 'active' : ''}" data-id="${cv.id}">
          <span class="convo-title">${esc(cv.title)}</span>
          <button class="icon-btn convo-del" data-del="${cv.id}" title="Delete">✕</button></div>`);
        listEl.appendChild(item);
      });
    }

    async function openConvo(id) {
      state.currentConvo = id;
      const cv = (await api('/conversations')).find((x) => x.id === id);
      if (cv?.model_id) { state.chatModel = cv.model_id; $('#chat-model', wrap).value = cv.model_id; }
      titleEl.textContent = cv?.title || '';
      const msgs = await api(`/conversations/${id}/messages`);
      showMessages(msgs);
      loadList();
    }

    async function newChat() {
      const cv = await api('/conversations', { method: 'POST', body: JSON.stringify({ modelId: state.chatModel }) });
      state.currentConvo = cv.id;
      titleEl.textContent = cv.title;
      showMessages([]);
      loadList();
      $('#chat-text', wrap).focus();
    }

    const send = async () => {
      const input = $('#chat-text', wrap), text = input.value.trim(); if (!text) return;
      if (!state.currentConvo) await newChat();
      input.value = '';
      if ($('.empty', log)) log.innerHTML = '';
      log.appendChild(bubble('user', text, 'you'));
      const bot = el(`<div class="msg bot"><div class="who">${esc(modelLabel(state.chatModel))}</div><span class="body"><span class="spinner"></span></span></div>`);
      log.appendChild(bot); log.scrollTop = log.scrollHeight;
      const bodyEl = $('.body', bot), whoEl = $('.who', bot);
      try {
        const out = await streamChat({ conversationId: state.currentConvo, text, modelId: state.chatModel }, (sofar) => {
          bodyEl.textContent = sofar; log.scrollTop = log.scrollHeight;
        });
        if (out.demo) whoEl.textContent = `${modelLabel(state.chatModel)} · demo`;
        if (!out.text) bodyEl.textContent = '(no response)';
        loadList(); // title/order may have changed
      } catch (e) { if (e.message !== 'signed out') { whoEl.textContent = 'error'; bodyEl.textContent = e.message; } }
      log.scrollTop = log.scrollHeight;
    };

    // search across saved messages
    let searchTimer;
    $('#chat-search', wrap).oninput = (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      searchTimer = setTimeout(async () => {
        if (!q) return loadList();
        const hits = await api(`/conversations/search?q=${encodeURIComponent(q)}`);
        listEl.innerHTML = '';
        if (!hits.length) { listEl.appendChild(el('<p class="muted small" style="padding:8px">No matches.</p>')); return; }
        hits.forEach((h) => listEl.appendChild(el(`<div class="convo-item" data-open="${h.conversation_id}">
          <span class="convo-title">${esc(h.conversationTitle)}</span>
          <span class="muted small convo-snippet">${esc(h.content.slice(0, 70))}</span></div>`)));
      }, 250);
    };

    listEl.onclick = async (e) => {
      const del = e.target.dataset.del;
      if (del) { e.stopPropagation(); await api(`/conversations/${del}`, { method: 'DELETE' }); if (del === state.currentConvo) { state.currentConvo = null; showMessages([]); titleEl.textContent = ''; } return loadList(); }
      const item = e.target.closest('[data-id],[data-open]');
      if (item) openConvo(item.dataset.id || item.dataset.open);
    };
    $('#new-chat', wrap).onclick = newChat;
    $('#send', wrap).onclick = send;
    $('#chat-text', wrap).onkeydown = (e) => { if (e.key === 'Enter') send(); };

    await loadList();
    if (state.currentConvo) openConvo(state.currentConvo); else showMessages([]);
  }

  function drawBroadcast() {
    c.innerHTML = '';
    const checks = models.map((m) => `<label class="pill" style="cursor:pointer"><input type="checkbox" value="${m.id}" checked style="width:auto;margin-right:6px">${icon(m.provider)} ${esc(m.label)}</label>`).join(' ');
    const wrap = el(`<div><div class="card" style="margin-bottom:16px">
      <div class="tag-row" id="bcast-models">${checks}</div>
      <div class="chat-input" style="border:none;padding:14px 0 0"><input id="bcast-text" placeholder="Ask every selected model the same thing…" /><button class="btn primary" id="bcast-send">Broadcast</button></div>
    </div><div class="broadcast-grid" id="bcast-out"></div></div>`);
    c.appendChild(wrap);
    $('#bcast-send', wrap).onclick = async () => {
      const text = $('#bcast-text', wrap).value.trim(); if (!text) return;
      const ids = $$('#bcast-models input:checked', wrap).map((i) => i.value);
      const out = $('#bcast-out', wrap); out.innerHTML = '';
      const cards = {};
      ids.forEach((id) => { const m = models.find((x) => x.id === id);
        cards[id] = el(`<div class="card"><div class="row"><h3>${icon(m.provider)} ${esc(m.label)}</h3></div><div class="muted small" style="margin-top:10px"><span class="spinner"></span></div></div>`);
        out.appendChild(cards[id]); });
      try {
        const results = await api('/chat/broadcast', { method: 'POST', body: JSON.stringify({ modelIds: ids, message: text }) });
        results.forEach((r) => {
          const card = cards[r.modelId];
          $('.muted', card).innerHTML = r.error ? `<span style="color:var(--danger)">${esc(r.error)}</span>` : esc(r.text);
          if (!r.error) {
            const cont = el(`<button class="btn small ghost" style="margin-top:10px">↳ Continue with ${esc(r.label)}</button>`);
            cont.onclick = () => continueFromBroadcast(r.modelId, text, r.text);
            card.appendChild(cont);
          }
        });
      } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
  }

  // Turn one model's broadcast answer into an ongoing single chat.
  async function continueFromBroadcast(modelId, prompt, answer) {
    const cv = await api('/conversations', { method: 'POST', body: JSON.stringify({
      modelId, title: prompt.slice(0, 60),
      seed: [{ role: 'user', content: prompt }, { role: 'assistant', content: answer }],
    }) });
    state.chatModel = modelId;
    state.currentConvo = cv.id;
    mode = 'single';
    draw();
  }
  draw();
}

// ===================================================================
//  MODELS
// ===================================================================
async function renderModels(c) {
  const models = await api('/models');
  $('#topbar-actions').appendChild(el(`<button class="btn primary" id="add-model">+ Add model</button>`));
  $('#add-model').onclick = () => modelForm();
  c.innerHTML = '';
  if (!models.length) { c.appendChild(el('<div class="empty">No models yet. Add one to get started.</div>')); return; }
  const grid = el('<div class="grid cols-3"></div>');
  models.forEach((m) => grid.appendChild(el(`<div class="card">
    <div class="row"><h3>${icon(m.provider)} ${esc(m.label)}</h3><span class="pill ${m.enabled ? 'on' : ''}">${m.enabled ? 'on' : 'off'}</span></div>
    <p class="muted small" style="margin:6px 0 0">${esc(m.provider)} · ${esc(m.model || 'no model id')}</p>
    <div class="tag-row">
      <span class="pill">temp ${m.settings?.temperature ?? 0.7}</span>
      <span class="pill">${m.settings?.maxTokens ?? 1024} tok</span>
      <span class="pill ${m.settings?.useSharedMemory !== false ? 'accent' : ''}">${m.settings?.useSharedMemory !== false ? 'shared mem' : 'private only'}</span></div>
    <div class="modal-foot" style="margin-top:16px"><button class="btn small ghost" data-edit="${m.id}">Settings</button><button class="btn small danger" data-del="${m.id}">Delete</button></div></div>`)));
  c.appendChild(grid);
  grid.onclick = async (e) => {
    const ed = e.target.dataset.edit, dl = e.target.dataset.del;
    if (ed) modelForm(models.find((m) => m.id === ed));
    if (dl) { await api(`/models/${dl}`, { method: 'DELETE' }); render(); }
  };
}

function modelForm(m = {}) {
  const s = m.settings || {};
  const providers = ['openrouter', 'ollama', 'claude', 'openai', 'gemini', 'glm', 'kimi', 'xai', 'custom'];
  const body = el(`<div>
    <label class="field">Display name<input id="f-label" value="${esc(m.label || '')}" placeholder="e.g. Claude"></label>
    <label class="field">Provider<select id="f-provider">${providers.map((p) => `<option ${p === m.provider ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <div id="f-custom" hidden>
      <label class="field">Base URL (OpenAI-compatible)<input id="f-baseurl" value="${esc(s.baseUrl || '')}" placeholder="e.g. https://api.x.ai/v1"></label>
      <label class="field">Key name<input id="f-keyname" value="${esc(s.keyName || '')}" placeholder="matches a key you add in Settings, e.g. xai"></label>
      <p class="muted small" style="margin:-6px 0 12px">Add the matching key in <b>Settings → Custom providers</b>. Works with any OpenAI-style API (xAI, DeepSeek, Groq, Mistral, local…).</p>
    </div>
    <label class="field">Model id<input id="f-model" value="${esc(m.model || '')}" placeholder="e.g. anthropic/claude-sonnet-4"></label>
    <label class="field">System prompt<textarea id="f-sys" placeholder="Optional persona / instructions">${esc(s.systemPrompt || '')}</textarea></label>
    <label class="field">Temperature <span id="t-val">${s.temperature ?? 0.7}</span><div class="range-row"><input type="range" id="f-temp" min="0" max="2" step="0.1" value="${s.temperature ?? 0.7}"></div></label>
    <label class="field">Max tokens<input type="number" id="f-max" value="${s.maxTokens ?? 1024}"></label>
    <label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="f-mem" style="width:auto" ${s.useSharedMemory !== false ? 'checked' : ''}> Use shared memory</label>
    <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div></div>`);
  openModal(m.id ? 'Model settings' : 'Add model', body);
  const toggleCustom = () => { $('#f-custom', body).hidden = $('#f-provider', body).value !== 'custom'; };
  $('#f-provider', body).onchange = toggleCustom; toggleCustom();
  $('#f-temp', body).oninput = (e) => ($('#t-val', body).textContent = e.target.value);
  $('#cancel', body).onclick = closeModal;
  $('#save', body).onclick = async () => {
    const provider = $('#f-provider', body).value;
    const settings = { systemPrompt: $('#f-sys', body).value, temperature: +$('#f-temp', body).value, maxTokens: +$('#f-max', body).value, useSharedMemory: $('#f-mem', body).checked };
    if (provider === 'custom') { settings.baseUrl = $('#f-baseurl', body).value.trim(); settings.keyName = $('#f-keyname', body).value.trim().toLowerCase(); }
    await api('/models', { method: 'POST', body: JSON.stringify({ id: m.id, label: $('#f-label', body).value, provider, model: $('#f-model', body).value, settings }) });
    closeModal(); render();
  };
}

// ===================================================================
//  MEMORY
// ===================================================================
async function renderMemory(c) {
  const [mem, models] = await Promise.all([api('/memory'), api('/models')]);
  c.innerHTML = '';
  const add = el(`<div class="card" style="margin-bottom:18px"><h3>Add to memory</h3>
    <div style="display:grid;grid-template-columns:170px 1fr auto;gap:10px;margin-top:12px;align-items:end">
      <label class="field" style="margin:0">Scope<select id="m-scope"><option value="shared">Shared (all AIs)</option>${models.map((m) => `<option value="${m.id}">${esc(m.label)} (private)</option>`).join('')}</select></label>
      <label class="field" style="margin:0">Note<input id="m-text" placeholder="A fact every AI should remember…"></label>
      <button class="btn primary" id="m-add">Save</button></div></div>`);
  c.appendChild(add);
  $('#m-add', add).onclick = async () => {
    const text = $('#m-text', add).value.trim(); if (!text) return;
    await api('/memory', { method: 'POST', body: JSON.stringify({ scope: $('#m-scope', add).value, author: 'user', text }) });
    render();
  };
  if (!mem.length) { c.appendChild(el('<div class="empty">No memory yet. Shared notes are visible to every model.</div>')); return; }
  const list = el('<div class="list"></div>');
  const nameFor = (s) => s === 'shared' ? 'Shared' : (models.find((m) => m.id === s)?.label || s);
  mem.slice().reverse().forEach((e) => list.appendChild(el(`<div class="list-item">
    <div style="display:flex;gap:12px;align-items:center;min-width:0"><div class="avatar">${e.scope === 'shared' ? '❖' : '🔒'}</div>
      <div class="meta"><b>${esc(e.text)}</b><span class="muted small">${esc(nameFor(e.scope))} · by ${esc(e.author)}</span></div></div>
    <button class="btn small danger" data-del="${e.id}">Delete</button></div>`)));
  c.appendChild(list);
  list.onclick = async (ev) => { const d = ev.target.dataset.del; if (d) { await api(`/memory/${d}`, { method: 'DELETE' }); render(); } };
}

// ===================================================================
//  FILES  (text files + Storage uploads)
// ===================================================================
async function renderFiles(c) {
  const [tree, models] = await Promise.all([api('/files'), api('/models')]);
  $('#topbar-actions').appendChild(el(`<button class="btn" id="upload-file">⬆ Upload</button>`));
  $('#topbar-actions').appendChild(el(`<button class="btn primary" id="add-file">+ New file</button>`));
  $('#add-file').onclick = () => fileForm(models);
  $('#upload-file').onclick = () => uploadForm(models);
  c.innerHTML = '';
  const nameFor = (s) => s === 'combined' ? '📦 Combined (shared)' : `🔒 ${models.find((m) => m.id === s)?.label || s}`;
  const scopes = Object.keys(tree);
  if (!scopes.length) { c.appendChild(el('<div class="empty">No files yet. The combined tree is shared by all models.</div>')); return; }
  scopes.sort((a) => (a === 'combined' ? -1 : 1)).forEach((scope) => {
    const card = el(`<div class="card" style="margin-bottom:14px"><h3>${nameFor(scope)}</h3><div class="list" style="margin-top:12px"></div></div>`);
    const list = $('.list', card);
    tree[scope].forEach((f) => list.appendChild(el(`<div class="list-item">
      <div style="display:flex;gap:12px;align-items:center"><div class="avatar">${f.storage ? '📎' : '▤'}</div><div class="meta"><b>${esc(f.path)}</b><span class="muted small">${new Date(f.updatedAt).toLocaleString()}</span></div></div>
      <div style="display:flex;gap:8px">${f.storage ? `<button class="btn small ghost" data-dl="${f.id}">Download</button>` : `<button class="btn small ghost" data-open="${f.id}">Open</button>`}<button class="btn small danger" data-rm="${f.id}">✕</button></div></div>`)));
    c.appendChild(card);
  });
  c.onclick = async (e) => {
    const open = e.target.dataset.open, dl = e.target.dataset.dl, rm = e.target.dataset.rm;
    if (open) { const all = await api('/files/all'); fileForm(models, all.find((x) => x.id === open)); }
    if (dl) { const { url } = await api(`/files/${dl}/url`); window.open(url, '_blank'); }
    if (rm) { await api(`/files/${rm}`, { method: 'DELETE' }); render(); }
  };
}

function fileForm(models, f = {}) {
  const body = el(`<div>
    <label class="field">Scope<select id="f-scope" ${f.id ? 'disabled' : ''}><option value="combined">Combined (shared)</option>${models.map((m) => `<option value="${m.id}" ${f.scope === m.id ? 'selected' : ''}>${esc(m.label)} (private)</option>`).join('')}</select></label>
    <label class="field">Path<input id="f-path" value="${esc(f.path || '')}" placeholder="notes/idea.md"></label>
    <label class="field">Content<textarea id="f-content" style="min-height:180px">${esc(f.content || '')}</textarea></label>
    <div class="modal-foot">${f.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div></div>`);
  openModal(f.id ? 'Edit file' : 'New file', body);
  $('#cancel', body).onclick = closeModal;
  if (f.id) $('#del', body).onclick = async () => { await api(`/files/${f.id}`, { method: 'DELETE' }); closeModal(); render(); };
  $('#save', body).onclick = async () => {
    await api('/files', { method: 'POST', body: JSON.stringify({ id: f.id, scope: $('#f-scope', body).value, path: $('#f-path', body).value, content: $('#f-content', body).value }) });
    closeModal(); render();
  };
}

function uploadForm(models) {
  const body = el(`<div>
    <label class="field">Scope<select id="u-scope"><option value="combined">Combined (shared)</option>${models.map((m) => `<option value="${m.id}">${esc(m.label)} (private)</option>`).join('')}</select></label>
    <label class="field">File<input type="file" id="u-file"></label>
    <p class="muted small">Stored in your private Supabase Storage bucket. Use for documents to ground answers (e.g. NotebookLM).</p>
    <div class="modal-foot"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Upload</button></div>
    <p class="small" id="u-msg" style="color:var(--danger)"></p></div>`);
  openModal('Upload file', body);
  $('#cancel', body).onclick = closeModal;
  $('#save', body).onclick = async () => {
    const file = $('#u-file', body).files[0];
    if (!file) return ($('#u-msg', body).textContent = 'Pick a file first.');
    $('#save', body).disabled = true; $('#u-msg', body).style.color = 'var(--muted)'; $('#u-msg', body).textContent = 'Uploading…';
    try {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      await api('/files/upload', { method: 'POST', body: JSON.stringify({ scope: $('#u-scope', body).value, filename: file.name, contentType: file.type, base64 }) });
      closeModal(); render();
    } catch (e) { $('#u-msg', body).style.color = 'var(--danger)'; $('#u-msg', body).textContent = e.message; $('#save', body).disabled = false; }
  };
}

// ===================================================================
//  AGENTS
// ===================================================================
async function renderAgents(c) {
  const [agents, models] = await Promise.all([api('/agents'), api('/models')]);
  $('#topbar-actions').appendChild(el(`<button class="btn primary" id="add-agent">+ New agent</button>`));
  $('#add-agent').onclick = () => agentForm(models);
  c.innerHTML = '';
  const grid = el('<div class="grid cols-2"></div>');
  const KIND = { hermes: '✷', openclaw: '🦅', opencode: '⌨' };
  agents.forEach((a) => {
    const model = models.find((m) => m.id === a.model_id);
    grid.appendChild(el(`<div class="card">
      <div class="row"><h3>${KIND[a.kind] || '✷'} ${esc(a.name)}</h3><span class="pill">${esc(a.kind)}</span></div>
      <p class="muted small" style="margin:6px 0">${esc(a.instructions)}</p>
      <p class="small">Model: <b>${esc(model?.label || '—')}</b></p>
      <div class="tag-row">${(a.tools || []).map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>
      <div class="modal-foot" style="margin-top:14px"><button class="btn small ghost" data-edit="${a.id}">Edit</button><button class="btn small primary" data-run="${a.id}">Run</button></div>
      <div class="muted small" data-out="${a.id}" style="margin-top:12px"></div></div>`));
  });
  c.appendChild(grid);
  grid.onclick = (e) => {
    const ed = e.target.dataset.edit, run = e.target.dataset.run;
    if (ed) agentForm(models, agents.find((a) => a.id === ed));
    if (run) agentRunModal(agents.find((a) => a.id === run));
  };

  // Recent background runs (keep working after you close the box).
  const runs = await api('/agents/runs').catch(() => []);
  const RUN_BADGE = { running: 'running', awaiting_approval: 'needs approval', done: 'done', error: 'error' };
  const sect = el(`<div style="margin-top:24px"><h3 style="margin:0 0 10px">Recent runs</h3><div class="list" id="runs-list"></div></div>`);
  c.appendChild(sect);
  const rl = $('#runs-list', sect);
  if (!runs.length) rl.appendChild(el('<p class="muted small">No runs yet. Run an agent — it keeps working even if you close the window.</p>'));
  else runs.forEach((r) => rl.appendChild(el(`<div class="list-item" data-run-open="${r.id}" style="cursor:pointer">
    <div style="display:flex;gap:12px;align-items:center;min-width:0"><div class="avatar">${r.status === 'running' ? '<span class="spinner"></span>' : r.status === 'error' ? '⚠️' : r.status === 'awaiting_approval' ? '🔐' : '✅'}</div>
      <div class="meta" style="min-width:0"><b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.agent_name)} · ${esc(r.task)}</b><span class="muted small">${new Date(r.created_at).toLocaleString()}</span></div></div>
    <span class="pill ${r.status === 'done' ? 'on' : r.status === 'error' ? '' : 'accent'}">${RUN_BADGE[r.status] || r.status}</span></div>`)));
  rl.onclick = (e) => { const id = e.target.closest('[data-run-open]')?.dataset.runOpen; if (id) runViewerModal(id); };
}

// Start a background run, then poll its trace. Closing the box does NOT stop it.
function agentRunModal(agent) {
  const body = el(`<div>
    <label class="field">Task<textarea id="run-task" style="min-height:64px" placeholder="What should ${esc(agent.name)} do?">Introduce yourself and your capabilities.</textarea></label>
    <div class="modal-foot"><button class="btn" id="cancel">Close</button><button class="btn primary" id="go">Run agent</button></div>
    <p class="muted small" id="run-note" style="margin-top:8px"></p>
    <div id="trace" class="run-trace"></div></div>`);
  openModal(`Run ${agent.name}`, body);
  $('#cancel', body).onclick = closeModal;
  $('#go', body).onclick = async () => {
    const task = $('#run-task', body).value.trim();
    $('#go', body).disabled = true;
    $('#run-note', body).textContent = 'Running in the background — you can close this window and reopen it from "Recent runs".';
    try {
      const { runId } = await api(`/agents/${agent.id}/run`, { method: 'POST', body: JSON.stringify({ task }) });
      pollRun(runId, $('#trace', body));
    } catch (e) { $('#trace', body).innerHTML = `<div class="step error"><span class="step-text">${esc(e.message)}</span></div>`; $('#go', body).disabled = false; }
  };
}

// Open an existing run (from the Recent runs list).
function runViewerModal(runId) {
  const body = el(`<div><p class="muted small">Live trace — updates automatically.</p><div id="trace" class="run-trace" style="max-height:60vh"></div>
    <div class="modal-foot"><button class="btn" id="cancel">Close</button></div></div>`);
  openModal('Agent run', body);
  $('#cancel', body).onclick = closeModal;
  pollRun(runId, $('#trace', body));
}

// Poll a run's events every 1.5s and render the trace. Stops on done/error or modal close.
function pollRun(runId, trace) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const render = (run, events) => {
    trace.innerHTML = '';
    events.forEach((ev) => {
      const d = ev.data || {};
      const subPfx = d.sub ? `<span class="pill" style="margin-right:6px">${esc(d.sub)}</span>` : '';
      if (ev.type === 'start') addStep(trace, 'start', '▶ start', `${d.agent} · ${d.model}`, subPfx);
      else if (ev.type === 'thought') addStep(trace, 'thought', '💭 thinking', d.text, subPfx);
      else if (ev.type === 'action') addStep(trace, 'action', `🛠 ${d.tool}`, JSON.stringify(d.input), subPfx);
      else if (ev.type === 'observation') addStep(trace, 'obs', '↳ result', d.text, subPfx);
      else if (ev.type === 'final') addStep(trace, 'final', '✅ done', d.text, subPfx);
      else if (ev.type === 'error') addStep(trace, 'error', '⚠️ error', d.text, subPfx);
      else if (ev.type === 'approval_request') {
        const resolved = events.find((x) => x.type === 'approval_resolved' && x.data?.reqId === d.reqId);
        if (resolved) addStep(trace, 'approval', '🔐 ' + (resolved.data.decision === 'deny' ? 'denied' : 'approved'), `${d.tool} ${JSON.stringify(d.input)}`, subPfx);
        else addApproval(trace, runId, d);
      }
    });
    trace.scrollTop = trace.scrollHeight;
  };
  const tick = async () => {
    try {
      const { run, events } = await api(`/runs/${runId}`);
      render(run, events);
      if (run.status === 'done' || run.status === 'error') { clearInterval(state.pollTimer); state.pollTimer = null; }
    } catch (e) { if (e.message === 'signed out') { clearInterval(state.pollTimer); state.pollTimer = null; } }
  };
  tick();
  state.pollTimer = setInterval(tick, 1500);
}
function addStep(trace, cls, label, text, pfx = '') {
  trace.appendChild(el(`<div class="step ${cls}"><span class="step-label">${label}</span><span class="step-text">${pfx}${esc(text ?? '')}</span></div>`));
}
function addApproval(trace, runId, d) {
  const node = el(`<div class="step approval"><span class="step-label">🔐 approve?</span>
    <span class="step-text"><b>${esc(d.tool)}</b> ${esc(JSON.stringify(d.input))}
    <span class="approve-row">
      <button class="btn small primary" data-d="once">Approve once</button>
      <button class="btn small" data-d="always">Approve every time</button>
      <button class="btn small danger" data-d="deny">Deny</button>
    </span></span></div>`);
  trace.appendChild(node);
  node.querySelector('.approve-row').onclick = async (e) => {
    const dec = e.target.dataset.d; if (!dec) return;
    node.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try { await api('/agents/approve', { method: 'POST', body: JSON.stringify({ runId, reqId: d.reqId, decision: dec }) }); } catch {}
  };
}

async function agentForm(models, a = {}) {
  const kinds = ['hermes', 'openclaw', 'opencode', 'custom'];
  const allTools = await api('/tools').catch(() => []);
  const have = new Set(a.tools || []);
  const toolChecks = allTools.map((t) => `<label class="pill" style="cursor:pointer"><input type="checkbox" value="${t}" ${have.has(t) ? 'checked' : ''} style="width:auto;margin-right:6px">${t}</label>`).join(' ');
  const body = el(`<div>
    <label class="field">Name<input id="a-name" value="${esc(a.name || '')}"></label>
    <label class="field">Kind<select id="a-kind">${kinds.map((k) => `<option ${k === a.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="field">Model<select id="a-model">${models.map((m) => `<option value="${m.id}" ${m.id === a.model_id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
    <label class="field">Instructions<textarea id="a-inst">${esc(a.instructions || '')}</textarea></label>
    <label class="field">Tools the agent may use<div class="tag-row" id="a-tools">${toolChecks || '<span class="muted small">No tools available</span>'}</div></label>
    <p class="muted small" style="margin:-6px 0 12px">Your saved <b>skills</b> are always available via the <code>skill.run</code> tool.</p>
    <div class="modal-foot">${a.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div></div>`);
  openModal(a.id ? 'Edit agent' : 'New agent', body);
  $('#cancel', body).onclick = closeModal;
  if (a.id) $('#del', body).onclick = async () => { await api(`/agents/${a.id}`, { method: 'DELETE' }); closeModal(); render(); };
  $('#save', body).onclick = async () => {
    const tools = $$('#a-tools input:checked', body).map((i) => i.value);
    await api('/agents', { method: 'POST', body: JSON.stringify({ id: a.id, name: $('#a-name', body).value, kind: $('#a-kind', body).value, modelId: $('#a-model', body).value,
      instructions: $('#a-inst', body).value, tools }) });
    closeModal(); render();
  };
}

// ===================================================================
//  SKILLS
// ===================================================================
const SKILL_TEMPLATES = [
  { name: 'summarize', description: 'Condense text into tight bullets.', instructions: 'Summarize the input into 3-5 concise bullet points. Keep only what matters; no preamble.' },
  { name: 'proofread', description: 'Fix grammar & tighten prose.', instructions: 'Correct grammar, spelling and punctuation, and tighten wordy phrasing. Return only the corrected text.' },
  { name: 'code-review', description: 'Review code for bugs & style.', instructions: 'Review the provided code. List concrete issues (bugs, security, style) as a short bulleted list, then suggest the single most important fix.' },
  { name: 'translate-en', description: 'Translate anything to English.', instructions: 'Translate the input into natural, fluent English. Return only the translation.' },
  { name: 'extract-actions', description: 'Pull action items from notes.', instructions: 'Read the input and list every action item as "- [ ] owner: task". If no owner is stated, use "?".' },
  { name: 'email-draft', description: 'Draft a clear, polite email.', instructions: 'Write a clear, friendly, professional email accomplishing the requested goal. Include a subject line. Keep it concise.' },
  { name: 'explain-simply', description: 'Explain like I am five.', instructions: 'Explain the input topic in plain language a beginner can follow, using a short analogy. Avoid jargon.' },
  { name: 'blog-post', description: 'Write a structured blog post.', instructions: 'Write an engaging blog post on the topic: a hook, 3-4 sections with headings, and a short conclusion.' },
];

async function renderSkills(c) {
  const [skills, models] = await Promise.all([api('/skills'), api('/models')]);
  $('#topbar-actions').appendChild(el(`<button class="btn" id="browse-skills">✦ Browse templates</button>`));
  $('#topbar-actions').appendChild(el(`<button class="btn primary" id="add-skill">+ New skill</button>`));
  $('#add-skill').onclick = () => skillForm();
  $('#browse-skills').onclick = () => templatesModal(skills);
  c.innerHTML = '';
  c.appendChild(el(`<p class="muted small" style="margin:0 0 14px">A skill is a reusable instruction. Agents can run any skill via the <code>skill.run</code> tool, or test one here. New? Try <b>Browse templates</b>.</p>`));
  if (!skills.length) { c.appendChild(el('<div class="empty">No skills yet. Hit <b>Browse templates</b> for ready-made ones, or create your own.</div>')); return; }
  const grid = el('<div class="grid cols-2"></div>');
  skills.forEach((s) => grid.appendChild(el(`<div class="card">
    <div class="row"><h3>✦ ${esc(s.name)}</h3></div>
    <p class="muted small" style="margin:6px 0">${esc(s.description || 'No description')}</p>
    <p class="small" style="white-space:pre-wrap;color:var(--muted)">${esc((s.instructions || '').slice(0, 160))}${(s.instructions || '').length > 160 ? '…' : ''}</p>
    <div class="modal-foot" style="margin-top:12px"><button class="btn small ghost" data-edit="${s.id}">Edit</button><button class="btn small primary" data-test="${s.id}">Test run</button></div></div>`)));
  c.appendChild(grid);
  grid.onclick = (e) => {
    const ed = e.target.dataset.edit, test = e.target.dataset.test;
    if (ed) skillForm(skills.find((s) => s.id === ed));
    if (test) skillTestModal(skills.find((s) => s.id === test), models);
  };
}

function skillForm(s = {}) {
  const body = el(`<div>
    <label class="field">Name<input id="s-name" value="${esc(s.name || '')}" placeholder="e.g. summarize"></label>
    <label class="field">Description<input id="s-desc" value="${esc(s.description || '')}" placeholder="What this skill does"></label>
    <label class="field">Instructions<textarea id="s-inst" style="min-height:140px" placeholder="Tell the model exactly how to perform this skill on the input.">${esc(s.instructions || '')}</textarea></label>
    <div class="modal-foot">${s.id ? '<button class="btn danger" id="del">Delete</button>' : ''}<button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save</button></div></div>`);
  openModal(s.id ? 'Edit skill' : 'New skill', body);
  $('#cancel', body).onclick = closeModal;
  if (s.id) $('#del', body).onclick = async () => { await api(`/skills/${s.id}`, { method: 'DELETE' }); closeModal(); render(); };
  $('#save', body).onclick = async () => {
    await api('/skills', { method: 'POST', body: JSON.stringify({ id: s.id, name: $('#s-name', body).value, description: $('#s-desc', body).value, instructions: $('#s-inst', body).value }) });
    closeModal(); render();
  };
}

function templatesModal(existing = []) {
  const have = new Set(existing.map((s) => s.name?.toLowerCase()));
  const body = el(`<div><p class="muted small" style="margin-top:0">One-click ready-made skills. Install, then tweak any of them under New/Edit.</p><div class="list" id="tpl-list"></div>
    <div class="modal-foot"><button class="btn" id="cancel">Close</button></div></div>`);
  openModal('Skill templates', body);
  const list = $('#tpl-list', body);
  SKILL_TEMPLATES.forEach((t) => {
    const installed = have.has(t.name);
    const item = el(`<div class="list-item">
      <div class="meta"><b>✦ ${esc(t.name)}</b><span class="muted small">${esc(t.description)}</span></div>
      <button class="btn small ${installed ? 'ghost' : 'primary'}" data-tpl="${esc(t.name)}" ${installed ? 'disabled' : ''}>${installed ? 'installed' : 'Install'}</button></div>`);
    list.appendChild(item);
  });
  $('#cancel', body).onclick = closeModal;
  list.onclick = async (e) => {
    const name = e.target.dataset.tpl; if (!name) return;
    const t = SKILL_TEMPLATES.find((x) => x.name === name);
    e.target.disabled = true; e.target.textContent = 'installing…';
    try { await api('/skills', { method: 'POST', body: JSON.stringify(t) }); e.target.textContent = 'installed'; e.target.classList.replace('primary', 'ghost'); }
    catch { e.target.disabled = false; e.target.textContent = 'Install'; }
  };
}

function skillTestModal(s, models) {
  const body = el(`<div>
    <label class="field">Model<select id="t-model">${models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></label>
    <label class="field">Input<textarea id="t-input" style="min-height:90px" placeholder="Text to run the skill on…"></textarea></label>
    <div class="modal-foot"><button class="btn" id="cancel">Close</button><button class="btn primary" id="go">Run skill</button></div>
    <div id="t-out" class="run-trace" style="white-space:pre-wrap"></div></div>`);
  openModal(`Test: ${s.name}`, body);
  $('#cancel', body).onclick = closeModal;
  $('#go', body).onclick = async () => {
    const out = $('#t-out', body); out.innerHTML = '<span class="spinner"></span>';
    $('#go', body).disabled = true;
    try {
      const r = await api(`/skills/${s.id}/run`, { method: 'POST', body: JSON.stringify({ modelId: $('#t-model', body).value, input: $('#t-input', body).value }) });
      out.textContent = r.text || '(no output)';
    } catch (e) { out.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
    $('#go', body).disabled = false;
  };
}

// ===================================================================
//  HARNESSES
// ===================================================================
async function renderHarnesses(c) {
  const harnesses = await api('/harnesses');
  c.innerHTML = '';
  const grid = el('<div class="grid cols-3"></div>');
  harnesses.forEach((h) => {
    const on = h.status === 'installed';
    grid.appendChild(el(`<div class="card">
      <div class="row"><h3>${esc(h.name)}</h3><span class="pill ${on ? 'on' : ''}">${on ? 'installed' : 'available'}</span></div>
      <p class="muted small" style="margin:8px 0 12px">${esc(h.description)}</p>
      <div class="tag-row"><span class="pill accent">${esc(h.category)}</span><a class="pill" href="${esc(h.docs_url)}" target="_blank" style="text-decoration:none">docs ↗</a></div>
      <div class="modal-foot" style="margin-top:14px"><button class="btn small ${on ? 'ghost' : 'primary'}" data-install="${h.id}">${on ? 'Uninstall' : 'Install'}</button></div></div>`));
  });
  c.appendChild(grid);
  grid.onclick = async (e) => { const id = e.target.dataset.install; if (id) { await api(`/harnesses/${id}/install`, { method: 'POST' }); render(); } };
}

// ===================================================================
//  SETTINGS  (per-user provider API keys)
// ===================================================================
const KEY_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'One key for Claude, GPT, Gemini, GLM, Kimi and more. Recommended.', placeholder: 'sk-or-...' },
  { id: 'openai', label: 'OpenAI', hint: 'Direct OpenAI key (GPT models).', placeholder: 'sk-...' },
  { id: 'claude', label: 'Anthropic (Claude)', hint: 'Direct Anthropic key.', placeholder: 'sk-ant-...' },
  { id: 'gemini', label: 'Google Gemini', hint: 'Google AI Studio API key.', placeholder: 'AIza...' },
  { id: 'glm', label: 'GLM (Zhipu)', hint: 'Zhipu BigModel key.', placeholder: '...' },
  { id: 'kimi', label: 'Kimi (Moonshot)', hint: 'Moonshot API key.', placeholder: 'sk-...' },
  { id: 'xai', label: 'xAI (Grok)', hint: 'Direct xAI key for Grok models.', placeholder: 'xai-...' },
];

async function renderSettings(c) {
  const status = await api('/keys');
  c.innerHTML = '';
  c.appendChild(el(`<div class="card" style="margin-bottom:16px">
    <h3>Provider API keys</h3>
    <p class="muted small" style="margin:6px 0 0">Your keys are <b>encrypted at rest</b> and never shown again or sent back to the browser.
    A key you set here is used only for your account and overrides any server-wide key. Ollama needs no key.</p></div>`));
  const grid = el('<div class="grid cols-2"></div>');
  KEY_PROVIDERS.forEach((p) => {
    const on = !!status[p.id];
    const card = el(`<div class="card">
      <div class="row"><h3>${icon(p.id)} ${esc(p.label)}</h3><span class="pill ${on ? 'on' : ''}">${on ? 'key set' : 'not set'}</span></div>
      <p class="muted small" style="margin:6px 0 10px">${esc(p.hint)}</p>
      <div style="display:flex;gap:8px"><input type="password" id="k-${p.id}" placeholder="${on ? '•••••••• (set) — paste to replace' : esc(p.placeholder)}">
        <button class="btn primary small" data-save="${p.id}">Save</button>${on ? `<button class="btn small danger" data-clear="${p.id}">Clear</button>` : ''}</div>
      <p class="small" data-msg="${p.id}" style="margin:8px 0 0;min-height:14px"></p></div>`);
    grid.appendChild(card);
  });
  c.appendChild(grid);
  grid.onclick = async (e) => {
    const save = e.target.dataset.save, clear = e.target.dataset.clear;
    if (save) {
      const val = $(`#k-${save}`, grid).value.trim(), msg = $(`[data-msg="${save}"]`, grid);
      if (!val) { msg.style.color = 'var(--danger)'; msg.textContent = 'Paste a key first.'; return; }
      msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…';
      try { await api('/keys', { method: 'POST', body: JSON.stringify({ provider: save, key: val }) }); bootDots(); render(); }
      catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err.message; }
    }
    if (clear) { await api(`/keys/${clear}`, { method: 'DELETE' }); bootDots(); render(); }
  };

  // --- Custom / other providers (any OpenAI-compatible API) ---
  const custom = await api('/keys/custom').catch(() => []);
  const ccard = el(`<div class="card" style="margin-top:16px">
    <h3>🔧 Custom providers</h3>
    <p class="muted small" style="margin:6px 0 12px">Use any OpenAI-compatible API (DeepSeek, Groq, Mistral, a local server…). Add a key here under a short <b>name</b>, then create a model with provider <b>custom</b>, that same <b>key name</b>, and the provider's <b>Base URL</b>.</p>
    <div class="tag-row" id="custom-keys" style="margin-bottom:12px"></div>
    <div style="display:flex;gap:8px">
      <input id="ck-name" placeholder="key name (e.g. deepseek)" style="max-width:200px">
      <input id="ck-val" type="password" placeholder="API key" style="flex:1">
      <button class="btn primary small" id="ck-save">Add</button>
    </div>
    <p class="small" id="ck-msg" style="margin:8px 0 0;min-height:14px"></p></div>`);
  c.appendChild(ccard);
  const ckList = $('#custom-keys', ccard);
  if (!custom.length) ckList.appendChild(el('<span class="muted small">No custom keys yet.</span>'));
  else custom.forEach((name) => ckList.appendChild(el(`<span class="pill on">${esc(name)} <a href="#" data-ckdel="${esc(name)}" style="color:var(--danger);text-decoration:none;margin-left:4px">✕</a></span>`)));
  ckList.onclick = async (e) => { e.preventDefault(); const n = e.target.dataset.ckdel; if (n) { await api(`/keys/${encodeURIComponent(n)}`, { method: 'DELETE' }); render(); } };
  $('#ck-save', ccard).onclick = async () => {
    const name = $('#ck-name', ccard).value.trim().toLowerCase(), val = $('#ck-val', ccard).value.trim(), msg = $('#ck-msg', ccard);
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) { msg.style.color = 'var(--danger)'; msg.textContent = 'Name: letters/numbers/-/_ only.'; return; }
    if (!val) { msg.style.color = 'var(--danger)'; msg.textContent = 'Paste a key.'; return; }
    try { await api('/keys', { method: 'POST', body: JSON.stringify({ provider: name, key: val }) }); render(); }
    catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = err.message; }
  };

  // --- Approvals: tools you've chosen to auto-approve ---
  const appr = await api('/approvals').catch(() => ({ tools: [], gated: [] }));
  const card = el(`<div class="card" style="margin-top:18px">
    <h3>🔐 Agent approvals</h3>
    <p class="muted small" style="margin:6px 0 12px">These tools pause for your OK when an agent uses them: ${(appr.gated || []).map((t) => `<code>${esc(t)}</code>`).join(' ') || 'none'}.
    Tools you chose <b>"Approve every time"</b> run without asking — revoke them here.</p>
    <div class="tag-row" id="auto-list"></div></div>`);
  c.appendChild(card);
  const list = $('#auto-list', card);
  if (!appr.tools?.length) list.appendChild(el('<span class="muted small">Nothing is auto-approved yet.</span>'));
  else appr.tools.forEach((t) => list.appendChild(el(`<span class="pill on">${esc(t)} <a href="#" data-revoke="${esc(t)}" style="color:var(--danger);text-decoration:none;margin-left:4px">✕</a></span>`)));
  list.onclick = async (e) => {
    e.preventDefault();
    const t = e.target.dataset.revoke; if (!t) return;
    await api(`/approvals/${encodeURIComponent(t)}`, { method: 'DELETE' }); render();
  };
}

// ===================================================================
//  provider dots + boot
// ===================================================================
async function bootDots() {
  try {
    const s = await api('/status');
    $('#provider-dots').innerHTML = Object.entries(s.providers).map(([p, on]) => `<span class="dot ${on ? 'on' : ''}">${p}</span>`).join('');
  } catch {}
}

wireAuth();
boot();
// orbital v0.3 — agents with real tools + skills
