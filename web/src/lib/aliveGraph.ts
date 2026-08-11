import type cytoscape from "cytoscape";

// Ambient "neural network" animation for the call graph: edges carry a
// flowing current (animated dash offset), nodes breathe with a soft glow
// (underlay pulse, phase-shifted per node so they don't sync up), and every
// so often a bright signal travels along a random edge -- meant to read as
// activity propagating through the graph, not just a static diagram.
//
// Single setInterval driving batched style writes, rather than one
// cy.animate() chain per node/edge -- cheap even at ~150 nodes (the server's
// own cap on trace_calls), and trivial to tear down (one flag + one list of
// spawned signal-node ids to remove).

const TICK_MS = 50;
const DASH_SPEED = 0.9; // px per tick
const SIGNAL_MIN_GAP_MS = 350;
const SIGNAL_MAX_GAP_MS = 900;
const SIGNAL_DURATION_MS = 650;

export function startAliveGraph(cy: cytoscape.Core): () => void {
  let stopped = false;
  let dashOffset = 0;
  let nextSignalAt = performance.now() + SIGNAL_MIN_GAP_MS;
  const liveSignals = new Set<cytoscape.NodeSingular>();
  const phase = new Map<string, number>();
  cy.nodes().forEach((n) => {
    phase.set(n.id(), Math.random() * Math.PI * 2);
  });

  function fireSignal() {
    const edges = cy.edges();
    if (edges.length === 0) return;
    const edge = edges[Math.floor(Math.random() * edges.length)];
    const from = edge.source().position();
    const to = edge.target().position();
    const dot = cy.add({
      group: "nodes",
      classes: "signal",
      data: { id: `signal-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      position: { x: from.x, y: from.y },
    });
    dot.style("events", "no");
    liveSignals.add(dot);
    dot.animate(
      { position: { x: to.x, y: to.y } },
      {
        duration: SIGNAL_DURATION_MS,
        easing: "ease-in-out",
        complete: () => {
          liveSignals.delete(dot);
          dot.remove();
        },
      },
    );
  }

  const interval = setInterval(() => {
    if (stopped) return;
    dashOffset -= DASH_SPEED;
    const t = performance.now();
    cy.batch(() => {
      cy.edges().style("line-dash-offset", dashOffset);
      cy.nodes().forEach((n) => {
        if (n.hasClass("signal")) return;
        const p = phase.get(n.id()) ?? 0;
        const s = (Math.sin(t / 850 + p) + 1) / 2; // 0..1
        n.style("underlay-opacity", 0.12 + s * 0.38);
        n.style("underlay-padding", 3 + s * 5);
      });
    });
    if (t >= nextSignalAt) {
      fireSignal();
      nextSignalAt = t + SIGNAL_MIN_GAP_MS + Math.random() * (SIGNAL_MAX_GAP_MS - SIGNAL_MIN_GAP_MS);
    }
  }, TICK_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    for (const dot of liveSignals) dot.remove();
    liveSignals.clear();
  };
}
