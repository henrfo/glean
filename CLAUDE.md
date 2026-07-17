# CLAUDE.md — Glean

## What is this

Glean is a personal research OS. Papers go in, your evolving positions come out.

It is NOT a paper tracker or reading list. It is a system that:
1. Automatically discovers relevant papers from the literature
2. Lets you read, highlight, and annotate them in-browser
3. Clusters your highlights into threads (emerging ideas you keep returning to)
4. Synthesizes your current thinking from those threads
5. Identifies gaps — things the literature addresses that your threads don't

The core loop: papers → highlights → threads → position summaries → gaps → new papers.

## Architecture

```
seeds.yaml                ← user-maintained seed papers + authors
     ↓
fetch.py                  ← Semantic Scholar API (daily cron via GitHub Actions)
     ↓
score.py                  ← relevance scoring (citation overlap + embedding similarity)
     ↓
papers.json + edges.json  ← append new papers + citation links
     ↓
summarize.py              ← Claude API: cluster highlights into threads, generate summaries
     ↓
site/                     ← static site deployed to GitHub Pages
```

GitHub Actions runs: fetch → score → rebuild → deploy. Same pattern as openmritools.github.io.

## Repo structure

```
glean/
├── .github/
│   └── workflows/
│       └── fetch.yml              # daily cron job
├── data/
│   ├── seeds.yaml                 # seed papers + authors (user edits this)
│   ├── papers.json                # all fetched paper metadata
│   ├── edges.json                 # citation links (directional)
│   ├── highlights.json            # user annotations
│   └── threads.json               # LLM-generated thread clusters
├── scripts/
│   ├── fetch.py                   # Semantic Scholar API client
│   ├── score.py                   # relevance scoring
│   └── summarize.py               # Claude API thread synthesis
├── site/
│   ├── index.html                 # main interface
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js                 # main app logic
│       ├── graph.js               # d3-force citation graph
│       ├── reader.js              # paper reader + highlighting
│       └── threads.js             # thread view + summaries
├── CLAUDE.md                      # this file
├── requirements.txt
└── README.md
```

## Data models

### Paper (in papers.json)
```json
{
  "id": "semantic_scholar_paper_id",
  "title": "string",
  "authors": ["string"],
  "year": 2025,
  "abstract": "string",
  "url": "string (link to paper)",
  "venue": "string",
  "citation_count": 0,
  "relevance_score": 0.0,
  "date_added": "ISO date",
  "seen": false,
  "pinned": false
}
```

### Edge (in edges.json)
```json
{
  "source": "paper_id (the citing paper)",
  "target": "paper_id (the cited paper)"
}
```

### Highlight (in highlights.json)
```json
{
  "id": "uuid",
  "paper_id": "semantic_scholar_paper_id",
  "text": "the highlighted passage",
  "note": "user's annotation (optional)",
  "created": "ISO date",
  "thread_id": "string or null (assigned by LLM clustering)"
}
```

### Thread (in threads.json)
```json
{
  "id": "string",
  "name": "LLM-generated thread name",
  "summary": "LLM-generated synthesis of your position based on highlights in this thread",
  "highlight_ids": ["uuid"],
  "last_updated": "ISO date",
  "gaps": ["strings — things the literature addresses that this thread doesn't"]
}
```

### Seeds (in seeds.yaml)
```yaml
papers:
  - id: "semantic_scholar_id_1"
    note: "foundational paper on X"
  - id: "semantic_scholar_id_2"
    note: "key result on Y"

authors:
  - id: "semantic_scholar_author_id"
    name: "Jane Doe"
    note: "tracks computational neuroscience + ML intersection"
```

## Technical decisions

- **Semantic Scholar API** for paper metadata, citations, and SPECTER embeddings. Free, no auth needed for basic use. Docs: https://api.semanticscholar.org/
- **Claude API (Sonnet)** for thread clustering and summary generation. Called in `summarize.py`. Requires ANTHROPIC_API_KEY env var.
- **d3-force** for the citation graph visualization.
- **GitHub Pages** for hosting the static site.
- **GitHub Actions** for the daily cron pipeline.
- **No backend server.** Everything is static files + JSON. Highlights are saved by committing to the repo (the site has a "save" action that writes to highlights.json, which gets committed and pushed by the Actions workflow — or alternatively, highlights are stored in localStorage and periodically exported).

## MVP scope (build this first)

### Phase 1: Pipeline
1. `seeds.yaml` with 3-5 example paper IDs
2. `fetch.py` — given seeds, fetch their citations and references from Semantic Scholar API, write to papers.json and edges.json
3. `score.py` — score each paper by: (a) number of citation links to seed papers, (b) optionally SPECTER embedding similarity
4. GitHub Actions workflow that runs fetch → score on a daily cron

### Phase 2: Interface
5. Static site with two views:
   - **Graph view**: d3-force graph of papers + citation edges. Seed papers are visually distinct. Node size = relevance score. Click a node → see paper details.
   - **Feed view**: chronological list of new papers sorted by relevance score. Each paper shows title, authors, year, abstract, relevance score. "Mark as seen" button.
6. Paper reader panel: click a paper → see its abstract (and link to full text). Highlight text → save highlight with optional note.

### Phase 3: Threads
7. `summarize.py` — takes all highlights, sends to Claude API, returns thread clusters with names and summaries. Writes to threads.json.
8. Thread view in the site: see your threads, the highlights in each, the LLM-generated summary of your current position.

### Phase 4 (later): Gaps + feedback loop
9. Gap detection: LLM identifies what the literature says that your threads don't cover.
10. Feedback: mark papers as "valuable" or "not relevant" → retrain relevance scoring.

## Design principles

- **JSON files are the database.** No server, no database. Everything is flat files in `data/`.
- **The graph has two layers.** Layer 1: paper citation graph (automated). Layer 2: your idea graph (threads derived from highlights). Layer 2 is the valuable one.
- **Highlights are the atomic unit.** Not papers. A highlight is you saying "this matters." Everything downstream flows from highlights.
- **The system should surface your thinking back to you.** The output isn't "here are papers" — it's "here is what you currently think, based on what you've highlighted, and here's what you might be missing."
- **Start ugly, iterate.** Basic HTML/CSS/JS. No frameworks. Make it work, then make it nice.

## Commands for the developer

```bash
# Install dependencies
pip install -r requirements.txt

# Run the fetch pipeline manually
python scripts/fetch.py

# Score papers
python scripts/score.py

# Generate thread summaries (requires ANTHROPIC_API_KEY)
python scripts/summarize.py

# Serve the site locally
cd site && python -m http.server 8000
```

## Environment variables

- `ANTHROPIC_API_KEY` — for Claude API calls in summarize.py
- `SEMANTIC_SCHOLAR_API_KEY` — optional, for higher rate limits (free tier is 100 req/5min)
