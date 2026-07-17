# glean

**A personal research OS — papers in, positions out.**

Automated literature tracking, in-browser highlighting, and LLM-synthesized threads of your evolving thinking.

---

## The idea

`glean` is a single-user research operating system. It is **not** a reading list or a
reference manager. The output isn't "here are papers" — it's **"here is what you
currently think, based on what you've highlighted, and here's what you might be missing."**

The core loop:

```
papers → highlights → threads → position summaries → gaps → new papers
```

1. **Discover** — seed it with papers/authors; it pulls the surrounding literature.
2. **Read & highlight** — annotate passages in-browser. A highlight is you saying *"this matters."*
3. **Thread** — an LLM clusters your highlights into threads (ideas you keep returning to).
4. **Synthesize** — each thread gets a summary of where your position currently stands.
5. **Find gaps** — the system surfaces what the literature addresses that your threads don't.

## Architecture

```
seeds.yaml  →  fetch.py  →  score.py  →  papers.json + edges.json  →  summarize.py  →  site/
              (Sem. Scholar)  (relevance)      (the corpus)          (Claude API)   (GitHub Pages)
```

A daily GitHub Actions cron runs **fetch → score → deploy**. No backend server —
flat JSON files in `data/` are the database, so your research history is a git history.

## Repo layout

| Path | What it is |
|------|-----------|
| `data/seeds.yaml` | Seed papers + authors — **you edit this** |
| `data/papers.json` · `edges.json` | Fetched metadata + citation graph |
| `data/highlights.json` · `threads.json` | Your annotations + LLM-clustered threads |
| `scripts/fetch.py` | Semantic Scholar API client |
| `scripts/score.py` | Relevance scoring (citation overlap + SPECTER similarity) |
| `scripts/summarize.py` | Claude API thread synthesis |
| `site/` | Static reading + graph + threads interface |
| `CLAUDE.md` | The build spec that drives the whole system |

## Quickstart

```bash
pip install -r requirements.txt

# 1. Edit data/seeds.yaml — add Semantic Scholar paper IDs you care about
# 2. Fetch the surrounding literature
python scripts/fetch.py

# 3. Score papers by relevance to your seeds
python scripts/score.py

# 4. Read & highlight in the browser
cd site && python -m http.server 8000     # → http://localhost:8000

# 5. Synthesize highlights into threads (needs ANTHROPIC_API_KEY)
python scripts/summarize.py
```

## Environment

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API calls in `summarize.py` |
| `SEMANTIC_SCHOLAR_API_KEY` | *Optional* — higher rate limits (free tier: 100 req / 5 min) |

## Status

MVP scaffold. Build phases and full spec live in [`CLAUDE.md`](CLAUDE.md).
