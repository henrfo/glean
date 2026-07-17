/* add.js — the "add paper" box + GitHub token settings.
 *
 * Type a title or DOI → it's looked up on Semantic Scholar for a preview, then
 * appended to data/added.json in your repo (via gh.js). The Actions workflow picks
 * it up, resolves + scores it, and redeploys. The paper also shows immediately in
 * your feed (optimistic), so you don't wait on CI to see it.
 */
(function () {
  const S2 = "https://api.semanticscholar.org/graph/v1";
  const FIELDS = "paperId,title,authors,year,abstract,url,venue,citationCount";

  // Extract a DOI or arXiv id from free text; else treat input as a title.
  function classify(q) {
    const doi = q.match(/10\.\d{4,9}\/\S+/i);
    if (doi) return { kind: "id", value: "DOI:" + doi[0].replace(/[.,]$/, "") };
    const arx = q.match(/arxiv[:\s]*(\d{4}\.\d{4,5})/i);
    if (arx) return { kind: "id", value: "ARXIV:" + arx[1] };
    return { kind: "title", value: q.trim() };
  }

  // Best-effort Semantic Scholar lookup for an instant preview. Returns null on any
  // failure (CORS, rate limit) — the paper is still committed and CI resolves it.
  async function resolveS2(item) {
    try {
      let url;
      if (item.kind === "id") {
        url = `${S2}/paper/${encodeURIComponent(item.value)}?fields=${FIELDS}`;
      } else {
        url = `${S2}/paper/search/match?query=${encodeURIComponent(item.value)}&fields=${FIELDS}`;
      }
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return item.kind === "id" ? data : (data.data && data.data[0]) || null;
    } catch {
      return null;
    }
  }

  function s2ToPaper(obj) {
    return {
      id: obj.paperId,
      title: obj.title || "(untitled)",
      authors: (obj.authors || []).map((a) => a.name).filter(Boolean),
      year: obj.year,
      abstract: obj.abstract || "",
      url: obj.url || `https://www.semanticscholar.org/paper/${obj.paperId}`,
      venue: obj.venue || "",
      citation_count: obj.citationCount || 0,
      relevance_score: 1.0,
      date_added: new Date().toISOString().slice(0, 10),
      seen: false,
      pinned: false,
      is_seed: true,
    };
  }

  async function addPaper(query) {
    query = query.trim();
    if (!query) return;
    if (!Glean.gh.hasToken()) {
      Glean.toast("Connect your GitHub token first (⚙) so adds can save.");
      openSettings();
      return;
    }

    const item = classify(query);
    const entry = item.kind === "id" ? { id: item.value } : { title: item.value };

    Glean.toast("Looking up…");
    const resolved = await resolveS2(item);
    if (resolved && resolved.paperId) {
      entry.note = "added from the site";
      // Show it immediately in the feed (optimistic).
      const paper = s2ToPaper(resolved);
      if (!Glean.state.byId[paper.id]) {
        Glean.state.papers.push(paper);
        Glean.state.byId[paper.id] = paper;
      }
    }

    try {
      await Glean.gh.updateJSON(
        "data/added.json",
        (arr) => {
          const list = Array.isArray(arr) ? arr : [];
          // De-dupe by title/id text.
          const key = (e) => (e.id || e.title || "").toLowerCase();
          if (!list.some((e) => key(e) === key(entry))) list.push(entry);
          return list;
        },
        `add paper: ${resolved ? resolved.title : query}`.slice(0, 72),
        []
      );
    } catch (e) {
      Glean.toast("Save failed: " + e.message);
      return;
    }

    Glean.updateStats();
    Glean.renderFeed();
    Glean.toast(
      resolved
        ? `Added: ${resolved.title.slice(0, 50)} — refreshing shortly`
        : `Added "${query.slice(0, 40)}" — will resolve on the next refresh`
    );
  }

  /* ---------- token settings ---------- */
  function openSettings() {
    document.getElementById("settings").hidden = false;
    const inp = document.getElementById("token-input");
    inp.value = Glean.gh.getToken();
    inp.focus();
  }
  function closeSettings() {
    document.getElementById("settings").hidden = true;
  }
  async function saveToken() {
    const status = document.getElementById("token-status");
    const t = document.getElementById("token-input").value.trim();
    Glean.gh.setToken(t);
    if (!t) { status.textContent = "Token cleared."; Glean.reflectToken(); return; }
    status.textContent = "Checking…";
    try {
      await Glean.gh.check();
      status.textContent = `✓ Connected to ${Glean.gh.owner}/${Glean.gh.repo}`;
      Glean.reflectToken();
      setTimeout(closeSettings, 900);
    } catch (e) {
      status.textContent = "✗ " + e.message;
    }
  }

  // Reflect connection state in the ⚙ button.
  Glean.reflectToken = function () {
    const btn = document.getElementById("settings-btn");
    if (btn) btn.classList.toggle("connected", Glean.gh.hasToken());
  };

  Glean.initAdd = function () {
    document.getElementById("add-box").addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = document.getElementById("add-input");
      addPaper(inp.value);
      inp.value = "";
    });
    document.getElementById("settings-btn").addEventListener("click", openSettings);
    document.getElementById("settings-close").addEventListener("click", closeSettings);
    document.getElementById("token-save").addEventListener("click", saveToken);
    Glean.reflectToken();
  };
})();
