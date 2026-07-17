/* threads.js — Layer 2: your idea graph. Renders the LLM-clustered threads,
 * each with its position summary, the highlights it's built from, and any gaps.
 * Produced by scripts/summarize.py → data/threads.json.
 */
(function () {
  Glean.renderThreads = function () {
    const wrap = document.getElementById("threads-list");
    const threads = Glean.state.threads;
    const esc = Glean.esc;

    if (!threads.length) {
      wrap.innerHTML = `<div class="empty">
        No threads yet. Highlight passages while reading, Export your highlights.json,
        commit it, then run <code>python scripts/summarize.py</code>.
      </div>`;
      return;
    }

    // Index highlights by id so we can show the passages behind each thread.
    const hlById = Object.fromEntries(Glean.getHighlights().map((h) => [h.id, h]));

    wrap.innerHTML = "";
    for (const t of threads) {
      const el = document.createElement("div");
      el.className = "thread";

      const hlHtml = (t.highlight_ids || [])
        .map((id) => hlById[id])
        .filter(Boolean)
        .map((h) => `<div class="t-hl">${esc(h.text)}</div>`)
        .join("");

      const gapsHtml = (t.gaps && t.gaps.length)
        ? `<div class="t-gaps"><h4>Possible gaps</h4><ul>${
            t.gaps.map((g) => `<li>${esc(g)}</li>`).join("")
          }</ul></div>`
        : "";

      el.innerHTML = `
        <h3>${esc(t.name)}</h3>
        <div class="t-summary">${esc(t.summary)}</div>
        ${hlHtml ? `<div class="t-highlights">${hlHtml}</div>` : ""}
        ${gapsHtml}
        ${t.last_updated ? `<div class="r-meta" style="margin-top:10px">updated ${esc(t.last_updated)}</div>` : ""}`;
      wrap.appendChild(el);
    }
  };
})();
