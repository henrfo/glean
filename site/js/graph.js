/* graph.js — d3-force citation graph (Layer 1: the automated paper graph).
 * Seed papers glow, node radius encodes relevance, click a node to open the reader.
 */
(function () {
  let rendered = false;

  Glean.renderGraph = function () {
    const svgEl = document.getElementById("graph-svg");
    // Render once; d3 sim is expensive and layout should persist across tab switches.
    if (rendered) return;
    rendered = true;

    const papers = Glean.state.papers;
    if (!papers.length) {
      svgEl.outerHTML = `<div class="empty" id="graph-svg">No graph yet — run the fetch pipeline.</div>`;
      return;
    }

    const byId = Glean.state.byId;
    const nodes = papers.map((p) => ({
      id: p.id,
      title: p.title,
      seed: !!p.is_seed,
      score: p.relevance_score || 0,
    }));
    // Keep only edges whose endpoints both exist in the corpus.
    const links = Glean.state.edges
      .filter((e) => byId[e.source] && byId[e.target])
      .map((e) => ({ source: e.source, target: e.target }));

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const rect = svgEl.getBoundingClientRect();
    const width = rect.width || 900;
    const height = rect.height || 600;

    const container = svg.append("g");
    svg.call(
      d3.zoom().scaleExtent([0.2, 4]).on("zoom", (ev) =>
        container.attr("transform", ev.transform))
    );

    const radius = (d) => 4 + (d.seed ? 8 : 0) + d.score * 10;

    const sim = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink(links).id((d) => d.id).distance(60).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-90))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius((d) => radius(d) + 3));

    const link = container
      .append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "link");

    const node = container
      .append("g")
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "node")
      .attr("r", radius)
      .attr("fill", (d) => (d.seed ? "#f7c873" : "#7aa2f7"))
      .attr("stroke", (d) => (d.seed ? "#f7c873" : "none"))
      .attr("stroke-width", (d) => (d.seed ? 3 : 0))
      .attr("stroke-opacity", 0.35)
      .call(drag(sim))
      .on("click", (_, d) => Glean.openReader(d.id));

    node.append("title").text((d) => d.title);

    // Labels only for the most relevant nodes, to keep it readable.
    const labeled = nodes.filter((d) => d.seed || d.score > 0.5);
    const label = container
      .append("g")
      .selectAll("text")
      .data(labeled)
      .join("text")
      .attr("class", "node-label")
      .text((d) => (d.title.length > 34 ? d.title.slice(0, 34) + "…" : d.title));

    sim.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
      label.attr("x", (d) => d.x + radius(d) + 3).attr("y", (d) => d.y + 3);
    });
  };

  function drag(sim) {
    return d3
      .drag()
      .on("start", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => {
        if (!ev.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
      });
  }
})();
