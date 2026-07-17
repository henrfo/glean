#!/usr/bin/env python3
"""score.py — relevance scoring for Glean.

Assigns every paper in ``data/papers.json`` a ``relevance_score`` in [0, 1] and
writes it back in place. Two signals, combined:

  1. Citation overlap  — how many distinct seed papers a paper is linked to in the
     citation graph (``data/edges.json``). This is the primary, always-on signal.
  2. SPECTER similarity — optional (``--embeddings``). Cosine similarity between a
     paper's SPECTER-v2 embedding and the centroid of the seed embeddings, fetched
     from Semantic Scholar and cached in ``data/.embeddings_cache.json``.

Seed papers are pinned to 1.0 so they anchor the graph and feed.

Usage:
    python scripts/score.py [--embeddings] [--w-citation 0.7] [--w-embedding 0.3]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import requests

API_BASE = "https://api.semanticscholar.org/graph/v1"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PAPERS_FILE = DATA_DIR / "papers.json"
EDGES_FILE = DATA_DIR / "edges.json"
EMBED_CACHE = DATA_DIR / ".embeddings_cache.json"


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text() or "null") or default
    except json.JSONDecodeError:
        return default


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
# Signal 1: citation overlap
# --------------------------------------------------------------------------- #
def citation_scores(papers: list[dict], edges: list[dict]) -> dict[str, float]:
    """For each paper: how many distinct seeds it connects to, normalized to [0,1]."""
    seed_ids = {p["id"] for p in papers if p.get("is_seed")}
    if not seed_ids:
        print("warning: no seed papers flagged — citation signal will be flat",
              file=sys.stderr)

    linked_seeds: dict[str, set[str]] = {p["id"]: set() for p in papers}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s in seed_ids and t in linked_seeds:
            linked_seeds[t].add(s)
        if t in seed_ids and s in linked_seeds:
            linked_seeds[s].add(t)

    counts = {pid: len(seeds) for pid, seeds in linked_seeds.items()}
    hi = max(counts.values(), default=0)
    if hi == 0:
        return {pid: 0.0 for pid in counts}
    # sqrt-compress so a paper linked to 4 seeds isn't 4x one linked to 1.
    return {pid: math.sqrt(c / hi) for pid, c in counts.items()}


# --------------------------------------------------------------------------- #
# Signal 2: SPECTER embedding similarity (optional)
# --------------------------------------------------------------------------- #
def get_embeddings(paper_ids: list[str]) -> dict[str, list[float]]:
    """Fetch SPECTER-v2 embeddings, cached on disk. Missing ones are skipped."""
    cache = load_json(EMBED_CACHE, {})
    missing = [pid for pid in paper_ids if pid not in cache]
    if missing:
        session = requests.Session()
        key = os.environ.get("SEMANTIC_SCHOLAR_API_KEY")
        if key:
            session.headers["x-api-key"] = key
        print(f"fetching {len(missing)} embeddings...")
        for i, pid in enumerate(missing):
            try:
                resp = session.get(
                    f"{API_BASE}/paper/{pid}",
                    params={"fields": "embedding.specter_v2"},
                    timeout=30,
                )
                if resp.status_code == 429:
                    time.sleep(float(resp.headers.get("Retry-After", 5)))
                    continue
                emb = (resp.json() or {}).get("embedding") if resp.ok else None
                cache[pid] = emb.get("vector") if emb else None
            except requests.RequestException:
                cache[pid] = None
            time.sleep(0.3)
            if (i + 1) % 25 == 0:
                write_json(EMBED_CACHE, cache)  # checkpoint
        write_json(EMBED_CACHE, cache)
    return {pid: v for pid in paper_ids if (v := cache.get(pid))}


def cosine(a: list[float], b: list[float]) -> float:
    import numpy as np
    va, vb = np.asarray(a, float), np.asarray(b, float)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(va @ vb / denom) if denom else 0.0


def embedding_scores(papers: list[dict]) -> dict[str, float]:
    import numpy as np
    embs = get_embeddings([p["id"] for p in papers])
    seed_vecs = [embs[p["id"]] for p in papers if p.get("is_seed") and p["id"] in embs]
    if not seed_vecs:
        print("warning: no seed embeddings available — skipping embedding signal",
              file=sys.stderr)
        return {}
    centroid = np.mean(np.asarray(seed_vecs, float), axis=0).tolist()
    sims = {pid: cosine(vec, centroid) for pid, vec in embs.items()}
    # Rescale cosine (~[-1,1], usually [0,1] for SPECTER) to [0,1] across the corpus.
    lo, hi = min(sims.values(), default=0.0), max(sims.values(), default=1.0)
    span = hi - lo or 1.0
    return {pid: (s - lo) / span for pid, s in sims.items()}


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Score papers by relevance to seeds.")
    ap.add_argument("--embeddings", action="store_true",
                    help="also use SPECTER embedding similarity (extra API calls)")
    ap.add_argument("--w-citation", type=float, default=0.7)
    ap.add_argument("--w-embedding", type=float, default=0.3)
    args = ap.parse_args()

    papers = load_json(PAPERS_FILE, [])
    edges = load_json(EDGES_FILE, [])
    if not papers:
        print("No papers to score — run scripts/fetch.py first.")
        return 1

    cite = citation_scores(papers, edges)
    embed = embedding_scores(papers) if args.embeddings else {}

    if embed:
        wc, we = args.w_citation, args.w_embedding
        total = wc + we or 1.0
        wc, we = wc / total, we / total
    else:
        wc, we = 1.0, 0.0

    for p in papers:
        if p.get("is_seed"):
            p["relevance_score"] = 1.0
            continue
        c = cite.get(p["id"], 0.0)
        e = embed.get(p["id"], 0.0)
        p["relevance_score"] = round(wc * c + we * e, 4)

    write_json(PAPERS_FILE, papers)

    ranked = sorted(papers, key=lambda p: p["relevance_score"], reverse=True)
    print(f"scored {len(papers)} papers "
          f"(citation w={wc:.2f}, embedding w={we:.2f}). Top 5:")
    for p in ranked[:5]:
        flag = " [seed]" if p.get("is_seed") else ""
        print(f"  {p['relevance_score']:.3f}  {p['title'][:70]}{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
