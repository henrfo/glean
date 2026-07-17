/* app.js — Glean, table-first. The data is the interface.
 *
 * One table of papers. Rating dots you click to cycle. Rows expand inline to the
 * abstract, where selecting text saves a highlight. A collapsible threads section
 * sits above. All view state (sort, filter, open row, threads) lives in the URL, so
 * every view is deep-linkable and survives a refresh.
 *
 * Persistence: ratings → data/ratings.json, highlights → data/highlights.json,
 * committed to the repo via gh.js (with a token) and mirrored to localStorage so the
 * UI is instant and still works offline.
 */
const Glean = (window.Glean = {
  state: { papers: [], threads: [], byId: {} },
  view: { sort: "rating", dir: "desc", q: "", open: null, threads: false },
  RATE_KEY: "glean.ratings",
  HL_KEY: "glean.highlights",
  FLAG_KEY: "glean.flags",
});

/* ---------- data loading (works locally and on Pages) ---------- */
async function fetchData(name) {
  for (const base of ["data", "../data"]) {
    try {
      const r = await fetch(`${base}/${name}`, { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (_) {}
  }
  return null;
}

Glean.loadData = async function () {
  const [papers, threads, ratings, highlights] = await Promise.all([
    fetchData("papers.json"),
    fetchData("threads.json"),
    fetchData("ratings.json"),
    fetchData("highlights.json"),
  ]);
  Glean.state.papers = papers || [];
  Glean.state.threads = threads || [];
  Glean.state.byId = Object.fromEntries(Glean.state.papers.map((p) => [p.id, p]));
  Glean._committedRatings = ratings || {};
  Glean._committedHighlights = highlights || [];
};

/* ---------- ratings (localStorage + committed ratings.json) ---------- */
function localRatings() {
  try { return JSON.parse(localStorage.getItem(Glean.RATE_KEY)) || {}; }
  catch { return {}; }
}
Glean.ratings = function () {
  return { ...(Glean._committedRatings || {}), ...localRatings() };
};
Glean.ratingOf = function (id) {
  const v = Glean.ratings()[id];
  return typeof v === "number" ? v : null;
};
Glean.setRating = function (id, val) {
  const r = localRatings();
  if (val == null) delete r[id];
  else r[id] = val;
  localStorage.setItem(Glean.RATE_KEY, JSON.stringify(r));
  scheduleRatingCommit();
};
// Cycle: unrated → 1 → 2 → … → 10 → unrated. (Shift-click steps backward.)
Glean.cycleRating = function (id, back) {
  const cur = Glean.ratingOf(id);
  let next;
  if (back) next = cur == null ? 10 : cur <= 1 ? null : cur - 1;
  else next = cur == null ? 1 : cur >= 10 ? null : cur + 1;
  Glean.setRating(id, next);
};
function dotClass(v) {
  if (v == null) return "dot-unknown";
  if (v >= 9) return "dot-external";
  if (v >= 7) return "dot-active";
  if (v >= 4) return "dot-quiet";
  return "dot-inactive";
}

let ratingTimer;
function scheduleRatingCommit() {
  clearTimeout(ratingTimer);
  ratingTimer = setTimeout(commitRatings, 1600);
}
async function commitRatings() {
  if (!Glean.gh || !Glean.gh.hasToken()) return; // local-only without a token
  try {
    const local = localRatings();
    await Glean.gh.updateJSON(
      "data/ratings.json",
      (obj) => ({ ...(obj || {}), ...local }),
      "ratings: update from site",
      {}
    );
  } catch (e) { Glean.toast("Ratings not saved: " + e.message); }
}

/* ---------- seen flags (local) ---------- */
function flags() {
  try { return JSON.parse(localStorage.getItem(Glean.FLAG_KEY)) || {}; }
  catch { return {}; }
}
Glean.isSeen = function (id) { return !!(flags()[id] && flags()[id].seen); };
Glean.setSeen = function (id, v) {
  const f = flags(); f[id] = { ...(f[id] || {}), seen: v };
  localStorage.setItem(Glean.FLAG_KEY, JSON.stringify(f));
};

/* ---------- highlights (localStorage + committed) ---------- */
function localHighlights() {
  try { return JSON.parse(localStorage.getItem(Glean.HL_KEY)) || []; }
  catch { return []; }
}
Glean.highlights = function () {
  const local = localHighlights();
  const ids = new Set(local.map((h) => h.id));
  return [...(Glean._committedHighlights || []).filter((h) => !ids.has(h.id)), ...local];
};
Glean.highlightsFor = function (pid) {
  return Glean.highlights().filter((h) => h.paper_id === pid);
};
Glean.addHighlight = function (pid, text) {
  const local = localHighlights();
  local.push({ id: uuid(), paper_id: pid, text: text.trim(), note: "",
    created: new Date().toISOString(), thread_id: null });
  localStorage.setItem(Glean.HL_KEY, JSON.stringify(local));
  commitHighlights();
};
Glean.deleteHighlight = function (hid) {
  localStorage.setItem(Glean.HL_KEY,
    JSON.stringify(localHighlights().filter((h) => h.id !== hid)));
  commitHighlights();
};
async function commitHighlights() {
  if (!Glean.gh || !Glean.gh.hasToken()) return;
  try {
    await Glean.gh.updateJSON(
      "data/highlights.json",
      () => Glean.highlights(),
      "highlights: update from site",
      []
    );
  } catch (e) { Glean.toast("Highlights not saved: " + e.message); }
}

/* ---------- URL state ---------- */
function readURL() {
  const p = new URLSearchParams(location.search);
  const v = Glean.view;
  v.sort = p.get("sort") || "rating";
  v.dir = p.get("dir") === "asc" ? "asc" : "desc";
  v.q = p.get("q") || "";
  v.open = p.get("open") || null;
  v.threads = p.get("threads") === "1";
}
function writeURL() {
  const v = Glean.view, p = new URLSearchParams();
  if (v.sort !== "rating") p.set("sort", v.sort);
  if (v.dir !== "desc") p.set("dir", v.dir);
  if (v.q) p.set("q", v.q);
  if (v.open) p.set("open", v.open);
  if (v.threads) p.set("threads", "1");
  const qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}

/* ---------- rendering ---------- */
function sortValue(p, col) {
  switch (col) {
    case "rating": { const r = Glean.ratingOf(p.id); return r == null ? -1 : r; }
    case "title": return (p.title || "").toLowerCase();
    case "authors": return ((p.authors || [])[0] || "").toLowerCase();
    case "year": return p.year || 0;
    case "seen": return Glean.isSeen(p.id) ? 1 : 0;
    default: return 0;
  }
}

function visiblePapers() {
  const v = Glean.view;
  let list = [...Glean.state.papers];
  if (v.q) {
    const q = v.q.toLowerCase();
    list = list.filter((p) =>
      (p.title || "").toLowerCase().includes(q) ||
      (p.authors || []).join(" ").toLowerCase().includes(q));
  }
  if (v.sort) {
    const dir = v.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const va = sortValue(a, v.sort), vb = sortValue(b, v.sort);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (a.title || "").localeCompare(b.title || "");
    });
  }
  return list;
}

// thread name for a paper (if any of its highlights are in a thread)
function threadNameFor(pid) {
  const hids = new Set(Glean.highlightsFor(pid).map((h) => h.id));
  if (!hids.size) return null;
  const t = Glean.state.threads.find((t) => (t.highlight_ids || []).some((id) => hids.has(id)));
  return t ? t.name : null;
}

Glean.render = function () {
  const tbody = document.getElementById("rows");
  const papers = visiblePapers();
  updateHeaders();

  if (!papers.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${
      Glean.state.papers.length ? "No papers match this filter." :
      "No papers yet. Add seeds, or use the add box above."
    }</td></tr>`;
  } else {
    tbody.innerHTML = "";
    for (const p of papers) {
      tbody.appendChild(rowFor(p));
      if (Glean.view.open === p.id) tbody.appendChild(detailFor(p));
    }
  }
  renderMeta(papers.length);
  renderThreads();
};

function rowFor(p) {
  const tr = document.createElement("tr");
  tr.className = "paper-row" + (Glean.isSeen(p.id) ? " is-seen" : "");
  const rating = Glean.ratingOf(p.id);
  const authors = (p.authors || []).slice(0, 2).join(", ") +
    ((p.authors || []).length > 2 ? " et al." : "");
  const thread = threadNameFor(p.id);
  tr.innerHTML = `
    <td class="col-rating">
      <span class="rate" title="${rating == null ? "unrated" : "rating " + rating} — click to cycle, shift-click back">
        <span class="dot ${dotClass(rating)}"></span>
      </span>
    </td>
    <td class="c-title">${esc(p.title)}</td>
    <td class="c-authors">${esc(authors)}</td>
    <td class="c-year">${p.year || ""}</td>
    <td class="c-thread">${thread ? `<span class="tag">${esc(thread)}</span>` : ""}</td>
    <td class="col-seen"><input type="checkbox" class="seen-box" ${Glean.isSeen(p.id) ? "checked" : ""}></td>`;

  tr.querySelector(".rate").addEventListener("click", (e) => {
    e.stopPropagation();
    Glean.cycleRating(p.id, e.shiftKey);
    Glean.render();
  });
  tr.querySelector(".seen-box").addEventListener("click", (e) => e.stopPropagation());
  tr.querySelector(".seen-box").addEventListener("change", (e) => {
    Glean.setSeen(p.id, e.target.checked);
    Glean.render();
  });
  tr.addEventListener("click", () => {
    Glean.view.open = Glean.view.open === p.id ? null : p.id;
    writeURL();
    Glean.render();
  });
  return tr;
}

function detailFor(p) {
  const tr = document.createElement("tr");
  tr.className = "detail-row";
  const hls = Glean.highlightsFor(p.id);
  tr.innerHTML = `
    <td></td>
    <td colspan="5">
      <div class="detail">
        <div class="d-meta">
          ${esc((p.authors || []).join(", "))}${p.year ? " · " + p.year : ""}${p.venue ? " · " + esc(p.venue) : ""}
          ${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">full text ↗</a>` : ""}
        </div>
        <div class="d-abstract" id="ab-${p.id}">${
          p.abstract ? markUp(p.abstract, hls) : `<span class="d-empty">No abstract available.</span>`
        }</div>
        ${p.abstract ? `<div class="hl-hint">select text above to highlight it</div>` : ""}
        <div class="d-hls" id="hls-${p.id}"></div>
      </div>
    </td>`;
  // defer wiring until in DOM
  setTimeout(() => wireDetail(p), 0);
  return tr;
}

function wireDetail(p) {
  renderHls(p.id);
  const ab = document.getElementById("ab-" + p.id);
  if (!ab) return;
  ab.addEventListener("mouseup", () => {
    const sel = window.getSelection();
    const text = sel.toString().trim();
    if (text.length < 3 || !ab.contains(sel.anchorNode)) return hidePop();
    showPop(sel.getRangeAt(0).getBoundingClientRect(), () => {
      Glean.addHighlight(p.id, text);
      sel.removeAllRanges();
      Glean.render();
    });
  });
}

function renderHls(pid) {
  const wrap = document.getElementById("hls-" + pid);
  if (!wrap) return;
  const hls = Glean.highlightsFor(pid);
  wrap.innerHTML = hls.map((h) =>
    `<div class="d-hl">${esc(h.text)}<span class="x" data-id="${h.id}">✕</span></div>`).join("");
  wrap.querySelectorAll(".x").forEach((x) =>
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      Glean.deleteHighlight(x.dataset.id);
      Glean.render();
    }));
}

function markUp(text, hls) {
  const spans = hls.map((h) => ({ s: text.indexOf(h.text), l: h.text.length }))
    .filter((x) => x.s >= 0).sort((a, b) => a.s - b.s);
  let out = "", cur = 0;
  for (const sp of spans) {
    if (sp.s < cur) continue;
    out += esc(text.slice(cur, sp.s)) + "<mark>" + esc(text.slice(sp.s, sp.s + sp.l)) + "</mark>";
    cur = sp.s + sp.l;
  }
  return out + esc(text.slice(cur));
}

/* floating highlight pill */
let pop;
function showPop(rect, onClick) {
  hidePop();
  pop = document.createElement("div");
  pop.className = "hl-pop";
  pop.textContent = "✎ highlight";
  pop.style.display = "block";
  pop.style.left = rect.left + rect.width / 2 - 40 + "px";
  pop.style.top = rect.top - 34 + "px";
  pop.addEventListener("mousedown", (e) => { e.preventDefault(); onClick(); hidePop(); });
  document.body.appendChild(pop);
}
function hidePop() { if (pop) { pop.remove(); pop = null; } }
document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target)) hidePop(); });

/* ---------- headers / sort ---------- */
function updateHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const col = th.dataset.sort;
    const base = th.dataset.label || (th.dataset.label = th.textContent.trim());
    if (Glean.view.sort === col) {
      th.innerHTML = base + `<span class="caret">${Glean.view.dir === "asc" ? "↑" : "↓"}</span>`;
    } else {
      th.innerHTML = base;
    }
  });
}
function initHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.dataset.label = th.textContent.trim();
    th.addEventListener("click", () => {
      const col = th.dataset.sort, v = Glean.view;
      if (v.sort !== col) { v.sort = col; v.dir = "desc"; }
      else if (v.dir === "desc") v.dir = "asc";
      else { v.sort = "rating"; v.dir = "desc"; } // cycle off → default
      writeURL();
      Glean.render();
    });
  });
}

/* ---------- threads ---------- */
function renderThreads() {
  const sec = document.getElementById("threads");
  const threads = Glean.state.threads;
  sec.hidden = !threads.length;
  if (!threads.length) return;
  document.getElementById("threads-count").textContent = `(${threads.length})`;
  const open = Glean.view.threads;
  document.getElementById("threads-caret").textContent = open ? "▾" : "▸";
  document.getElementById("threads-toggle").setAttribute("aria-expanded", open);
  const body = document.getElementById("threads-body");
  body.hidden = !open;
  if (open) {
    body.innerHTML = threads.map((t) => `
      <div class="thread">
        <h4>${esc(t.name)}</h4>
        <div class="t-summary">${esc(t.summary)}</div>
        ${t.gaps && t.gaps.length ? `<div class="t-gaps"><b>gaps:</b> ${t.gaps.map(esc).join(" · ")}</div>` : ""}
      </div>`).join("");
  }
}

/* ---------- meta ---------- */
function renderMeta(shown) {
  const s = Glean.state;
  const rated = Object.keys(Glean.ratings()).length;
  document.getElementById("meta").innerHTML =
    `${shown} shown<span class="sep">·</span>${s.papers.length} papers` +
    `<span class="sep">·</span>${rated} rated` +
    `<span class="sep">·</span>${Glean.highlights().length} highlights`;
}

Glean.updateStats = function () { renderMeta(visiblePapers().length); };

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
Glean.toast = function (msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
};
Glean.esc = esc;

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  readURL();
  initHeaders();

  const search = document.getElementById("search");
  search.value = Glean.view.q;
  search.addEventListener("input", () => {
    Glean.view.q = search.value.trim();
    writeURL();
    Glean.render();
  });

  document.getElementById("threads-toggle").addEventListener("click", () => {
    Glean.view.threads = !Glean.view.threads;
    writeURL();
    renderThreads();
  });

  Glean.initAdd(); // add box + token (add.js)

  await Glean.loadData();
  Glean.render();
});
