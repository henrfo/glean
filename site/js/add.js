/* add.js — the "add paper" box + inline GitHub token connect.
 *
 * Type a title or DOI → previewed on Semantic Scholar, shown immediately in the
 * table, and appended to data/added.json in your repo (via gh.js). The Actions
 * workflow resolves + scores it and redeploys. No modals, no YAML editing.
 */
(function () {
  const S2 = "https://api.semanticscholar.org/graph/v1";
  const FIELDS = "paperId,title,authors,year,abstract,url,venue,citationCount";

  function classify(q) {
    const doi = q.match(/10\.\d{4,9}\/\S+/i);
    if (doi) return { kind: "id", value: "DOI:" + doi[0].replace(/[.,]$/, "") };
    const arx = q.match(/arxiv[:\s]*(\d{4}\.\d{4,5})/i);
    if (arx) return { kind: "id", value: "ARXIV:" + arx[1] };
    return { kind: "title", value: q.trim() };
  }

  async function resolveS2(item) {
    try {
      const url = item.kind === "id"
        ? `${S2}/paper/${encodeURIComponent(item.value)}?fields=${FIELDS}`
        : `${S2}/paper/search/match?query=${encodeURIComponent(item.value)}&fields=${FIELDS}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return item.kind === "id" ? data : (data.data && data.data[0]) || null;
    } catch { return null; }
  }

  function s2ToPaper(o) {
    return {
      id: o.paperId, title: o.title || "(untitled)",
      authors: (o.authors || []).map((a) => a.name).filter(Boolean),
      year: o.year, abstract: o.abstract || "",
      url: o.url || `https://www.semanticscholar.org/paper/${o.paperId}`,
      venue: o.venue || "", citation_count: o.citationCount || 0,
      relevance_score: 1.0, date_added: new Date().toISOString().slice(0, 10),
      seen: false, pinned: false, is_seed: true,
    };
  }

  async function addPaper(query) {
    query = query.trim();
    if (!query) return;
    if (!Glean.gh.hasToken()) {
      Glean.toast("Connect a GitHub token first (top-right) so adds can save.");
      openToken();
      return;
    }
    const item = classify(query);
    const entry = item.kind === "id" ? { id: item.value } : { title: item.value };

    Glean.toast("Looking up…");
    const resolved = await resolveS2(item);
    if (resolved && resolved.paperId) {
      entry.note = "added from the site";
      const paper = s2ToPaper(resolved);
      if (!Glean.state.byId[paper.id]) {
        Glean.state.papers.push(paper);
        Glean.state.byId[paper.id] = paper;
      }
      Glean.render();
    }

    try {
      await Glean.gh.updateJSON(
        "data/added.json",
        (arr) => {
          const list = Array.isArray(arr) ? arr : [];
          const key = (e) => (e.id || e.title || "").toLowerCase();
          if (!list.some((e) => key(e) === key(entry))) list.push(entry);
          return list;
        },
        `add paper: ${resolved ? resolved.title : query}`.slice(0, 72),
        []
      );
    } catch (e) { Glean.toast("Save failed: " + e.message); return; }

    Glean.toast(resolved
      ? `Added: ${resolved.title.slice(0, 50)} — refreshing shortly`
      : `Added "${query.slice(0, 40)}" — will resolve on the next refresh`);
  }

  /* ---------- inline token connect ---------- */
  function openToken() {
    const area = document.getElementById("token-area");
    area.hidden = false;
    const inp = document.getElementById("token-input");
    inp.value = Glean.gh.getToken();
    inp.focus();
  }
  function toggleToken() {
    const area = document.getElementById("token-area");
    if (area.hidden) openToken(); else area.hidden = true;
  }
  async function saveToken() {
    const status = document.getElementById("token-status");
    const t = document.getElementById("token-input").value.trim();
    Glean.gh.setToken(t);
    if (!t) { status.textContent = "cleared"; Glean.reflectToken(); return; }
    status.textContent = "checking…";
    try {
      await Glean.gh.check();
      status.textContent = `✓ connected to ${Glean.gh.owner}/${Glean.gh.repo}`;
      Glean.reflectToken();
    } catch (e) { status.textContent = "✗ " + e.message; }
  }

  Glean.reflectToken = function () {
    const btn = document.getElementById("connect-toggle");
    if (btn) {
      btn.classList.toggle("connected", Glean.gh.hasToken());
      btn.textContent = Glean.gh.hasToken() ? "connected" : "connect";
    }
  };

  Glean.initAdd = function () {
    document.getElementById("add-box").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = document.getElementById("add-input");
      addPaper(inp.value);
      inp.value = "";
    });
    document.getElementById("connect-toggle").addEventListener("click", toggleToken);
    document.getElementById("token-save").addEventListener("click", saveToken);
    Glean.reflectToken();
  };
})();
