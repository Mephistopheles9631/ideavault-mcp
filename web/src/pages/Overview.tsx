import { useEffect, useMemo, useRef, useState } from "react";
import CytoscapeComponent from "react-cytoscapejs";
import type cytoscape from "cytoscape";
import { api, type ProjectGraphResponse } from "../api";
import { Card, EmptyState, ErrorBanner, Spinner, kindColor } from "../components/ui";
import { startAliveGraph } from "../lib/aliveGraph";

const EDGE = "#5b5d6b";
const MIN_NODE = 8;
const MAX_NODE = 26;

function shortLabel(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  return parts.length > 1 ? parts.slice(-2).join(".") : qualifiedName;
}

const STYLESHEET: cytoscape.StylesheetStyle[] = [
  {
    selector: "node.project-parent",
    style: {
      "background-color": "#1d1f29",
      "background-opacity": 0.5,
      "border-width": 1.5,
      "border-color": "#3a3d4d",
      "border-style": "dashed",
      shape: "round-rectangle",
      label: "data(label)",
      "text-valign": "top",
      "text-halign": "center",
      "text-margin-y": -6,
      "font-size": 12,
      "font-weight": "bold",
      color: "#c9cad6",
      "padding": "18px",
    },
  },
  {
    selector: "node.symbol",
    style: {
      label: "data(label)",
      "font-size": 8,
      "font-family": "ui-monospace, monospace",
      color: "#c9cad6",
      "text-valign": "bottom",
      "text-margin-y": 3,
      "background-color": "data(color)",
      width: "data(size)",
      height: "data(size)",
      "border-width": 1.5,
      "border-color": "#0f1015",
      "underlay-color": "data(color)",
      "underlay-shape": "ellipse",
      "underlay-opacity": 0.15,
      "underlay-padding": 3,
    },
  },
  {
    selector: "node.signal",
    style: {
      "background-color": "#7dd3fc",
      width: 6,
      height: 6,
      "border-width": 0,
      label: "",
      "underlay-color": "#7dd3fc",
      "underlay-opacity": 0.9,
      "underlay-padding": 5,
      "z-index": 999,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1,
      "line-color": EDGE,
      "target-arrow-color": EDGE,
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.6,
      "curve-style": "bezier",
      opacity: 0.6,
      "line-style": "dashed",
      "line-dash-pattern": [4, 3],
    },
  },
];

export function Overview({
  onSelectProjectSymbol,
  onFocusProject,
}: {
  onSelectProjectSymbol: (project: string, symbol: string, file?: string) => void;
  onFocusProject: (project: string) => void;
}) {
  const [perProject, setPerProject] = useState(20);
  const [graphs, setGraphs] = useState<ProjectGraphResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const aliveStopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .projects()
      .then(async (projects) => {
        const results = await Promise.allSettled(
          projects.map((p) => api.projectGraph(p.project, perProject)),
        );
        if (cancelled) return;
        const ok = results
          .filter((r): r is PromiseFulfilledResult<ProjectGraphResponse> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((g) => g.nodes.length > 0);
        setGraphs(ok);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [perProject]);

  const elements = useMemo(() => {
    if (!graphs) return [];
    const degrees = graphs.flatMap((g) => g.nodes.map((n) => n.degree));
    const maxDegree = Math.max(1, ...degrees);

    const parents = graphs.map((g) => ({
      data: { id: `proj:${g.project}`, label: g.project },
      classes: "project-parent",
    }));
    const nodes = graphs.flatMap((g) =>
      g.nodes.map((n) => ({
        data: {
          id: `${g.project}::${n.id}`,
          label: shortLabel(n.qualified_name),
          parent: `proj:${g.project}`,
          project: g.project,
          symbol: n.qualified_name,
          file: n.file,
          color: kindColor(n.kind),
          size: MIN_NODE + (n.degree / maxDegree) * (MAX_NODE - MIN_NODE),
        },
        classes: "symbol",
      })),
    );
    const edges = graphs.flatMap((g) =>
      g.edges.map((e) => ({
        data: { id: `${g.project}::${e.from}->${e.to}`, source: `${g.project}::${e.from}`, target: `${g.project}::${e.to}` },
      })),
    );
    return [...parents, ...nodes, ...edges];
  }, [graphs]);

  useEffect(() => {
    aliveStopRef.current?.();
    aliveStopRef.current = null;
    const cy = cyRef.current;
    if (!cy || elements.length === 0 || !graphs) return;

    // Core Cytoscape's cose layout handles compound (parent) nodes badly --
    // left alone it collapses every project into one illegible strip, and
    // running .layout() on a child-only sub-collection while a compound
    // parent exists crashes internally ("reading 'children' of undefined").
    // So: grid the projects into cells ourselves, and hand-place each
    // project's nodes as a hub-and-spoke wheel (highest-degree symbol --
    // already first, since the API returns nodes degree-sorted -- at the
    // center, the rest ringed around it). No layout() call, no crash, and a
    // hub node is a reasonable stand-in for "the shape of this project"
    // anyway.
    const cols = Math.max(1, Math.ceil(Math.sqrt(graphs.length)));
    const cellW = 900;
    const cellH = 700;
    const pad = 60;

    graphs.forEach((g, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = col * cellW + cellW / 2 + pad;
      const cy_ = row * cellH + cellH / 2 + pad;
      const projectNodes = cy.nodes(`[project = "${g.project}"]`);
      const n = projectNodes.length;
      const ringR = Math.min(cellW, cellH) / 2 - 100;
      projectNodes.forEach((node, idx) => {
        if (idx === 0 || n <= 1) {
          node.position({ x: cx, y: cy_ });
          return;
        }
        const angle = ((idx - 1) / (n - 1)) * 2 * Math.PI;
        node.position({ x: cx + Math.cos(angle) * ringR, y: cy_ + Math.sin(angle) * ringR });
      });
    });
    cy.fit(cy.elements(), 40);
    aliveStopRef.current = startAliveGraph(cy);
    return () => {
      aliveStopRef.current?.();
      aliveStopRef.current = null;
    };
  }, [elements, graphs]);

  const totalNodes = graphs?.reduce((sum, g) => sum + g.nodes.length, 0) ?? 0;
  const totalEdges = graphs?.reduce((sum, g) => sum + g.edges.length, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          {graphs ? `${graphs.length} projects · ${totalNodes} symbols · ${totalEdges} calls` : "Loading…"}
        </p>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          symbols/project
          <input
            type="range"
            min={5}
            max={60}
            value={perProject}
            onChange={(e) => setPerProject(Number(e.target.value))}
            className="w-24 accent-[var(--accent)]"
          />
          {perProject}
        </label>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading && !graphs && <Spinner />}

      {graphs && graphs.length === 0 && <EmptyState>No indexed projects with a call graph yet.</EmptyState>}

      {graphs && graphs.length > 0 && (
        <Card className="!p-0 overflow-hidden">
          <CytoscapeComponent
            elements={CytoscapeComponent.normalizeElements(elements)}
            stylesheet={STYLESHEET}
            style={{ width: "100%", height: "640px", background: "radial-gradient(ellipse at center, rgba(124,92,255,0.05), transparent 70%)" }}
            cy={(cy) => {
              cyRef.current = cy;
              cy.off("tap", "node");
              cy.on("tap", "node", (evt) => {
                const n = evt.target;
                if (n.hasClass("signal")) return;
                if (n.hasClass("project-parent")) {
                  onFocusProject(n.data("label"));
                  return;
                }
                onSelectProjectSymbol(n.data("project"), n.data("symbol"), n.data("file"));
              });
            }}
          />
        </Card>
      )}
    </div>
  );
}
