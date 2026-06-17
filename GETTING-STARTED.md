# 🛰 Orbital — Beginner Setup Guide

A complete, click-by-click walkthrough. No prior experience needed.
You'll go from "files on my PC" → "Orbital live on my own server."

**What you'll do (about 30–45 minutes):**

1. Put the Orbital code on GitHub
2. Install Supabase on your Coolify
3. Grab your 3 Supabase keys
4. Create the database tables
5. Make your first login work instantly
6. Deploy the Orbital app on Coolify
7. Log in and add an AI key
8. Test it

You only need three browser tabs: **GitHub**, your **Coolify**, and (later) your **Supabase Studio**.

---

## ⚠️ One rule before you start

**Never upload the file named `.env`** (if you ever create one). It holds secrets.
Good news: the project already has a `.gitignore` that hides it, and right now you
only have `.env.example` (a safe template), so you're fine. Also skip the
`node_modules` folder if you ever see one — it's huge and not needed.

---

# Part 1 — Put Orbital on GitHub

Pick **one** of the three options. Option A (browser) is the one you chose; B and C are here for reference.

### First: make a GitHub account + empty repo

1. Go to **https://github.com** and sign up / log in.
2. Click the **+** in the top-right → **New repository**.
3. **Repository name:** `orbital`
4. Set it to **Public** (simplest — the code contains *no secrets*). *(Private also works; see the note at the end of Part 6.)*
5. **Do not** check "Add a README" (your folder already has one).
6. Click **Create repository**. Leave this page open — it shows upload instructions.

---

### Option A — Browser upload (drag & drop) ✅ your choice

1. On your new empty repo page, click the link **"uploading an existing file"**
   (it's in the middle of the page). Or go to `https://github.com/<your-username>/orbital/upload/main`.
2. Open your **orbital** folder on your PC in File Explorer.
3. **Select everything inside it** (Ctrl+A) — the `server`, `public`, `supabase`
   folders and the loose files like `package.json`, `README.md`, `Dockerfile`.
   *(If you see a `node_modules` folder, do NOT include it.)*
4. **Drag them onto the GitHub upload page.** Chrome/Edge will upload folders too.
5. Wait for the file list to fill in. Scroll down, and in **"Commit changes"** type
   `first upload`, then click **Commit changes**.
6. Done — refresh the repo page and you should see your folders. ✅

> **Tip:** if drag-and-drop misses the subfolders, upload in two passes: first the
> loose files, then click **Add file → Upload files** again and drag the `server`,
> `public`, and `supabase` folders one at a time.

---

### Option B — GitHub Desktop (no command line)

1. Download and install **GitHub Desktop**: https://desktop.github.com
2. Open it, click **Sign in to GitHub.com**, and authorize.
3. Menu **File → Add local repository** → choose your **orbital** folder.
   It'll say "this isn't a git repository — create one?" → click **create a repository**.
4. It auto-detects the `.gitignore` (keep it). Click **Create repository**.
5. In the left panel you'll see all the files staged. At the bottom-left type a
   summary like `first upload` → click **Commit to main**.
6. Top bar: click **Publish repository**. Untick "Keep this code private" if you
   want it public. Click **Publish repository**. ✅

To send updates later: make your changes, then **Commit to main** → **Push origin**.

---

### Option C — Git command line

Install Git first: https://git-scm.com/downloads

```bash
cd path/to/orbital            # the folder with package.json
git init
git add .
git commit -m "first upload"
git branch -M main
git remote add origin https://github.com/<your-username>/orbital.git
git push -u origin main
```

If it asks you to log in, follow the browser prompt. ✅

---

# Part 2 — Install Supabase on your Coolify

Supabase is your database + login system. You'll run it on your own server.

1. Open your **Coolify** dashboard in a browser.
2. Pick (or create) a **Project**, then choose a **Server** and an **Environment**
   (the default is fine).
3. Click **+ New** / **New Resource** → **Service**.
4. In the search box type **Supabase** and select it.
5. Click **Deploy / Create**. Coolify will pull several containers (database, auth,
   API gateway, studio…). This takes a few minutes — let it finish.
6. When it's done, Coolify shows the Supabase service with a few **URLs/domains**
   (one for the **API**, one for **Studio** — the dashboard).

> **Important:** give the Supabase **API** a real domain (Coolify lets you set one,
> e.g. `https://supabase-api.yourdomain.com`). Your browser talks to this directly,
> so it must be publicly reachable over **https** — not an internal address.

---

# Part 3 — Get your two Supabase keys

On your Supabase **service** page in Coolify, open the **Environment Variables** tab
and use the search box. Copy the **values** of these two variables:

| You need | Search for this variable | Looks like |
|----------|--------------------------|------------|
| `SUPABASE_ANON_KEY` | **`SERVICE_SUPABASEANON_KEY`** | a long `eyJ...` token |
| `SUPABASE_SERVICE_ROLE_KEY` | **`SERVICE_SUPABASESERVICE_KEY`** | a long `eyJ...` token |

> **Gotcha:** the variables literally *named* `SUPABASE_ANON_KEY` /
> `SUPABASE_SERVICE_ROLE_KEY` may just show a placeholder like
> `${SERVICE_SUPABASEANON_KEY}` — that's a reference, not the real value. Always copy
> from the **`SERVICE_SUPABASE…`** variables above, which hold the actual tokens.
> (Both keys start with the same `eyJ...` header — that's normal; they really are different.)

The **third value, your `SUPABASE_URL`, is set up in Part 3.5** so it's secure (https).

> The **service role key is a master key — keep it secret.** Orbital only uses it on
> the server; it never reaches the browser.

---

# Part 3.5 — Give Supabase a secure (https) address

Coolify's default Supabase URL (`SERVICE_URL_SUPABASEKONG`) is an **http**
`sslip.io` address. That won't work from a browser, because a secure (https) Orbital
page is not allowed to call an insecure (http) one. So point a domain at it with SSL.

**You need a domain name** (e.g. `yourname.com`). No domain? See the "no-domain
fallback" note at the bottom of this part.

1. **Add a DNS record** at your domain provider (Cloudflare, GoDaddy, etc.):
   - Type **A**, Name **`supabase`** (→ `supabase.yourname.com`), value = **your VPS IP**.
   - On **Cloudflare**, set the record's proxy to **DNS only (grey cloud)** — Coolify
     needs this to issue its SSL certificate. (Do the same for your `orbital` record.)
2. In Coolify, open the Supabase service → find the **Kong / API** sub-service → its
   **Domains** field → enter `https://supabase.yourname.com` → **Save**.
3. **Redeploy** the Supabase service. Coolify auto-issues a free Let's Encrypt SSL cert.
4. Your **`SUPABASE_URL`** is now `https://supabase.yourname.com`. Test it: open that
   URL in a browser — you should get a small JSON message, served over https. ✅

> **No-domain fallback (testing only):** skip the domain and use the default
> `http://...sslip.io` URL as your `SUPABASE_URL` — **but** then you must also run the
> Orbital app over plain http (Part 6), so the browser doesn't block the mix. It works
> for a quick try, but it's unencrypted. Add a domain before real use.

---

# Part 4 — Create the database tables

First, open the **Supabase Studio** dashboard:

1. In Coolify, on the Supabase service's **Environment Variables** tab, copy the
   dashboard **username** and **password** — `SERVICE_USER_SUPABASE` and
   `SERVICE_PASSWORD_SUPABASE`.
2. Go to the service's **General** tab and **scroll down to the Services list**, click
   **Supabase Studio → Settings → Links**, and **click the link** to open Studio.
   Log in with the username/password from step 1 if asked.

Then create the tables:

1. In Studio's left sidebar click **SQL Editor** → **New query**.
2. On your PC, open **`supabase/schema.sql`** from the Orbital folder (any text
   editor — Notepad works). Select all (Ctrl+A), copy (Ctrl+C).
3. Paste it into the SQL editor and click **Run** (or press Ctrl+Enter).
4. You should see "Success". This created all the tables, security rules, and the
   file-storage bucket. ✅ *(It's safe to re-run later when you update Orbital.)*

---

# Part 5 — Make your first login instant (skip email confirmation)

Self-hosted Supabase can't send confirmation emails until you set up an email
service. So for now, let new sign-ups log in immediately:

1. In Coolify, open your **Supabase service → Environment Variables**.
2. Find or add **`ENABLE_EMAIL_AUTOCONFIRM`** and set it to **`true`**.
   *(If you don't see it, add a new variable with that name and value `true`.)*
3. **Redeploy** the Supabase service so it takes effect.

> Later, when you want real email confirmations, set up SMTP in Supabase and flip
> this back to `false`.

---

# Part 6 — Deploy the Orbital app on Coolify

Now the app itself.

1. In Coolify: **+ New / New Resource** → **Application**.
2. **Source:** choose **Public Repository** and paste your repo URL:
   `https://github.com/<your-username>/orbital` → Continue.
   *(Private repo? Use "GitHub App" / connect GitHub instead — see note below.)*
3. **Branch:** `main`.
4. **Build Pack:** choose **Dockerfile**. *(Orbital ships one; Coolify usually
   detects it automatically.)*
5. **Port / Ports Exposes:** set to **`4173`**.
6. Open the **Environment Variables** tab and add these (paste your real values
   from Part 3):

   ```
   SUPABASE_URL=https://supabase-api.yourdomain.com
   SUPABASE_ANON_KEY=eyJ...your anon key...
   SUPABASE_SERVICE_ROLE_KEY=eyJ...your service role key...
   ORBITAL_SECRET=pick-any-long-random-text-here-12345
   PORT=4173
   ```

   Optional (you can add later, from inside the app too):
   ```
   OPENROUTER_API_KEY=sk-or-...   # one key for Claude, GPT, Gemini, GLM, Kimi
   ```
7. Set a **Domain** for the app (e.g. `https://orbital.yourdomain.com`).
8. Click **Deploy**. Watch the logs — when it says it's running and the health
   check passes, you're live. ✅

> **Private repo note:** if you made the repo private, in step 2 pick **GitHub App**,
> click **Connect to GitHub**, install Coolify's app on your account, then select
> your `orbital` repo. Everything else is the same.

---

# Part 7 — First login + add an AI key

1. Open your app's domain (e.g. `https://orbital.yourdomain.com`).
2. You'll see the Orbital sign-in screen. Click **"Create one"**, enter an email +
   password, and submit. Thanks to Part 5 you're taken straight in.
3. Your workspace auto-fills with default models, agents, skills and memory. 🎉
4. Go to **Settings** (left sidebar) and paste an **OpenRouter** key (the easiest —
   one key unlocks Claude, GPT, Gemini, GLM, Kimi). Get one at
   https://openrouter.ai → **Keys**. Click **Save**.
   *(No key yet? Everything still works in clearly-labelled "demo mode.")*

---

# Part 8 — Test everything

- **Chat:** open **Chat**, pick a model, say hi — the reply should stream in.
- **Broadcast:** switch to **Broadcast**, ask all models one question, compare.
- **Memory:** add a note in **Memory** — every model can now use it.
- **Files:** create or upload a file in **Files**.
- **Agents:** open **Agents → Run** on "OpenClaw", give it a task like
  *"write a file called notes/test.md saying hello"*. When it tries to write,
  you'll get the **Approve once / Approve every time / Deny** buttons. Approve and
  watch it work.
- **Skills:** open **Skills**, hit **Test run** on "summarize" with some text.

---

# Troubleshooting

**The app loads but says "needs Supabase."**
→ One of the three `SUPABASE_*` env vars is missing or has a typo. Re-check Part 6,
then redeploy the app.

**I can sign up but can't log in / "email not confirmed."**
→ Do Part 5 (`ENABLE_EMAIL_AUTOCONFIRM=true`) and redeploy Supabase. Then sign up
again with a fresh email.

**Login screen never appears / network errors in the browser.**
→ `SUPABASE_URL` must be the **public https** API domain (Part 3), not an internal
docker address. The browser needs to reach it directly.

**Models reply with "🛰️ demo …".**
→ That just means no API key yet. Add an OpenRouter key in **Settings** (Part 7).

**Agent does nothing / stops fast.**
→ Demo mode can't run the tool loop. Add a real key, then run the agent again.

**Coolify build fails.**
→ Make sure **Build Pack = Dockerfile** and **Port = 4173**. Check the deploy logs
for the first red error line.

---

That's it — you're running your own multi-LLM workbench. 🛰
When you change the code later, just push/upload to GitHub again and hit
**Redeploy** in Coolify.
