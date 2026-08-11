import { useEffect, useMemo, useRef, useState } from "react";
import CytoscapeComponent from "react-cytoscapejs";
import type cytoscape from "cytoscape";
import { api, type Direction, type Snippet, type TraceResponse } from "../api";
import { Card, EmptyState, ErrorBanner, Spinner } from "../components/ui";
import { startAliveGraph } from "../lib/aliveGraph";

const ACCENT = "#7c5cff";
const NODE = "#3b9eff";
const EDGE = "#5b5d6b";
const SIGNAL = "#7dd3fc";

const STYLESHEET: cytoscape.StylesheetStyle[] = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-size": 9,
      "font-family": "ui-monospace, monospace",
      color: "#c9cad6",
      "text-valign": "bottom",
      "text-margin-y": 4,
      "background-color": NODE,
      width: 22,
      height: 22,
      "border-width": 2,
      "border-color": "#0f1015",
      "underlay-color": NODE,
      "underlay-shape": "ellipse",
      "underlay-opacity": 0.15,
      "underlay-padding": 4,
    },
  },
  {
    selector: "node.root",
    style: {
      "background-color": ACCENT,
      width: 32,
      height: 32,
      "font-size": 11,
      "font-weight": "bold",
      color: "#eceef4",
      "underlay-color": ACCENT,
      "underlay-opacity": 0.25,
      "underlay-padding": 8,
    },
  },
  {
    selector: "node.selected",
    style: { "border-color": ACCENT, "border-width": 3 },
  },
  {
    selector: "node.signal",
    style: {
      "background-color": SIGNAL,
      width: 7,
      height: 7,
      "border-width": 0,
      label: "",
      "underlay-color": SIGNAL,
      "underlay-opacity": 0.9,
      "underlay-padding": 6,
      "z-index": 999,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": EDGE,
      "target-arrow-color": EDGE,
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
      opacity: 0.7,
      "line-style": "dashed",
      "line-dash-pattern": [5, 4],
    },
  },
];

function shortLabel(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  return parts.length > 1 ? parts.slice(-2).join(".") : qualifiedName;
}

export function GraphView({ project, target }: { project: string; target: { symbol: string; file?: string } | null }) {
  const [current, setCurrent] = useState<{ symbol: string; file?: string } | null>(target);
  const [direction, setDirection] = useState<Direction>("both");
  const [depth, setDepth] = useState(3);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [snippet, setSnippet] = useState<Snippet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const aliveStopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (target) setCurrent(target);
  }, [target]);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    setError(null);
    api
      .trace(project, current.symbol, direction, depth, current.file)
      .then(setTrace)
      .catch((err) => {
        setError(err.message);
        setTrace(null);
      })
      .finally(() => setLoading(false));
    api
      .snippet(project, current.symbol, current.file)
      .then(setSnippet)
      .catch(() => setSnippet(null));
  }, [project, current, direction, depth]);

  const elements = useMemo(() => {
    if (!trace) return [];
    const nodeIds = new Set<string>([trace.root]);
    const edges: { source: string; target: string }[] = [];
    // callers edges are {from: expanded_node, to: caller} -- the real call
    // direction is caller -> expanded_node, i.e. the reverse of from/to here.
    for (const e of trace.callers ?? []) {
      nodeIds.add(e.from);
      nodeIds.add(e.to);
      edges.push({ source: e.to, target: e.from });
    }
    // callees edges are {from: expanded_node, to: callee} and already match
    // real call direction (expanded_node calls callee).
    for (const e of trace.callees ?? []) {
      nodeIds.add(e.from);
      nodeIds.add(e.to);
      edges.push({ source: e.from, target: e.to });
    }
    const nodes = [...nodeIds].map((id) => ({
      data: { id, label: shortLabel(id) },
      classes: id === trace.root ? "root" : "",
    }));
    return [...nodes, ...edges.map((e) => ({ data: { id: `${e.source}->${e.target}`, ...e } }))];
  }, [trace]);

  useEffect(() => {
    aliveStopRef.current?.();
    aliveStopRef.current = null;
    const cy = cyRef.current;
    if (!cy || elements.length === 0) return;
    cy.layout({ name: "cose", animate: false, fit: true, padding: 30 } as cytoscape.LayoutOptions).run();
    aliveStopRef.current = startAliveGraph(cy);
    return () => {
      aliveStopRef.current?.();
      aliveStopRef.current = null;
    };
  }, [elements]);

  if (!current) {
    return <EmptyState>Search for a symbol, or open one from Changes, to see its call graph.</EmptyState>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="!p-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5">
          <span className="mono truncate text-sm font-medium">{current.symbol}</span>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as Direction)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs"
            >
              <option value="both">callers + callees</option>
              <option value="callers">callers only</option>
              <option value="callees">callees only</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              depth
              <input
                type="range"
                min={1}
                max={10}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="w-16 accent-[var(--accent)]"
              />
              {depth}
            </label>
          </div>
        </div>

        {error && (
          <div className="p-4">
            <ErrorBanner message={error} />
          </div>
        )}
        {loading && !trace && (
          <div className="p-4">
            <Spinner />
          </div>
        )}

        {trace && (
          <>
            <CytoscapeComponent
              elements={CytoscapeComponent.normalizeElements(elements)}
              stylesheet={STYLESHEET}
              style={{ width: "100%", height: "480px", background: "radial-gradient(ellipse at center, rgba(124,92,255,0.06), transparent 70%)" }}
              cy={(cy) => {
                cyRef.current = cy;
                cy.off("tap", "node");
                cy.on("tap", "node", (evt) => {
                  if (evt.target.hasClass("signal")) return;
                  const id = evt.target.id();
                  setCurrent({ symbol: id });
                });
              }}
            />
            <div className="space-y-1 border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
              {trace.callers_caveat && <p>{trace.callers_caveat}</p>}
              {trace.callers_truncated && <p>Caller graph truncated at 150 nodes.</p>}
              {trace.callees_truncated && <p>Callee graph truncated at 150 nodes.</p>}
              {!!trace.callees_unresolved?.length && (
                <p className="truncate">
                  Unresolved callees: <span className="mono">{trace.callees_unresolved.join(", ")}</span>
                </p>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="Source">
        {snippet ? (
          <div className="space-y-2">
            <p className="mono truncate text-xs text-[var(--text-muted)]">
              {snippet.file}:{snippet.start_line}-{snippet.end_line}
            </p>
            <pre className="mono max-h-[420px] overflow-auto rounded-lg bg-[var(--surface-2)] p-3 text-[11px] leading-relaxed">
              {snippet.source}
            </pre>
          </div>
        ) : (
          <EmptyState>No source available.</EmptyState>
        )}
      </Card>
    </div>
  );
}
