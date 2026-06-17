# 🚀 Launch kit — getting Orbital noticed

Practical, no-fluff. Do the repo setup first (5 min), then post.

---

## 1. Repo setup (do these in GitHub first)

These are the things people subconsciously check before starring:

- [ ] **Description** (top of repo, the gear icon): paste this one-liner →
  `One self-hosted workbench for every AI — chat, agents, shared memory & tools across Claude, GPT, Gemini, Grok, GLM, Kimi and local models.`
- [ ] **Website**: your live demo URL (e.g. `https://orbital.furzehills.com`) if you're happy to share it.
- [ ] **Topics** (tags): add these so it shows up in searches →
  `self-hosted`, `llm`, `ai`, `agents`, `openrouter`, `supabase`, `coolify`, `multi-llm`, `chatgpt`, `claude`, `ollama`, `nodejs`, `ai-agents`, `function-calling`
- [ ] **Social preview image** (Settings → General → Social preview): upload a 1280×640 banner — this is what shows when the link is shared. Even a simple dark banner with the 🛰 logo + tagline massively boosts click-through.
- [ ] **Screenshots/GIF** in the README (see the Screenshots section there). A 10-second GIF of a broadcast + an agent building a file is worth more than any paragraph.
- [ ] **LICENSE** ✅ already added (MIT).
- [ ] Pin the repo to your GitHub profile.

---

## 2. Where to post (highest signal first)

- **Hacker News — "Show HN"** (news.ycombinator.com/submit). Best single shot. Post Tue–Thu, ~8–10am US Eastern. Reply to every comment for the first few hours.
- **Reddit**: r/selfhosted (huge for this), r/LocalLLaMA (the local-model crowd), r/opensource, r/SideProject. Read each sub's self-promo rules first; lead with value, not "please star".
- **Coolify**: their Discord #showcase and the Coolify subreddit — you deployed on Coolify, that's a natural fit.
- **X/Twitter**: thread with a GIF; tag @OpenRouterAI, @supabase, @coolifyio — they often reshare projects built on them.
- **Awesome lists**: open a PR adding Orbital to `awesome-selfhosted`, `awesome-llm`, and OpenRouter's "Awesome OpenRouter" page.
- **Product Hunt**: optional, better once you have screenshots + a few users.
- **Lobste.rs** (if you have an invite), and the Supabase Discord #showcase.

---

## 3. Draft posts (edit to taste)

### Show HN
**Title:** `Show HN: Orbital – self-hosted workbench for every AI (agents, shared memory, tools)`

> I wanted one place to use Claude, GPT, Gemini, Grok, GLM, Kimi and local models together — with a shared memory they can all read and write, agents that actually take actions (create files, search memory, fetch the web) with my approval, and saved/searchable chat history. So I built Orbital.
>
> It's self-hosted: Node + a plain HTML/JS frontend (no build step), Supabase for auth/data/storage, one Dockerfile, deploys on Coolify or any Docker host. Bring your own keys — a single OpenRouter key covers most models, or add direct keys / any OpenAI-compatible endpoint.
>
> Agents use native function-calling where the provider supports it, run in the background (close the tab, they keep going), can delegate to other models/agents, and pause for your approval before anything destructive. There's also AI image generation and a live preview for files an agent builds.
>
> Repo: <link> · Demo: <link>
>
> It's a research-preview-quality side project, not a polished product — feedback and PRs very welcome. Happy to answer anything about the architecture.

### Reddit (r/selfhosted)
**Title:** `Orbital: a self-hosted multi-LLM workbench (Supabase + Coolify, bring-your-own-keys)`

> Built a self-hosted app to use all my AI subscriptions in one place. Chat with any model or broadcast to several at once, a shared memory every model can use, agents that take real actions (with approval) and run in the background, saved/searchable history, AI image gen, and a files preview.
>
> Stack: Node/Express + vanilla JS, Supabase (Postgres/Auth/Storage), single Dockerfile, one-click-ish on Coolify. No telemetry, your keys stay on your server.
>
> GitHub: <link>. Would love feedback from this crowd — especially on the agent/approval model.

### X/Twitter (thread starter)
> 🛰 Orbital — one self-hosted workbench for *every* AI.
>
> Chat or broadcast across Claude · GPT · Gemini · Grok · GLM · Kimi · local. Shared memory, background agents with real tools + approvals, image gen, saved history.
>
> Node + @supabase, one Dockerfile, runs on @coolifyio. Bring your own keys (@OpenRouterAI covers most).
>
> [GIF] · repo 👇

---

## 4. After you post
- Reply to comments fast — engagement drives ranking everywhere.
- Add a **"good first issue"** label to 2–3 small tasks so contributors have a way in.
- Put the demo link + a GIF at the very top of the README.
- A short **CONTRIBUTING.md** lowers the bar for PRs.

Good luck. 🛰
