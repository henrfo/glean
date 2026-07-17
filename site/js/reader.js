/* reader.js — paper reader panel + in-browser highlighting.
 * Highlights are the atomic unit: select text in the abstract → save it (with an
 * optional note) to localStorage. Export later writes them to data/highlights.json.
 */
(function () {
  let currentId = null;
  let toolbar = null;

  Glean.openReader = function (paperId) {
    const p = Glean.state.byId[paperId];
    if (!p) return;
    currentId = paperId;
    const panel = document.getElementById("reader");
    panel.hidden = false;
    render(p);
  };

  Glean.closeReader = function () {
    currentId = null;
    document.getElementById("reader").hidden = true;
    hideToolbar();
  };

  // Re-render the open paper (e.g. after import) without changing selection.
  Glean.openReaderRefresh = function () {
    if (currentId) Glean.openReader(currentId);
  };

  function render(p) {
    const body = document.getElementById("reader-body");
    const esc = Glean.esc;
    const highlights = Glean.highlightsFor(p.id);

    body.innerHTML = `
      <h3>${esc(p.title)}</h3>
      <div class="r-meta">
        ${esc((p.authors || []).join(", "))}${p.year ? " · " + p.year : ""}
        ${p.venue ? " · " + esc(p.venue) : ""}
      </div>
      <div class="r-actions">
        <a class="r-link" href="${esc(p.url)}" target="_blank" rel="noopener">Open full text ↗</a>
      </div>
      <div class="r-abstract" id="r-abstract">${
        p.abstract ? markUp(p.abstract, highlights) : "<em>No abstract available.</em>"
      }</div>
      <div class="hl-list">
        <h4>Highlights (${highlights.length})</h4>
        <div id="hl-items"></div>
      </div>`;

    renderHighlightList(p.id);
    attachSelection();
  }

  // Wrap any saved highlight substrings in <mark>, escaping the rest.
  function markUp(text, highlights) {
    const spans = highlights
      .map((h) => ({ start: text.indexOf(h.text), len: h.text.length }))
      .filter((s) => s.start >= 0)
      .sort((a, b) => a.start - b.start);

    let out = "";
    let cursor = 0;
    for (const s of spans) {
      if (s.start < cursor) continue; // skip overlaps
      out += Glean.esc(text.slice(cursor, s.start));
      out += `<mark>${Glean.esc(text.slice(s.start, s.start + s.len))}</mark>`;
      cursor = s.start + s.len;
    }
    out += Glean.esc(text.slice(cursor));
    return out;
  }

  function renderHighlightList(paperId) {
    const wrap = document.getElementById("hl-items");
    const highlights = Glean.highlightsFor(paperId);
    if (!highlights.length) {
      wrap.innerHTML = `<div class="hint">Select text in the abstract to highlight it.</div>`;
      return;
    }
    wrap.innerHTML = "";
    for (const h of highlights) {
      const item = document.createElement("div");
      item.className = "hl-item";
      item.innerHTML = `
        <button class="hl-del" title="Delete">×</button>
        <div class="hl-text">${Glean.esc(h.text)}</div>
        ${h.note ? `<div class="hl-note">${Glean.esc(h.note)}</div>` : ""}`;
      item.querySelector(".hl-del").addEventListener("click", () => {
        Glean.deleteHighlight(h.id);
        Glean.openReaderRefresh();
      });
      wrap.appendChild(item);
    }
  }

  /* ---------- selection → floating highlight button ---------- */
  function attachSelection() {
    const abstract = document.getElementById("r-abstract");
    if (!abstract) return;
    abstract.addEventListener("mouseup", () => {
      const sel = window.getSelection();
      const text = sel.toString().trim();
      if (text.length < 3 || !abstract.contains(sel.anchorNode)) {
        hideToolbar();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      showToolbar(rect, text);
    });
  }

  function showToolbar(rect, text) {
    hideToolbar();
    toolbar = document.createElement("div");
    toolbar.className = "hl-toolbar";
    toolbar.style.display = "block";
    toolbar.style.left = `${rect.left + rect.width / 2 - 45}px`;
    toolbar.style.top = `${rect.top - 40 + window.scrollY}px`;
    toolbar.innerHTML = `<button>✎ Highlight</button>`;
    toolbar.querySelector("button").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const note = prompt("Add a note (optional):", "") || "";
      Glean.addHighlight(currentId, text, note);
      hideToolbar();
      window.getSelection().removeAllRanges();
      Glean.openReaderRefresh();
    });
    document.body.appendChild(toolbar);
  }

  function hideToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  }

  document.addEventListener("mousedown", (e) => {
    if (toolbar && !toolbar.contains(e.target)) hideToolbar();
  });
})();
