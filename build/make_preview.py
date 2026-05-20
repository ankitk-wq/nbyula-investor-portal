#!/usr/bin/env python3
"""make_preview.py — build a SELF-CONTAINED demo of the editable portal.

Produces build/preview.html: the public shell + the (normally encrypted)
content inlined as window.__SEED__, in DEMO mode (no password, no worker,
edits are local-only). Used purely to preview the editing UX in chat.

NEVER deploy preview.html — it contains the plaintext financials.
"""
from __future__ import annotations
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "docs" / "index.html"
SEED  = ROOT / "build" / "seed.json"
OUT   = ROOT / "build" / "preview.html"

shell = SHELL.read_text(encoding="utf-8")
seed  = json.loads(SEED.read_text(encoding="utf-8"))

inject = (
    "<script>\n"
    "window.__PORTAL_DEMO__ = true;\n"
    "window.__SEED__ = " + json.dumps(seed, ensure_ascii=False) + ";\n"
    "</script>\n"
)
# inject right before the runtime script tag
needle = '<script id="portal-runtime-js">'
pos = shell.find(needle)
if pos < 0:
    sys.stderr.write("[preview] could not find runtime script tag\n"); raise SystemExit(1)
out = shell[:pos] + inject + shell[pos:]
OUT.write_text(out, encoding="utf-8")
sys.stderr.write(f"[preview] wrote {OUT} ({OUT.stat().st_size:,} bytes)\n")
