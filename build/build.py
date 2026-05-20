#!/usr/bin/env python3
"""
build.py — split the investor portal into:

  1. A PUBLIC shell  -> docs/index.html
     Contains ONLY: <head> styles/fonts/Chart.js, the editor runtime
     (build/runtime.css + build/runtime.js), and an empty <main id="app">.
     It contains NO financials and NO chart numbers. Nothing leaks from
     "view source" on the GitHub Pages URL.

  2. An encrypted content SEED -> build/seed.json
     Contains ALL the real content: every section's HTML (the numbers,
     copy, tables, take-rate bars) plus the chart/interaction <script>
     (which holds gmv_raw / rev_raw / etc.). publish.sh encrypts this
     into docs/data/snapshot.enc with AES-256-CBC + PBKDF2.

The split point: <head> stays public; everything from <nav> up to the
first <script> in <body> is the section markup; the first <body> <script>
is the app script (charts + interactions). Any later <script> in the
source (e.g. an old local edit-layer) is intentionally dropped.

Run directly, or via publish/publish.sh.
"""
from __future__ import annotations
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT       = Path(__file__).resolve().parent.parent
SRC        = ROOT / "src"     / "portal-source.html"
SHELL_OUT  = ROOT / "docs"    / "index.html"
SEED_OUT   = ROOT / "build"   / "seed.json"
RUNTIME_JS = ROOT / "build"   / "runtime.js"
RUNTIME_CSS= ROOT / "build"   / "runtime.css"
WORKER_CFG = ROOT / "publish" / ".worker-config"
SNAPSHOT_URL = "data/snapshot.enc"


def read_worker_url() -> str | None:
    if not WORKER_CFG.exists():
        return None
    raw = WORKER_CFG.read_text(encoding="utf-8").strip()
    if not raw:
        return None
    if raw.startswith("WORKER_URL="):
        raw = raw.split("=", 1)[1].strip().strip('"').strip("'")
    if not (raw.startswith("http://") or raw.startswith("https://")):
        sys.stderr.write(f"[build] WARNING: worker URL looks invalid: {raw!r}\n")
    return raw or None


def slice_between(html: str, open_tag_re: str, close_tag: str, label: str) -> tuple[str, int, int]:
    m = re.search(open_tag_re, html, re.IGNORECASE)
    if not m:
        sys.stderr.write(f"[build] FATAL: could not find {label} open tag\n")
        raise SystemExit(1)
    start = m.end()
    end = html.lower().find(close_tag.lower(), start)
    if end < 0:
        sys.stderr.write(f"[build] FATAL: could not find {label} close tag {close_tag}\n")
        raise SystemExit(1)
    return html[start:end], m.start(), end + len(close_tag)


def main() -> int:
    if not SRC.exists():
        sys.stderr.write(f"[build] source not found: {SRC}\n")
        return 1
    if not RUNTIME_JS.exists() or not RUNTIME_CSS.exists():
        sys.stderr.write("[build] FATAL: build/runtime.js or build/runtime.css missing\n")
        return 1

    html = SRC.read_text(encoding="utf-8")

    # ---- 1. <head> inner (public; CSS, fonts, Chart.js CDN, title) ---------
    head_inner, _, _ = slice_between(html, r"<head[^>]*>", "</head>", "<head>")

    # ---- 2. <body> inner ---------------------------------------------------
    body_inner, _, _ = slice_between(html, r"<body[^>]*>", "</body>", "<body>")

    # ---- 3. split body into [section markup] | [first <script> = appScript]
    script_open = re.search(r"<script\b[^>]*>", body_inner, re.IGNORECASE)
    if not script_open:
        sys.stderr.write("[build] FATAL: no <script> found in <body>\n")
        return 1
    body_html = body_inner[:script_open.start()].strip()  # nav + sections

    # appScript = content of the FIRST body <script> ... </script>
    s_start = script_open.end()
    s_end = body_inner.lower().find("</script>", s_start)
    if s_end < 0:
        sys.stderr.write("[build] FATAL: unterminated <script> in <body>\n")
        return 1
    app_script = body_inner[s_start:s_end].strip()

    # Title (nice-to-have, not sensitive)
    tm = re.search(r"<title[^>]*>(.*?)</title>", head_inner, re.IGNORECASE | re.DOTALL)
    title = tm.group(1).strip() if tm else "Investor Portal"

    # ---- 4. write the encrypted-content seed -------------------------------
    seed = {
        "version": 3,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "updatedBy": "seed",
        "meta": {"title": title},
        "bodyHTML": body_html,     # nav + all sections (the numbers live here)
        "appScript": app_script,   # charts + interactions (gmv_raw etc.)
    }
    SEED_OUT.write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
    sys.stderr.write(f"[build] wrote seed.json ({SEED_OUT.stat().st_size:,} bytes)\n")

    # ---- 5. assemble the public shell -------------------------------------
    worker_url = read_worker_url()
    runtime_css = RUNTIME_CSS.read_text(encoding="utf-8")
    runtime_js  = RUNTIME_JS.read_text(encoding="utf-8")

    cfg_lines = [
        "<script>",
        "window.__PORTAL_CONFIG__ = {",
        f"  snapshotUrl: {json.dumps(SNAPSHOT_URL)},",
        f"  workerUrl: {json.dumps(worker_url)},",
        f"  title: {json.dumps(title)},",
        "  pbkdf2Iterations: 100000",
        "};",
        "</script>",
    ]
    config_block = "\n".join(cfg_lines)

    shell = f"""<!DOCTYPE html>
<html lang="en">
<head>
{head_inner}
<style id="portal-runtime-css">
{runtime_css}
</style>
</head>
<body class="portal-locked">
<main id="app" aria-busy="true"></main>
{config_block}
<script id="portal-runtime-js">
{runtime_js}
</script>
</body>
</html>
"""
    SHELL_OUT.write_text(shell, encoding="utf-8")
    sys.stderr.write(
        f"[build] wrote docs/index.html ({SHELL_OUT.stat().st_size:,} bytes, "
        f"worker_url={'set' if worker_url else 'UNSET'})\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
