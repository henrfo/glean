/* app.js — Glean core: data loading, shared state, feed view, highlight storage.
 *
 * No framework. graph.js / reader.js / threads.js attach their renderers onto the
 * global `Glean` object defined here; app.js orchestrates on DOMContentLoaded.
 *
 * Highlights are the atomic unit. They live in localStorage as you work, merged on
 * load with any committed data/highlights.json, and Export downloads the merged set
 * as highlights.json for you to commit — that file is what summarize.py reads.
 */
const Glean = window.Glean = {
  state: { papers: [], edges: [], threads: [], byId: {} },
  HL_KEY: "glean.highlights",
};

/* ---------- data loading ---------- */
// Works both locally (serve site/, data lives at ../data) and on Pages
// (data bundled into site/data). Try ./data first, then ../data.
async function fetchData(name) {
  for (const base of ["data", "../data"]) {
    try {
      const res = await fetch(`${base}/${name}`, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch (_) { /* try next base */ }
  }
  console.warn(`could not load ${name}`);
  return null;
}

Glean.loadData = async function () {
  const [papers, edges, threads, committedHl] = await Promise.all([
    fetchData("papers.json"),
    fetchData("edges.json"),
    fetchData("threads.json"),
    fetchData("highlights.json"),
  ]);
  Glean.state.papers = papers || [];
  Glean.state.edges = edges || [];
  Glean.state.threads = threads || [];
  Glean.state.byId = Object.fromEntries(Glean.state.papers.map((p) => [p.id, p]));
  Glean._committedHighlights = committedHl || [];
};

/* ---------- highlights (localStorage + committed, merged by id) ---------- */
Glean.getLocalHighlights = function () {
  try { return JSON.parse(localStorage.getItem(Glean.HL_KEY)) || []; }
  catch { return []; }
};
Glean.setLocalHighlights = function (list) {
  localStorage.setItem(Glean.HL_KEY, JSON.stringify(list));
};
Glean.getHighlights = function () {
  const local = Glean.getLocalHighlights();
  const localIds = new Set(local.map((h) => h.id));
  const committed = (Glean._committedHighlights || []).filter((h) => !localIds.has(h.id));
  return [...committed, ...local];
};
Glean.highlightsFor = function (paperId) {
  return Glean.getHighlights().filter((h) => h.paper_id === paperId);
};
Glean.addHighlight = function (paperId, text, note) {
  const local = Glean.getLocalHighlights();
  local.push({
    id: uuid(),
    paper_id: paperId,
    text: text.trim(),
    note: (note || "").trim(),
    created: new Date().toISOString(),
    thread_id: null,
  });
  Glean.setLocalHighlights(local);
  Glean.updateStats();
};
Glean.deleteHighlight = function (id) {
  Glean.setLocalHighlights(Glean.getLocalHighlights().filter((h) => h.id !== id));
  Glean.updateStats();
};

/* ---------- paper mutations (seen/pinned live in localStorage) ---------- */
const FLAG_KEY = "glean.flags";
Glean.getFlags = function () {
  try { return JSON.parse(localStorage.getItem(FLAG_KEY)) || {}; }
  catch { return {}; }
};
Glean.setFlag = function (paperId, key, value) {
  const flags = Glean.getFlags();
  flags[paperId] = { ...(flags[paperId] || {}), [key]: value };
  localStorage.setItem(FLAG_KEY, JSON.stringify(flags));
};
Glean.flag = function (paper, key) {
  const f = Glean.getFlags()[paper.id];
  return f && key in f ? f[key] : paper[key];
};

/* ---------- feed view ---------- */
Glean.renderFeed = function () {
  const list = document.getElementById("feed-list");
  const hideSeen = document.getElementById("hide-seen").checked;
  let papers = [...Glean.state.papers].sort(
    (a, b) => (b.relevance_score || 0) - (a.relevance_score || 0)
  );
  if (hideSeen) papers = papers.filter((p) => !Glean.flag(p, "seen"));

  if (!papers.length) {
    list.innerHTML = `<div class="empty">No papers yet. Add seeds to data/seeds.yaml and run scripts/fetch.py.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const p of papers) {
    const seen = Glean.flag(p, "seen");
    const card = document.createElement("div");
    card.className = "card" + (p.is_seed ? " is-seed" : "") + (seen ? " is-seen" : "");
    card.innerHTML = `
      <p class="card-title">${esc(p.title)}</p>
      <div class="card-meta">
        <span>${esc((p.authors || []).slice(0, 3).join(", "))}${(p.authors || []).length > 3 ? " et al." : ""}</span>
        <span>${p.year || "—"}</span>
        ${p.venue ? `<span>${esc(p.venue)}</span>` : ""}
        <span>${p.citation_count || 0} cites</span>
        <span class="score-pill">${(p.relevance_score || 0).toFixed(2)}</span>
      </div>
      ${p.abstract ? `<p class="card-abstract">${esc(p.abstract)}</p>` : ""}
      <div class="card-actions">
        <button class="mini" data-act="read">Read →</button>
        <button class="mini" data-act="seen">${seen ? "seen ✓" : "mark seen"}</button>
      </div>`;
    card.querySelector('[data-act="read"]').addEventListener("click", (e) => {
      e.stopPropagation();
      Glean.openReader(p.id);
    });
    card.querySelector('[data-act="seen"]').addEventListener("click", (e) => {
      e.stopPropagation();
      Glean.setFlag(p.id, "seen", !seen);
      Glean.renderFeed();
    });
    card.addEventListener("click", () => Glean.openReader(p.id));
    list.appendChild(card);
  }
};

/* ---------- tabs ---------- */
Glean.showView = function (name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("is-active", v.id === `view-${name}`));
  if (name === "graph") Glean.renderGraph();
  if (name === "threads") Glean.renderThreads();
  if (name === "feed") Glean.renderFeed();
};

/* ---------- stats + export/import ---------- */
Glean.updateStats = function () {
  const s = Glean.state;
  document.getElementById("stats").textContent =
    `${s.papers.length} papers · ${s.edges.length} edges · ${Glean.getHighlights().length} highlights · ${s.threads.length} threads`;
};

Glean.exportHighlights = function () {
  const blob = new Blob([JSON.stringify(Glean.getHighlights(), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "highlights.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Downloaded highlights.json — commit it to data/ to feed summarize.py");
};

Glean.importHighlights = function (file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!Array.isArray(incoming)) throw new Error("not an array");
      const local = Glean.getLocalHighlights();
      const seen = new Set(local.map((h) => h.id));
      for (const h of incoming) if (!seen.has(h.id)) local.push(h);
      Glean.setLocalHighlights(local);
      toast(`Imported ${incoming.length} highlights`);
      Glean.updateStats();
      Glean.openReaderRefresh();
    } catch (e) {
      toast("Import failed: " + e.message);
    }
  };
  reader.readAsText(file);
};

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}
Glean.esc = esc;
Glean.toast = toast;

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("tabs").addEventListener("click", (e) => {
    if (e.target.dataset.view) Glean.showView(e.target.dataset.view);
  });
  document.getElementById("hide-seen").addEventListener("change", Glean.renderFeed);
  document.getElementById("reader-close").addEventListener("click", Glean.closeReader);
  Glean.initAdd();

  await Glean.loadData();
  Glean.updateStats();
  Glean.renderFeed();
});
