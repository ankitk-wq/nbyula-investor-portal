# Nbyula Investor Portal

A password-protected, collaboratively-editable investor portal — public shell +
AES-256 encrypted content. Same architecture as OPS Graph.

- **Live URL:** https://ankitk-wq.github.io/nbyula-investor-portal/
- **Setup:** see [`SETUP.md`](./SETUP.md) for the full step-by-step guide.

## How it works

| Layer | What it does |
|---|---|
| `docs/index.html` | Public shell — CSS, fonts, Chart.js, the editor runtime, and an **empty** `<main>`. No financials. |
| `docs/data/snapshot.enc` | The real content (text, sections, chart data), **AES-256-CBC / PBKDF2-100k** encrypted with `VIEWER_PASSWORD`. |
| `worker/worker.js` | Cloudflare Worker: auth, re-encrypt-on-save, commit back to GitHub. Holds all secrets. |
| `publish/publish.sh` | Builds the shell, encrypts content, commits `docs/`, pushes. |

The repo can be **public** because nothing committed leaks the financials.

## Repository layout

```
investor-portal/
├── docs/                     # ← served by GitHub Pages (committed)
│   ├── index.html            #   public shell (no secrets)
│   ├── .nojekyll
│   └── data/
│       ├── snapshot.enc      #   encrypted content
│       └── snapshot.meta.json
├── worker/worker.js          # Cloudflare Worker source
├── build/
│   ├── build.py              # source → shell + seed.json
│   ├── runtime.js / .css     # editor engine + styles
│   └── make_preview.py       # local-only demo builder
├── publish/
│   ├── publish.sh            # build + encrypt + push
│   ├── pull.sh               # decrypt live snapshot (recovery)
│   ├── .publish-password     # (git-ignored) == Worker VIEWER_PASSWORD
│   └── .worker-config        # (git-ignored) Worker URL
├── src/portal-source.html    # (git-ignored) plaintext source of truth
├── SETUP.md
└── README.md
```

## Editing

Open the URL, unlock with the **editor** password, then:
- Click any text to edit inline.
- Drag a section by its handle to reorder; drag its corner to resize; hide via its chip.
- Click **Save** — changes are encrypted + committed; the other editor autosyncs in ~5s.

Section-level merge means two editors on different sections won't overwrite each
other. Viewers see updates on their next ~20s refresh.

## Security

- No cleartext financials in git (`src/`, `build/seed.json`, `build/preview.html` are git-ignored).
- GitHub token lives only as a Worker secret.
- Two passwords: `EDITOR_PASSWORD` (write), `VIEWER_PASSWORD` (read + decrypt).

⚠️ **Never** deploy `build/preview.html` — it inlines plaintext content for local preview only.
