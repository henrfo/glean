#!/usr/bin/env python3
"""fetch.py — Semantic Scholar client for Glean.

Reads ``data/seeds.yaml``, pulls each seed paper's references + citations (and each
seed author's recent papers) from the Semantic Scholar Graph API, and appends any
new papers to ``data/papers.json`` and new citation links to ``data/edges.json``.

Idempotent: re-running only adds papers/edges that aren't already present, and never
overwrites user-set fields (``seen``, ``pinned``) or the score written by score.py.
Bad or unknown IDs are skipped with a warning — they never abort the run.

Usage:
    python scripts/fetch.py [--limit N] [--no-citations]

Env:
    SEMANTIC_SCHOLAR_API_KEY   optional — higher rate limits (free tier: 100 req/5min)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date
from pathlib import Path

import requests
import yaml

API_BASE = "https://api.semanticscholar.org/graph/v1"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SEEDS_FILE = DATA_DIR / "seeds.yaml"
PAPERS_FILE = DATA_DIR / "papers.json"
EDGES_FILE = DATA_DIR / "edges.json"

# Fields we ask Semantic Scholar for on every paper object.
PAPER_FIELDS = "paperId,title,abstract,year,venue,url,citationCount,authors"

# Preserve these fields if a paper already exists locally (user/scorer owned).
PRESERVE_FIELDS = ("seen", "pinned", "relevance_score", "date_added")


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def make_session() -> requests.Session:
    session = requests.Session()
    key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
    if key:
        session.headers["x-api-key"] = key
    session.headers["User-Agent"] = "glean/0.1 (personal research OS)"
    return session


def api_get(session: requests.Session, path: str, params: dict, *, retries: int = 4):
    """GET with polite backoff on rate limits. Returns parsed JSON or None on 404."""
    url = f"{API_BASE}/{path}"
    delay = 1.0
    for attempt in range(retries):
        resp = session.get(url, params=params, timeout=30)
        if resp.status_code == 404:
            return None
        if resp.status_code == 429:
            wait = float(resp.headers.get("Retry-After", delay))
            print(f"  rate limited; waiting {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            delay = min(delay * 2, 30)
            continue
        if resp.status_code >= 500:
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        resp.raise_for_status()
        # Be a good citizen even on success — free tier is 100 req / 5 min.
        time.sleep(0.3)
        return resp.json()
    print(f"  giving up on {path} after {retries} attempts", file=sys.stderr)
    return None


# --------------------------------------------------------------------------- #
# Mapping
# --------------------------------------------------------------------------- #
def to_paper(obj: dict) -> dict | None:
    """Map a Semantic Scholar paper object to Glean's Paper schema."""
    pid = obj.get("paperId")
    if not pid:
        return None
    authors = [a.get("name", "") for a in (obj.get("authors") or []) if a.get("name")]
    return {
        "id": pid,
        "title": obj.get("title") or "(untitled)",
        "authors": authors,
        "year": obj.get("year"),
        "abstract": obj.get("abstract") or "",
        "url": obj.get("url") or f"https://www.semanticscholar.org/paper/{pid}",
        "venue": obj.get("venue") or "",
        "citation_count": obj.get("citationCount") or 0,
        "relevance_score": 0.0,
        "date_added": date.today().isoformat(),
        "seen": False,
        "pinned": False,
        "is_seed": False,  # set True for direct seeds; used by the graph view
    }


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #
def fetch_paper(session, paper_id: str) -> dict | None:
    return api_get(session, f"paper/{paper_id}", {"fields": PAPER_FIELDS})


def fetch_related(session, paper_id: str, kind: str, limit: int) -> list[dict]:
    """kind is 'references' or 'citations'. Returns the related paper objects."""
    key = "citedPaper" if kind == "references" else "citingPaper"
    out: list[dict] = []
    offset = 0
    page = min(limit, 100)  # API max page size is 100
    while len(out) < limit:
        data = api_get(
            session,
            f"paper/{paper_id}/{kind}",
            {"fields": PAPER_FIELDS, "limit": page, "offset": offset},
        )
        if not data or not data.get("data"):
            break
        for row in data["data"]:
            related = row.get(key)
            if related:
                out.append(related)
        if len(data["data"]) < page or "next" not in data:
            break
        offset = data["next"]
    return out[:limit]


def fetch_author_papers(session, author_id: str, limit: int) -> list[dict]:
    data = api_get(
        session,
        f"author/{author_id}/papers",
        {"fields": PAPER_FIELDS, "limit": min(limit, 100)},
    )
    return (data or {}).get("data", []) or []


# --------------------------------------------------------------------------- #
# Persistence helpers
# --------------------------------------------------------------------------- #
def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text() or "null") or default
    except json.JSONDecodeError:
        print(f"warning: {path.name} was malformed; starting fresh", file=sys.stderr)
        return default


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch literature around your seeds.")
    ap.add_argument("--limit", type=int, default=100,
                    help="max references + max citations to pull per seed (default 100)")
    ap.add_argument("--no-citations", action="store_true",
                    help="only follow references (papers your seeds cite), not citations")
    args = ap.parse_args()

    seeds = load_json_yaml(SEEDS_FILE)
    seed_papers = seeds.get("papers") or []
    seed_authors = seeds.get("authors") or []
    if not seed_papers and not seed_authors:
        print("No seeds in data/seeds.yaml — add some paper/author IDs first.")
        return 1

    session = make_session()

    # Existing corpus, keyed by id so we can merge without clobbering user fields.
    papers = {p["id"]: p for p in load_json(PAPERS_FILE, [])}
    edges = {(e["source"], e["target"]) for e in load_json(EDGES_FILE, [])}
    n_papers_before, n_edges_before = len(papers), len(edges)
    seed_ids: set[str] = set()

    def upsert(obj: dict, *, is_seed: bool = False) -> str | None:
        paper = to_paper(obj)
        if not paper:
            return None
        pid = paper["id"]
        if pid in papers:
            existing = papers[pid]
            # Refresh metadata but keep user/scorer-owned fields.
            for f in PRESERVE_FIELDS:
                paper[f] = existing.get(f, paper[f])
            paper["is_seed"] = existing.get("is_seed", False) or is_seed
        else:
            paper["is_seed"] = is_seed
        papers[pid] = paper
        return pid

    # --- seed papers: pull the paper itself + its references and citations ---
    for seed in seed_papers:
        sid_raw = seed.get("id") if isinstance(seed, dict) else seed
        if not sid_raw:
            continue
        print(f"seed paper: {sid_raw}")
        obj = fetch_paper(session, sid_raw)
        if not obj:
            print(f"  ! could not resolve '{sid_raw}' — skipping", file=sys.stderr)
            continue
        sid = upsert(obj, is_seed=True)
        seed_ids.add(sid)

        refs = fetch_related(session, sid, "references", args.limit)
        print(f"  {len(refs)} references")
        for r in refs:
            rid = upsert(r)
            if rid:
                edges.add((sid, rid))  # seed cites reference

        if not args.no_citations:
            cites = fetch_related(session, sid, "citations", args.limit)
            print(f"  {len(cites)} citations")
            for c in cites:
                cid = upsert(c)
                if cid:
                    edges.add((cid, sid))  # citing paper cites seed

    # --- seed authors: pull their papers ---
    for author in seed_authors:
        aid = author.get("id") if isinstance(author, dict) else author
        if not aid:
            continue
        name = author.get("name", aid) if isinstance(author, dict) else aid
        print(f"seed author: {name} ({aid})")
        for obj in fetch_author_papers(session, aid, args.limit):
            pid = upsert(obj, is_seed=True)
            if pid:
                seed_ids.add(pid)

    write_json(PAPERS_FILE, list(papers.values()))
    write_json(EDGES_FILE, [{"source": s, "target": t} for s, t in sorted(edges)])

    print(
        f"\ndone: {len(papers)} papers (+{len(papers) - n_papers_before}), "
        f"{len(edges)} edges (+{len(edges) - n_edges_before}), "
        f"{len(seed_ids)} seeds resolved"
    )
    return 0


def load_json_yaml(path: Path) -> dict:
    if not path.exists():
        print(f"error: {path} not found", file=sys.stderr)
        return {}
    return yaml.safe_load(path.read_text()) or {}


if __name__ == "__main__":
    raise SystemExit(main())
