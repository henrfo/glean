#!/usr/bin/env python3
"""summarize.py — LLM thread synthesis for Glean.

Reads your highlights (data/highlights.json), sends them to Claude, and gets back
*threads*: clusters of highlights that represent ideas you keep returning to. Each
thread carries a name, a synthesis of where your position currently stands, the
highlight IDs it's built from, and possible gaps — things the literature addresses
that the thread doesn't. Writes the result to data/threads.json.

This is the payoff of the whole system: the output isn't "here are papers," it's
"here is what you currently think, based on what you've highlighted."

Usage:
    python scripts/summarize.py [--model claude-opus-4-8]

Env:
    ANTHROPIC_API_KEY   required
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import anthropic

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HIGHLIGHTS_FILE = DATA_DIR / "highlights.json"
PAPERS_FILE = DATA_DIR / "papers.json"
THREADS_FILE = DATA_DIR / "threads.json"

DEFAULT_MODEL = "claude-opus-4-8"

SYSTEM = """\
You are the synthesis engine of Glean, a personal research OS. The user highlights \
passages while reading papers; each highlight is them saying "this matters." Your job \
is to cluster their highlights into threads — coherent lines of thinking they keep \
returning to — and to articulate, for each thread, where their current position stands.

Principles:
- Threads are about the USER's evolving ideas, not a summary of the papers. Read across \
highlights to find the through-line.
- A highlight can belong to only one thread. Every highlight should land in a thread; \
create a catch-all thread only if something genuinely doesn't fit.
- The `summary` is a synthesis of the user's position as implied by what they chose to \
highlight — write it in their voice, as a claim, not a neutral abstract.
- `gaps` are things the surrounding literature clearly engages with that this thread's \
highlights do NOT address — questions the user might be missing. Be specific; omit if none.
- Prefer a few strong threads over many thin ones."""

# Structured-output schema: constrains Claude's response to exactly this shape.
THREADS_SCHEMA = {
    "type": "object",
    "properties": {
        "threads": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "short kebab-case slug"},
                    "name": {"type": "string"},
                    "summary": {"type": "string"},
                    "highlight_ids": {"type": "array", "items": {"type": "string"}},
                    "gaps": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "name", "summary", "highlight_ids", "gaps"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["threads"],
    "additionalProperties": False,
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text() or "null") or default
    except json.JSONDecodeError:
        return default


def build_user_message(highlights: list[dict], papers_by_id: dict) -> str:
    lines = [
        "Here are my highlights. Cluster them into threads and synthesize my position "
        "for each. Reference highlights by their exact id.\n",
    ]
    for h in highlights:
        paper = papers_by_id.get(h.get("paper_id"), {})
        title = paper.get("title", "unknown paper")
        lines.append(f"- id: {h['id']}")
        lines.append(f"  paper: {title}")
        lines.append(f"  highlight: {h.get('text', '').strip()}")
        if h.get("note"):
            lines.append(f"  my note: {h['note'].strip()}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Synthesize highlights into threads.")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    highlights = load_json(HIGHLIGHTS_FILE, [])
    if not highlights:
        print("No highlights yet — read and highlight some papers first "
              "(then export highlights.json from the site).")
        return 1

    papers_by_id = {p["id"]: p for p in load_json(PAPERS_FILE, [])}

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
    print(f"Synthesizing {len(highlights)} highlights with {args.model}...")

    try:
        response = client.messages.create(
            model=args.model,
            max_tokens=16000,
            thinking={"type": "adaptive"},
            system=SYSTEM,
            messages=[{"role": "user",
                       "content": build_user_message(highlights, papers_by_id)}],
            output_config={"format": {"type": "json_schema", "schema": THREADS_SCHEMA}},
        )
    except anthropic.APIError as e:
        print(f"Claude API error: {e}", file=sys.stderr)
        return 2

    # With output_config.format, the response text is guaranteed valid JSON.
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    threads = json.loads(text).get("threads", [])

    # Keep only highlight_ids that actually exist, and stamp the update date.
    valid_ids = {h["id"] for h in highlights}
    today = date.today().isoformat()
    for t in threads:
        t["highlight_ids"] = [hid for hid in t.get("highlight_ids", []) if hid in valid_ids]
        t["last_updated"] = today
        t.setdefault("gaps", [])

    THREADS_FILE.write_text(json.dumps(threads, indent=2, ensure_ascii=False) + "\n")

    print(f"\nwrote {len(threads)} threads to {THREADS_FILE.name}:")
    for t in threads:
        print(f"  • {t['name']} ({len(t['highlight_ids'])} highlights, "
              f"{len(t['gaps'])} gaps)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
