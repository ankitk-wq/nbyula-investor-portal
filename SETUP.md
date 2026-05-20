# Nbyula Investor Portal — Setup Guide

A password-protected, collaboratively-editable investor portal.
Same architecture as **OPS Graph**: a **public shell** (zero financials) +
an **AES-256 encrypted snapshot** that only unlocks with a password. You and
your founder edit it live; saves merge section-by-section so you don't clobber
each other.

```
┌─────────────┐   loads    ┌──────────────────────┐
│ GitHub Pages│──shell────▶│  Browser (you/founder)│
│  /docs      │──snapshot─▶│  decrypts w/ password │
└─────────────┘            └──────────┬───────────┘
       ▲                              │ edits + save
       │ commits docs/                ▼
       │                   ┌──────────────────────┐
       └───────────────────│ Cloudflare Worker    │
            re-encrypts &  │ nbyula-investor-api  │
            commits        │ (auth + encrypt +    │
                           │  commit to GitHub)   │
                           └──────────────────────┘
```

- **Public shell** = `docs/index.html` + `docs/data/snapshot.meta.json`.
  Contains **no** financials, so the repo can be **public** (free Pages).
- **Encrypted content** = `docs/data/snapshot.enc`. The real numbers live ONLY
  here, encrypted with `VIEWER_PASSWORD`.
- **Worker** = auth + re-encrypt-on-save + commit back to GitHub. Holds all
  secrets; the browser never sees the GitHub token.

---

## What you need

- The `ankitk-wq` GitHub account.
- The same Cloudflare account you used for OPS Graph.
- `git`, `python3`, and `openssl` on your laptop (all preinstalled on macOS).
- ~15 minutes.

---

## Step 1 — Create the GitHub repo

1. Go to <https://github.com/new> (logged in as `ankitk-wq`).
2. **Repository name:** `nbyula-investor-portal`
3. Visibility: **Public** is fine (the committed files leak nothing). Private
   also works.
4. Do **not** add a README/.gitignore/license (this repo already has them).
5. Click **Create repository**.

---

## Step 2 — Push this project

From this folder (`investor-portal/`):

```sh
git remote add origin https://github.com/ankitk-wq/nbyula-investor-portal.git
git branch -M main
git push -u origin main
```

> The local commit is already made for you. `src/`, `build/seed.json`, and the
> password files are git-ignored, so plaintext financials never leave your
> laptop.

---

## Step 3 — Enable GitHub Pages

1. Repo → **Settings** → **Pages**.
2. **Source:** *Deploy from a branch*.
3. **Branch:** `main`, folder **`/docs`**. Save.
4. Wait ~30s. Your site is at:

   **https://ankitk-wq.github.io/nbyula-investor-portal/**

At this point the page loads but shows a password gate and "no worker
configured" — that's expected until Step 6.

---

## Step 4 — Create a GitHub token for the Worker

The Worker commits the encrypted snapshot back to the repo, so it needs write
access.

1. <https://github.com/settings/tokens?type=beta> → **Generate new token**
   (fine-grained).
2. **Resource owner:** `ankitk-wq`.
3. **Repository access:** *Only select repositories* → `nbyula-investor-portal`.
4. **Permissions:** *Repository permissions* → **Contents: Read and write**.
5. Generate, **copy the token** (`github_pat_…`). You'll paste it in Step 5.

---

## Step 5 — Create the Cloudflare Worker

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. **Name:** `nbyula-investor-api`. Deploy the default, then **Edit code**.
3. Delete the boilerplate. Open `worker/worker.js` from this project, copy its
   **entire** contents, paste into the editor, **Deploy**.
4. Copy your Worker URL — it looks like
   `https://nbyula-investor-api.<your-subdomain>.workers.dev`.

### Set the Worker secrets

Worker → **Settings** → **Variables and Secrets** → add each as an
**encrypted secret**:

| Name              | Value                                                             |
|-------------------|-------------------------------------------------------------------|
| `EDITOR_PASSWORD` | passphrase that unlocks **editing** (give to you + founder)        |
| `VIEWER_PASSWORD` | passphrase for **read-only** viewing **and** snapshot encryption¹  |
| `JWT_SECRET`      | any random 32+ char string (e.g. `openssl rand -hex 32`)          |
| `GITHUB_TOKEN`    | the `github_pat_…` from Step 4                                    |
| `GITHUB_REPO`     | `ankitk-wq/nbyula-investor-portal`                                |
| `ALLOWED_ORIGIN`  | `https://ankitk-wq.github.io`                                     |

> ¹ **Critical:** `VIEWER_PASSWORD` must be **byte-for-byte identical** to the
> contents of `publish/.publish-password` (Step 6). The publish script encrypts
> the snapshot with that password and the Worker/browser decrypt with it — if
> they differ, decryption fails.

Click **Deploy** after adding secrets.

---

## Step 6 — Wire the Worker URL + password into the build

On your laptop, in `investor-portal/`:

```sh
# 1. Tell the build where the Worker lives
printf 'https://nbyula-investor-api.<your-subdomain>.workers.dev' > publish/.worker-config

# 2. Set the snapshot password == the Worker's VIEWER_PASSWORD
printf 'your-viewer-password' > publish/.publish-password
chmod 600 publish/.publish-password
```

Replace `<your-subdomain>` and `your-viewer-password` with your real values.

---

## Step 7 — Publish

```sh
./publish/publish.sh
```

This rebuilds the shell, re-encrypts the content with `VIEWER_PASSWORD`, writes
`docs/data/snapshot.enc` + metadata, commits `docs/`, and pushes. GitHub Pages
updates in ~30s.

Open **https://ankitk-wq.github.io/nbyula-investor-portal/** and:

- Enter the **viewer** password → read-only view.
- Enter the **editor** password → editing toolbar appears.

---

## Daily use — editing together

1. Both of you open the URL, click the lock, enter the **editor** password.
2. Edit any text inline (click and type). Drag sections by their handle to
   reorder. Drag the bottom-right handle of a section to resize. Hide a section
   with its chip.
3. Click **Save**. Your changes are encrypted and committed. The other editor's
   browser autosyncs within ~5s — sections they aren't actively editing update
   automatically, so you won't overwrite each other.
4. Viewers (investors) see updates on their next refresh (auto every ~20s).

You **never** need to re-run `publish.sh` for normal edits — the Worker handles
saves. Re-run `publish.sh` only if you change the shell/runtime code or want to
reset content from your local `src/`.

---

## Recovery / inspection

```sh
./publish/pull.sh        # decrypts the live snapshot -> build/seed.from-live.json
```

Use this to recover the current content as readable JSON (e.g. after editing,
or to migrate). Requires `publish/.publish-password`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "snapshot decrypt failed" | `VIEWER_PASSWORD` (Worker) ≠ `publish/.publish-password`. Make them identical, re-run `publish.sh`. |
| Editor password rejected | Check `EDITOR_PASSWORD` secret; redeploy Worker. |
| Saves fail / CORS error | `ALLOWED_ORIGIN` must be exactly `https://ankitk-wq.github.io` (no trailing slash, no path). |
| "no worker configured" banner | `publish/.worker-config` empty or wrong URL → fix, re-run `publish.sh`. |
| Commit fails in Worker | `GITHUB_TOKEN` lacks **Contents: write**, or `GITHUB_REPO` wrong. |
| Page 404 | Pages not enabled, or wrong folder. Settings → Pages → branch `main`, folder `/docs`. |

---

## Security model (why this is safe)

- The **committed** files (`docs/`) contain only the UI shell + the encrypted
  blob. No financials in cleartext anywhere in git → repo can be public.
- Plaintext (`src/`, `build/seed.json`, `build/preview.html`) is git-ignored and
  never leaves your laptop.
- The GitHub token lives only as a Worker secret — never in the browser, never
  in the repo.
- Two passwords: `EDITOR_PASSWORD` (write) and `VIEWER_PASSWORD` (read +
  decrypt). Rotate by updating the Worker secret and re-running `publish.sh`
  (for the viewer password).
