# 🛰 Orbital

> **One workbench for every AI you use.** Chat with Claude, ChatGPT, Gemini, GLM, Kimi
> and local models side by side, give them a shared memory and real tools, and run it
> all on your own server.

A fresh, beginner-friendly **multi-LLM workbench**. Many models, agents and harnesses
orbiting one shared memory. Each model has its own settings, every model can read and
add to a common memory, and agents can take real actions (with your approval). Backed
by **Supabase** (Postgres + Auth + Storage) and deployable on **Coolify** or any Docker host.

**Self-hosted · open source · bring-your-own-keys.**

📖 New here? Jump to the **[beginner setup guide](GETTING-STARTED.md)** — it's click-by-click.
&nbsp;·&nbsp; Comfortable with Docker? See [Run locally](#3-run-locally-optional) and [Deploy on Coolify](#2-deploy-on-coolify).

- 🔐 **Auth** — each user signs in and gets their own isolated models, memory and files.
- 🧠 **Shared + private memory** — every model reads the combined memory and can add to it.
- 🗂 **Combined + separate files** — one shared tree plus a private tree per model, with real file uploads to Supabase Storage.
- ⚡ **Streaming chat with saved history** — replies stream in token-by-token, every conversation is saved, and you can reopen or **search** past chats.
- 🔑 **Per-user keys** — each user can paste their own provider API keys in **Settings**; stored AES-256-GCM encrypted, never returned to the browser, and override any server key.
- 🤖 **Agents that really act** — a ReAct loop where the agent calls real tools (`memory.write/search`, `files.read/write/list`, `web.fetch`, `skill.run`), the server executes them, and the trace streams live step-by-step.
- ✦ **Skills** — author reusable named instructions; agents invoke them with `skill.run`, or test-run them yourself.
- 🔌 **Harnesses** — OpenRouter, Ollama, NotebookLM, LangChain — install with one click.
- 🛰 **Providers** — OpenRouter (one key, most models), Ollama (local), or direct Claude/OpenAI/Gemini/GLM/Kimi keys.

> Without provider keys, models reply in clearly-labelled **demo mode**, so you can log in
> and click around immediately. Add an OpenRouter key for real responses.

## Tech stack

Deliberately lightweight and easy to read — **no build step, no framework lock-in.**

- **Backend:** Node.js + Express (ES modules). One small dependency tree.
- **Frontend:** plain HTML + CSS + vanilla JavaScript — no React, no bundler, no compile.
- **Data & auth:** Supabase (Postgres, Auth, Storage) via `@supabase/supabase-js`.
- **LLM access:** OpenRouter, Ollama, or direct provider APIs through one unified adapter.
- **Agents:** a provider-agnostic ReAct loop with real tools and human-in-the-loop approvals.
- **Deploy:** a single `Dockerfile` — runs on Coolify or any Docker host.

---

## 1. Set up Supabase (5 minutes)

You can use Supabase Cloud or your own self-hosted Supabase (e.g. the one-click
Supabase service in Coolify). Either works the same.

1. Create a Supabase project (or open your self-hosted one).
2. Go to **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates the tables (including the encrypted `provider_keys` table), row-level-security policies, and the `orbital-files` storage bucket. The script is idempotent — re-run it any time you pull an update.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret!)
4. (Optional) Under **Authentication → Providers → Email**, turn **off** "Confirm email" while testing so you can sign in instantly. Leave it on for production.

---

## 2. Deploy on Coolify

1. Push this folder to a Git repo (GitHub/GitLab), or use Coolify's "Docker" source.
2. In Coolify: **New Resource → Application →** your repo.
3. Build pack: **Dockerfile** (this project ships one — Coolify detects it automatically).
4. **Port:** `4173`.
5. **Environment variables** (Coolify → your app → Environment):
   ```
   SUPABASE_URL=...
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ORBITAL_SECRET=some-long-random-string   # encrypts users' provider keys at rest
   OPENROUTER_API_KEY=...        # optional server-wide key (users can also bring their own)
   OLLAMA_BASE_URL=http://host.docker.internal:11434   # optional
   ```
6. **Deploy.** Coolify builds the image, runs the healthcheck at `/api/health`, and gives you a URL. Open it, create an account, and you're in.

> **Tip:** if your Ollama runs on the same VPS, set `OLLAMA_BASE_URL` to the host's
> reachable address from inside the container (often `http://host.docker.internal:11434`
> or your server's LAN IP).

---

## 3. Run locally (optional)

Needs [Node.js 18+](https://nodejs.org).

```bash
cd orbital
npm install
cp .env.example .env     # fill in your SUPABASE_* values
npm start                # → http://localhost:4173
```

---

## How it fits together

```
Browser (public/)                Server (server/)                 Supabase
─────────────────                ─────────────────                ────────
supabase-js  ── login ─────────────────────────────────────────▶  Auth
   │  (gets JWT)
   └─ fetch /api/* with Bearer JWT ─▶ verify token ─▶ db.js ─────▶  Postgres
                                       providers.js ─▶ LLM APIs      Storage
```

- The browser does **auth** directly with Supabase (anon key).
- Every API call carries the user's JWT; the server verifies it and uses the
  **service-role** key to read/write only that user's rows (RLS is on as a backstop).
- **Provider API keys live only on the server** — never sent to the browser.

### Project layout
```
orbital/
├─ server/
│  ├─ index.js        Express app, auth gate, REST API
│  ├─ supabase.js     Supabase admin client + token verify
│  ├─ db.js           All data access, scoped per user + default seeding
│  ├─ providers.js    Unified chat()/chatStream() for every LLM provider
│  ├─ tools.js        Real executable tools (memory, files, web.fetch, skill.run)
│  ├─ runtime.js      Agent ReAct loop + skill execution
│  └─ util.js         env loader + AES key encryption
├─ supabase/schema.sql  Run once in Supabase
├─ public/            Dashboard UI (index.html, styles.css, app.js)
├─ Dockerfile         Coolify build
├─ .env.example
└─ package.json
```

---

## API

```
GET  /api/health                  { ok, supabase }            (public)
GET  /api/config                  { url, anonKey, configured } (public)
-- all below require Authorization: Bearer <supabase access token> --
GET  /api/status                  providers + counts (also seeds new users)
GET/POST/DELETE /api/models
POST /api/chat                    { modelId, messages }
POST /api/chat/stream             { modelId, messages }  → SSE token stream
POST /api/chat/broadcast          { modelIds[], message }
GET  /api/keys                    which providers have a user key (booleans)
POST /api/keys                    { provider, key }       (encrypted, write-only)
DELETE /api/keys/:provider
GET/POST/DELETE /api/memory
GET/POST/DELETE /api/files
POST /api/files/upload            { scope, filename, contentType, base64 }
GET  /api/files/:id/url           signed download URL
GET/POST/DELETE /api/agents
POST /api/agents/:id/run          { task }  → SSE trace (+ approval_request events)
POST /api/agents/approve          { runId, reqId, decision: once|always|deny }
GET  /api/approvals               { tools:[auto-approved], gated:[needs approval] }
DELETE /api/approvals/:tool       revoke an auto-approval
GET  /api/tools                   built-in tool names
GET/POST/DELETE /api/skills
POST /api/skills/:id/run          { modelId, input }  test a skill
GET  /api/harnesses · POST /api/harnesses/:id/install
```

---

## How agents work

When you run an agent, the server starts a **ReAct loop**: the model is asked to
reply with one JSON action per turn (`{"action":"files.write","action_input":{…}}`),
the server **executes the real tool**, feeds the result back as an observation, and
loops until the model returns a `final` answer (max 8 steps). Every step streams to
the UI so you can watch it think and act. Built-in tools:

- `memory.write` / `memory.search` — read & write the shared/private memory.
- `files.list` / `files.read` / `files.write` — work in the combined or per-model trees.
- `web.fetch` — fetch a public URL's readable text (8s timeout, http/https only).
- `skill.run` — run one of your saved **Skills** by name.

### Approvals (human in the loop)

Tools that change state or hit the network — `memory.write`, `files.write`,
`web.fetch` — **pause the run and ask you first**. The live trace shows the exact
tool and arguments with three buttons:

- **Approve once** — run it this one time.
- **Approve every time** — run it now and auto-approve this tool from now on (remembered in the `auto_approvals` table). Manage/revoke these under **Settings → Agent approvals**.
- **Deny** — skip it; the agent is told and continues or finishes.

Read-only tools (`files.read`, `files.list`, `memory.search`, `skill.run`) never
prompt. A request times out as a deny after 3 minutes.

> **Security note:** `web.fetch` lets an agent request arbitrary URLs from the
> server. On a private VPS this is usually fine; if you expose Orbital publicly,
> consider restricting outbound network access or removing `web.fetch` from agents.

## Roadmap

Done, and what's next. Contributions welcome.

**Shipped**
- ✅ Multi-provider chat (OpenRouter, Ollama, direct) with a unified adapter
- ✅ Supabase auth, per-user data isolation (RLS), Storage uploads
- ✅ Per-user encrypted provider keys
- ✅ Streaming responses + saved, searchable chat history
- ✅ Shared + private memory; combined + per-model file trees
- ✅ Agents with a real tool loop and human-in-the-loop approvals
- ✅ User-authored skills

**Planned**
- ⬜ Native function-calling for providers that support it (instead of the JSON loop)
- ⬜ Nested tool use *inside* skills
- ⬜ Wire NotebookLM / LangChain harnesses to live SDKs
- ⬜ Per-agent "autonomous mode" (trusted agents skip approval)
- ⬜ Conversation export (Markdown / JSON)
- ⬜ Optional SMTP for real email confirmation

## License

MIT. Built to be hacked on — PRs and forks welcome.
