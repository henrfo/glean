/* gh.js — GitHub-backed persistence for Glean.
 *
 * Everything you do in the browser (add a paper, rate, highlight) is saved by
 * committing a small JSON file straight to your repo via the GitHub API, using a
 * fine-grained token you paste once (kept in localStorage, never sent anywhere but
 * github.com). No backend, no manual export. Committing to data/ triggers the
 * Actions workflow, which fetches/scores and redeploys the site.
 */
(function () {
  const TOKEN_KEY = "glean.gh_token";

  // Derive owner/repo from the Pages URL (henrfo.github.io/glean), else fall back.
  function repoConfig() {
    const host = location.hostname; // e.g. henrfo.github.io
    const owner = host.endsWith(".github.io") ? host.split(".")[0] : "henrfo";
    const seg = location.pathname.split("/").filter(Boolean)[0];
    const repo = owner && seg && host.endsWith(".github.io") ? seg : "glean";
    return { owner, repo, branch: "main" };
  }

  const gh = (Glean.gh = {
    ...repoConfig(),

    getToken() { return localStorage.getItem(TOKEN_KEY) || ""; },
    setToken(t) {
      if (t) localStorage.setItem(TOKEN_KEY, t.trim());
      else localStorage.removeItem(TOKEN_KEY);
    },
    hasToken() { return !!gh.getToken(); },

    _headers() {
      return {
        Authorization: `Bearer ${gh.getToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
    },

    async _contentsUrl(path) {
      return `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${path}`;
    },

    // Verify the token works and has access to this repo.
    async check() {
      const res = await fetch(
        `https://api.github.com/repos/${gh.owner}/${gh.repo}`,
        { headers: gh._headers() }
      );
      if (!res.ok) throw new Error(`token check failed (${res.status})`);
      const repo = await res.json();
      if (!repo.permissions || !repo.permissions.push) {
        throw new Error("token lacks write (contents) access to this repo");
      }
      return true;
    },

    // Read a JSON file from the repo → { json, sha } (sha null if absent).
    async getJSON(path) {
      const res = await fetch(await gh._contentsUrl(path) + `?ref=${gh.branch}`, {
        headers: gh._headers(),
        cache: "no-store",
      });
      if (res.status === 404) return { json: null, sha: null };
      if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
      const data = await res.json();
      return { json: JSON.parse(b64decode(data.content)), sha: data.sha };
    },

    // Write a JSON file (create or update) with a commit message.
    async putJSON(path, obj, message) {
      const { sha } = await gh.getJSON(path);
      const body = {
        message,
        content: b64encode(JSON.stringify(obj, null, 2) + "\n"),
        branch: gh.branch,
      };
      if (sha) body.sha = sha;
      const res = await fetch(await gh._contentsUrl(path), {
        method: "PUT",
        headers: gh._headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`PUT ${path} failed (${res.status}): ${t.slice(0, 140)}`);
      }
      return res.json();
    },

    // Read-modify-write a JSON array/object with a mutator; retries once on conflict.
    async updateJSON(path, mutate, message, fallback) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { json } = await gh.getJSON(path);
        const next = mutate(json ?? fallback);
        try {
          return await gh.putJSON(path, next, message);
        } catch (e) {
          if (attempt === 0 && String(e).includes("409")) continue; // sha race
          throw e;
        }
      }
    },
  });

  /* ---------- UTF-8 safe base64 ---------- */
  function b64encode(str) {
    return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
})();
