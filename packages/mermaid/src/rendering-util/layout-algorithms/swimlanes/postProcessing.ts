// cspell:ignore ungated Hegemann Collinearly Kandinsky raykov Wybrow Helmers Eiglsperger Tamassia Battista Eades Tollis Fößmeier segs Gladisch
import type { LayoutData } from '../../types.js';
import { log } from '../../../logger.js';
import {
  clipEdgeEndpointsToNodeBoundaries,
  prepareEdgeEndpointsForRenderer,
} from './direction/endpointClip.js';
import { orthogonalizePolyline, simplifyPolyline } from './direction/geometry.js';
import { applyLrDirectionTransform } from './direction/lrTransform.js';
import { portSwapToLShape } from './direction/portSwap.js';
import { nudgeInteriorVerticalsFromObstacles } from './direction/obstacleNudging.js';
import { straightenStalePortOffsets } from './direction/stalePortOffsets.js';
import { collapseShortTerminalStub } from './direction/terminalStub.js';
import {
  collapseRedundantRectangularDoglegs,
  separateSharedRenderedTerminalLanes,
} from './direction/materializedGeometry.js';
import { simplifyDetouredEdges } from './direction/detourSimplification.js';
import { anchorLabelsToPolyline } from './direction/labelAnchoring.js';
import { resolveEdgeNodeIntersections } from './direction/nodeIntersections.js';
import { nudgeSharedInteriorSubpaths } from './direction/sharedTrackNudging.js';
export { validateSwimlanesLayout } from './direction/validation.js';
export type { ValidationIssue } from './direction/validation.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';

/**
 * Applies a post-layout coordinate transform for swimlane diagrams based on
 * the parsed diagram direction.
 *
 * Initial version:
 * - Only handles `LR` explicitly.
 * - Treats the existing coordinates as a canonical top-down (TB) layout where
 *   layers progress along Y and lanes are separated along X.
 * - For `LR`, we remap vertical layering (Y) to horizontal progression (X')
 *   and horizontal lane separation (X) to vertical position (Y').
 */
export function postProcessSwimlaneLayout(layout: LayoutData, direction?: string): void {
  // Two-part pipeline:
  //   (1) LR-specific coordinate rotation + lane restacking. Only runs for
  //       `direction === 'LR'`. Remaps layer-progression (Y) into
  //       horizontal progression (X') and lane separation (X) into
  //       vertical position (Y'), reserving a title band on the left.
  //   (2) Post-routing cleanup passes (orthogonalize / simplify /
  //       detour-bypass / sibling anti-crossing / label anchoring /
  //       stale-offset straightening / endpoint clip). These are
  //       direction-agnostic — they all operate on `edge.points` and
  //       `node.x/y` in whatever coordinate system the layout currently
  //       uses — and therefore must run for ALL directions. Historically
  //       they sat inside the LR gate which meant TD fixtures fell through
  //       to raw raykov output with no post-processing at all; iter 10
  //       ungated them so the full fix stack (iter 5 Strategy 1,
  //       iter 6 sibling side-split, iter 7 stale port-offset cleanup,
  //       iter 9 detour-bypass face-collision check) applies to TD too.
  const nodes = layout.nodes ?? [];
  const edges = layout.edges ?? [];
  const contentNodes = nodes.filter((n) => !n.isGroup);

  // ---------- (1) LR coordinate rotation ----------
  // Only rotates node positions and edge polylines for LR fixtures;
  // TB and friends fall through to the cleanup passes below unchanged.
  if (direction === 'LR' && contentNodes.length > 0 && !applyLrDirectionTransform(layout)) {
    return;
  }

  // ---------- (2) Post-routing cleanup passes (all directions) ----------
  // Everything below this line runs regardless of direction. It operates
  // on `edge.points` + `node.x/y` in whatever coordinate system the layout
  // currently uses, so the same cleanup stack applies to TB fixtures
  // (which just skipped the LR coordinate rotation above) as to LR
  // fixtures that just came through it.
  //
  // Historically this whole block was gated behind `direction === 'LR'`
  // — meaning TD fixtures fell through to raw raykov output with no
  // post-processing at all. Iter 10 ungated it so the full fix stack
  // (iter 5 Strategy 1, iter 6 sibling side-split, iter 7 stale
  // port-offset cleanup, iter 9 detour-bypass face-collision check)
  // applies to TD as well.

  // Strategy 1 (late-insertion): labels are never routing obstacles, and
  // they are placed onto the routed polyline post-hoc via
  // `anchorLabelsToPolyline`. The legacy `resolveLRLabelEdgeIntersections`
  // pass (which treated labels as obstacles to avoid after the TB→LR
  // transform) is therefore not called — labels have no stable position
  // until after anchoring.

  // General post-routing pass: detect and fix edges that pass through real
  // (non-label) nodes. Label nodes are excluded from the obstacle set
  // inside this pass because they are placed later.
  resolveEdgeNodeIntersections(layout);

  // First orthogonal cleanup pass: clean seams left by reroute splicing,
  // then collapse spikes and collinear intermediates.
  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length < 2) {
      continue;
    }
    (edge as { points: { x: number; y: number }[] }).points = simplifyPolyline(
      orthogonalizePolyline(pts)
    );
  }

  // Detour-bypass pass. If an edge ended up with 4+ bends to route around
  // a real-node obstacle, try every alternate source/destination port
  // side pair to see if a 1-2 bend orthogonal path exists that clears all
  // obstacles. If so, replace the polyline. This handles e.g. L_E_F_0 in
  // query-process which detours up-over-down around G at 4 bends, but
  // could route via E's top port + F's top port at 1 bend (clearing G
  // entirely because G's top is below E's top).
  simplifyDetouredEdges(edges as any[], nodes);

  // Co-route sibling straight-line rescue (iter 12). When
  // simplifyDetouredEdges leaves an edge as a 4-point U-detour AROUND
  // its destination's blocker but the direct port-to-port straight
  // line would have been geometrically clear — blocked only by a
  // single sibling's face claim — we rescue it here by port-shifting
  // along the shared face by MIN_PORT_SPACING/2 so the new straight
  // coexists with the blocker. Paper-backed: Hegemann-Wolff (source
  // b65b3d45) §4.2 / Fig. 11 — joint-feasibility via port distribution
  // rather than face exclusion. Scoped strictly to the 4-point
  // detour-around-a-collinear-blocker shape to keep blast radius
  // minimal: no other edge shape or pipeline phase is touched.
  coRouteSiblingsOnSharedFace(edges as any[], nodes);

  // Port-swap L-shape pass (iter 17). When an edge ends up as a 4-point
  // H-V-H / V-H-V detour whose first segment exits src on a face PARALLEL
  // to the incoming rank direction ("straight-through" port choice),
  // swap the src port to the perpendicular face if that permits a 3-point
  // L-shape (strictly one fewer bend) to the EXISTING dst port, without
  // introducing crossings, node collisions, collinear-axis overlaps, or
  // face-capacity violations. Paper-backed by Tamassia bend-minimization,
  // Siebenhaller §3.3 port assignment, Hegemann–Wolff §4.2
  // joint-feasibility. Scoped narrowly to 4-point non-collinear H-V-H /
  // V-H-V shape; the collinear 4-point case is owned by
  // coRouteSiblingsOnSharedFace (2-point straight), and 5+ point detours
  // are owned by simplifyDetouredEdges.
  portSwapToLShape(edges as any[], nodes);

  // Sibling-L-shape anti-crossing pass. Port distribution (iteration 2)
  // pushes sibling outgoing edges to different port offsets on the same
  // side of a node, but raykov's track assignment can place the two
  // verticals in the wrong relative order — producing an L-shape pair
  // whose vertical legs cross the other's horizontal leg. Previously this
  // was masked by the label-as-waypoint detour (iterations 1-4); with
  // Strategy 1's direct routing, the crossing becomes visible.
  //
  // Fix: for each pair of edges sharing a source node and both in the
  // 4-point L-shape topology, if their vertical legs' x-coordinates are
  // ordered INCONSISTENTLY with the port-side crossing check, swap them.
  // This is a purely local post-processing fix — not algorithmically
  // elegant but contains the regression to iteration 5 without opening
  // raykov's track assignment code.
  siblingLShapeAntiCrossing(edges as any[]);

  // Strategy 1 (diss.pdf §118): anchor each labelled edge's label node onto
  // a middle segment of its own routed polyline. Labels were not obstacles
  // during routing, so the polyline reflects the natural geometry between
  // A and B without any label-driven detours. The anchor pass selects a
  // middle segment, preferring the label's long-axis orientation, with
  // tie-break on longest. If no middle segment is long enough to host the
  // label, we manufacture one by inserting a two-bend step on the longest
  // candidate segment. After placement we re-check foreign-label/foreign-
  // node overlaps and retry on the next-best segment; capped to avoid
  // infinite loops.
  const nodeByIdMap = new Map<string, any>();
  for (const n of nodes) {
    nodeByIdMap.set(String(n.id), n);
  }
  anchorLabelsToPolyline(edges, nodeByIdMap);

  // cspell:ignore Hegemann Collinearly
  // Stale port-offset cleanup (iter 7). The Hegemann-Wolff paper
  // (source b65b3d45, Fig. 11b discussion) explicitly flags "Z-shaped
  // edges whose middle piece is short" as a post-processing cleanup
  // target. Our specific trigger: raykov's port distribution assigns
  // ±offsets when sibling edges land on the same node side, but
  // iter-5's `simplifyDetouredEdges` can later rewrite one of those
  // siblings to a different side entirely. The surviving sibling is
  // left with a stale port offset — a short perpendicular jog at the
  // polyline end whose sibling justification no longer exists.
  //
  // The cleanup scans 4-point polylines for an H-V-H / V-H-V pattern
  // where the middle segment is short (≤ JOG_MAX, matching raykov's
  // MAX_PORT_SPACING), and shifts one endpoint to collapse the jog.
  // Neighbor-alignment is preferred over node-center when a collinear
  // incident edge exists at the shared endpoint — this matches what
  // Hegemann-Wolff's full-nudging LP would achieve globally via
  // zero-separation constraints on same-path segments. This is a
  // local Mermaid proxy; the algorithmically correct long-term fix is
  // to thread `simplifyDetouredEdges`'s rewrite back into raykov's
  // port-distribution state (option C, not attempted in iter 7).
  straightenStalePortOffsets(edges, nodeByIdMap);

  clipEdgeEndpointsToNodeBoundaries(edges, nodeByIdMap);

  // Iter 16 short-terminal-stub collapse. When the endpoint clip above
  // snaps the final polyline point onto the dst boundary, any interior
  // "almost at boundary" penultimate turn becomes a very short terminal
  // stub (< arrow marker base length). The rendered arrowhead then
  // visually overlaps the penultimate segment and appears detached.
  //
  // User report (2026-04-16) on L_E_G_0 in 8-query-process-2: "the final
  // stretch … is vertical going upwards. It is so close to G that when
  // it tries to bend to the right to go into it, that actual section is
  // invisible." Concretely: penult vertical at x=G.left-5.52 followed by
  // 5.52u horizontal stub into G.left-center.
  //
  // Paper backing: Siebenhaller dissertation (NotebookLM src `21f7ca55`)
  // describes a bend-stretching post-pass that replaces tail-shape
  // patterns with straighter ones. Strictly the Kandinsky invariant
  // says first/last direction never changes; this pass *does* change
  // the last direction since it also re-targets the destination face
  // (L→N in the L_E_G_0 case). Precedent: `straightenStalePortOffsets`
  // already performs port-coordinate changes in a post-pass
  // (Hegemann-Wolff short-middle-piece cleanup, source `b65b3d45`);
  // this pass extends the same philosophy to the TERMINAL short-
  // piece case.
  //
  // Gated strictly: last segment must be < MIN_STUB, last and
  // penultimate must form an axis-aligned 90° corner, and the
  // shifted penultimate segment must not overlap any real-node rect,
  // sibling/foreign edge segment, label rect, or the src node.
  // Runs AFTER the endpoint clip so the "last point" is already
  // snapped to the dst face — its length reflects the post-clip
  // geometry.
  collapseShortTerminalStub(edges, nodeByIdMap);

  // Iter 17 Wybrow nudging. When an interior vertical segment of an edge's
  // polyline runs parallel to a large obstacle at < MIN_CLEARANCE (20u),
  // shift the segment toward the alley mid-line between the nearest
  // obstacles on its left and right (restricted to obstacles whose y-span
  // overlaps the segment's y-span). Paper backing:
  //   - Wybrow et al., "Orthogonal Connector Routing" §Nudging
  //     (NotebookLM src `e8804c93`): "desired position = middle of the
  //     alley" under ordering + non-crossing constraints, with horizontal
  //     and vertical passes computed independently and collinear segments
  //     first collapsed into maximal H/V runs.
  //   - Hegemann & Wolff, 2309.01671 §Routing-Graph Construction
  //     (src `b65b3d45`): channels are represented by their centre line.
  //   - Gladisch et al. `32fe421c`: formalises clearance as μ (minimum) +
  //     δ (safety gap) — parameters, not fixed constants.
  //
  // User report (2026-04-16) on L_I_K_0 in 6-legal-constr-sales: edge I→K
  // descends at x=566.43, just 5.15u left of J.left=571.58 for ~37u of J's
  // 150-high left face — "almost hugging".
  //
  // Gates (mirror Wybrow's ordering + non-crossing invariants and
  // collapseShortTerminalStub's safety scaffolding):
  //   (a) only interior verticals (indices 1..len-3); stubs preserved.
  //   (b) adjacent segments must be horizontal (no axis flip).
  //   (c) new vertical + both adjusted horizontals must not enter any
  //       real-node rect (excluding src/dst of the edge).
  //   (d) new segments must not cross any other edge's segment.
  //   (e) new segments must not hit any edge-label rect.
  // When gated out, the segment is left untouched.
  nudgeInteriorVerticalsFromObstacles(edges, nodeByIdMap);

  // Wybrow-style shared-track nudge. The router may legitimately bundle
  // connectors onto the same rail, but before rendering those coincident
  // middle rails must be separated into nearby parallel tracks. This pass
  // keeps endpoint stubs pinned and only offsets interior H/V segments whose
  // same-axis span overlaps another edge.
  nudgeSharedInteriorSubpaths(edges, nodeByIdMap);

  // Materialized-render terminal lane split. The raw layout can still look
  // valid while the renderer's endpoint clipping creates coincident first/last
  // stubs on a shared node face. Split those visible terminal rails before the
  // endpoint-duplication handoff pins them.
  separateSharedRenderedTerminalLanes(edges, nodeByIdMap);

  // Once terminal lanes have been separated, some earlier same-track detours
  // become unnecessary. Remove only provably redundant rectangular doglegs;
  // safety checks preserve obstacle clearance and the newly split lanes.
  collapseRedundantRectangularDoglegs(edges, nodeByIdMap);

  anchorLabelsToPolyline(edges, nodeByIdMap);

  prepareEdgeEndpointsForRenderer(edges, nodeByIdMap);

  log.debug(SWIMLANE_DIR_LOG_PREFIX, 'Applied LR direction transform to swimlanes', {
    contentNodeCount: contentNodes.length,
  });
}

const EPS = 1e-3;

/**
 * Post-routing fix for a specific class of crossings between sibling
 * L-shape edges. When two edges share a source node and both have the
 * 4-point shape [port, turnPoint, turnPoint, portIn] (one horizontal →
 * one vertical → one horizontal), port distribution can leave them with
 * vertical legs whose x-coordinates cross the other's horizontal legs.
 *
 * The test is geometric: given two L-shape edges from the same source
 * with port-y offsets (port_a above port_b), going in the same general
 * direction (both right, or both left), their vertical legs at track_a
 * and track_b do NOT cross iff:
 *
 * - If port direction is right: track_a is at least as far right as track_b.
 * - If port direction is left: track_a is at least as far left as track_b.
 *
 * When the order is wrong we swap track_a and track_b — which swaps each
 * edge's turn points without changing its endpoints, producing a valid
 * orthogonal path with the same number of bends but no crossing.
 */
function siblingLShapeAntiCrossing(edges: any[]): void {
  interface LShapeEdge {
    edge: any;
    pts: { x: number; y: number }[];
    src: string;
    portY: number; // y of first point (the port offset)
    portX: number; // x of first point
    trackX: number; // x of second and third point (the vertical leg)
    endPortY: number; // y of fourth point
    endPortX: number; // x of fourth point
    goesRight: boolean; // trackX > portX
  }
  const bySrc = new Map<string, LShapeEdge[]>();

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points as { x: number; y: number }[] | undefined;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const [p0, p1, p2, p3] = pts;
    // Must be horizontal → vertical → horizontal.
    const firstHoriz = Math.abs(p0.y - p1.y) < EPS && Math.abs(p0.x - p1.x) > EPS;
    const midVert = Math.abs(p1.x - p2.x) < EPS && Math.abs(p1.y - p2.y) > EPS;
    const lastHoriz = Math.abs(p2.y - p3.y) < EPS && Math.abs(p2.x - p3.x) > EPS;
    if (!firstHoriz || !midVert || !lastHoriz) {
      continue;
    }
    const src = edge.start as string | undefined;
    if (!src) {
      continue;
    }
    const entry: LShapeEdge = {
      edge,
      pts,
      src,
      portY: p0.y,
      portX: p0.x,
      trackX: p1.x,
      endPortX: p3.x,
      endPortY: p3.y,
      goesRight: p1.x > p0.x,
    };
    if (!bySrc.has(src)) {
      bySrc.set(src, []);
    }
    bySrc.get(src)!.push(entry);
  }

  const swapTracks = (a: LShapeEdge, b: LShapeEdge): void => {
    const aTrack = a.trackX;
    const bTrack = b.trackX;
    // Rewrite a's polyline to use bTrack and vice versa. The end point
    // coordinates don't change; only the turn-point x values.
    a.pts[1] = { x: bTrack, y: a.portY };
    a.pts[2] = { x: bTrack, y: a.endPortY };
    b.pts[1] = { x: aTrack, y: b.portY };
    b.pts[2] = { x: aTrack, y: b.endPortY };
    a.trackX = bTrack;
    b.trackX = aTrack;
    (a.edge as { points: { x: number; y: number }[] }).points = a.pts;
    (b.edge as { points: { x: number; y: number }[] }).points = b.pts;
    log.debug(
      SWIMLANE_DIR_LOG_PREFIX,
      `siblingLShapeAntiCrossing: swapped tracks for ${a.edge.id} (${aTrack}→${bTrack}) and ${b.edge.id} (${bTrack}→${aTrack})`
    );
  };

  for (const group of bySrc.values()) {
    if (group.length < 2) {
      continue;
    }
    // Consider all pairs. Because the group is small (<=4 in practice),
    // this is O(n²) with tiny n.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.goesRight !== b.goesRight) {
          continue;
        }
        // Order a as upper (smaller port y), b as lower.
        const upper = a.portY <= b.portY ? a : b;
        const lower = upper === a ? b : a;
        // Does upper's vertical leg cross lower's horizontal leg?
        // Upper vertical: x=upper.trackX, y=[min(upper.portY, upper.endPortY), max(...)]
        // Lower first horizontal: y=lower.portY, x=[min(lower.portX, lower.trackX), max(...)]
        const upVertMinY = Math.min(upper.portY, upper.endPortY);
        const upVertMaxY = Math.max(upper.portY, upper.endPortY);
        const loHorizMinX = Math.min(lower.portX, lower.trackX);
        const loHorizMaxX = Math.max(lower.portX, lower.trackX);
        const crosses =
          upper.trackX > loHorizMinX + EPS &&
          upper.trackX < loHorizMaxX - EPS &&
          lower.portY > upVertMinY + EPS &&
          lower.portY < upVertMaxY - EPS;
        if (crosses) {
          swapTracks(a, b);
        }
      }
    }
  }
}

/**
 * Iter 12 — co-route sibling straight-line rescue.
 *
 * Fires only on the narrow "4-point U-detour around a collinear blocker
 * where the obvious straight line is geometrically clear" shape. For each
 * eligible edge, shifts the source and destination attach points by
 * MIN_PORT_SPACING/2 along the shared face and replaces the polyline
 * with a 2-point straight line. The shift direction is chosen by trying
 * both +delta and -delta and picking whichever doesn't introduce a new
 * edge crossing or leave the node's face span.
 *
 * Paper backing: Hegemann & Wolff "On the smoothing of orthogonal
 * connector layouts" (NotebookLM src b65b3d45) §4.2 / Fig. 11 —
 * joint-feasibility via port distribution rather than face exclusion.
 * Mermaid-specific narrowing: we only rescue the exact 4-point shape to
 * minimize blast radius.
 */
function coRouteSiblingsOnSharedFace(edges: any[], nodes: any[]): void {
  const EPS = 1e-6;
  const MIN_PORT_SPACING = 8;
  const PORT_SHIFT = MIN_PORT_SPACING / 2;

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  interface NodeInfo {
    id: string;
    cx: number;
    cy: number;
    rect: RectLite;
  }

  const nodeInfoById = new Map<string, NodeInfo>();
  const realNodeRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodes) {
    if ((n as { isGroup?: boolean }).isGroup) {
      continue;
    }
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const id = String((n as { id?: string }).id ?? '');
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    nodeInfoById.set(id, { id, cx, cy, rect });
    realNodeRects.push({ id, rect });
  }

  const segmentHitsNode = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    excludeIds: string[]
  ): boolean => {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    for (const n of realNodeRects) {
      if (excludeIds.includes(n.id)) {
        continue;
      }
      if (
        maxX > n.rect.left + 1 &&
        minX < n.rect.right - 1 &&
        maxY > n.rect.top + 1 &&
        minY < n.rect.bottom - 1
      ) {
        return true;
      }
    }
    return false;
  };

  // True if orthogonal segments s1 (from a1→b1) and s2 (from a2→b2)
  // cross at a point that is NOT a shared endpoint of both. Matches
  // the semantics of scoreLayout.segmentsCross — T-intersections count.
  const segmentsCrossOrth = (
    a1: { x: number; y: number },
    b1: { x: number; y: number },
    a2: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const s1H = Math.abs(a1.y - b1.y) < EPS;
    const s1V = Math.abs(a1.x - b1.x) < EPS;
    const s2H = Math.abs(a2.y - b2.y) < EPS;
    const s2V = Math.abs(a2.x - b2.x) < EPS;
    if ((s1H && s2H) || (s1V && s2V)) {
      return false;
    }
    if (!(s1H || s1V) || !(s2H || s2V)) {
      return false;
    }
    const horiz = s1H ? { a: a1, b: b1 } : { a: a2, b: b2 };
    const vert = s1V ? { a: a1, b: b1 } : { a: a2, b: b2 };
    const hY = horiz.a.y;
    const hX1 = Math.min(horiz.a.x, horiz.b.x);
    const hX2 = Math.max(horiz.a.x, horiz.b.x);
    const vX = vert.a.x;
    const vY1 = Math.min(vert.a.y, vert.b.y);
    const vY2 = Math.max(vert.a.y, vert.b.y);
    if (vX < hX1 || vX > hX2 || hY < vY1 || hY > vY2) {
      return false;
    }
    const ix = vX;
    const iy = hY;
    const TOL = 1e-6;
    const matchesHorizEndpoint =
      (Math.abs(ix - horiz.a.x) < TOL && Math.abs(iy - horiz.a.y) < TOL) ||
      (Math.abs(ix - horiz.b.x) < TOL && Math.abs(iy - horiz.b.y) < TOL);
    const matchesVertEndpoint =
      (Math.abs(ix - vert.a.x) < TOL && Math.abs(iy - vert.a.y) < TOL) ||
      (Math.abs(ix - vert.b.x) < TOL && Math.abs(iy - vert.b.y) < TOL);
    if (matchesHorizEndpoint && matchesVertEndpoint) {
      return false;
    }
    return true;
  };

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const [p0, p1, p2, p3] = pts;
    // Shape: H-V-H or V-H-V only.
    const seg01H = Math.abs(p0.y - p1.y) < EPS && Math.abs(p0.x - p1.x) > EPS;
    const seg12V = Math.abs(p1.x - p2.x) < EPS && Math.abs(p1.y - p2.y) > EPS;
    const seg23H = Math.abs(p2.y - p3.y) < EPS && Math.abs(p2.x - p3.x) > EPS;
    const seg01V = Math.abs(p0.x - p1.x) < EPS && Math.abs(p0.y - p1.y) > EPS;
    const seg12H = Math.abs(p1.y - p2.y) < EPS && Math.abs(p1.x - p2.x) > EPS;
    const seg23V = Math.abs(p2.x - p3.x) < EPS && Math.abs(p2.y - p3.y) > EPS;
    const isHVH = seg01H && seg12V && seg23H;
    const isVHV = seg01V && seg12H && seg23V;
    if (!isHVH && !isVHV) {
      continue;
    }

    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const edgeId = String((edge as { id?: string }).id ?? '');
    if (!srcId || !dstId) {
      continue;
    }
    const srcInfo = nodeInfoById.get(srcId);
    const dstInfo = nodeInfoById.get(dstId);
    if (!srcInfo || !dstInfo) {
      continue;
    }

    // Require src and dst centers collinear on one axis — the obvious
    // straight line candidate.
    const collinearX = Math.abs(srcInfo.cx - dstInfo.cx) < EPS;
    const collinearY = Math.abs(srcInfo.cy - dstInfo.cy) < EPS;
    if (collinearX === collinearY) {
      continue;
    }

    let targetSrc: { x: number; y: number };
    let targetDst: { x: number; y: number };
    if (collinearX) {
      const dstBelow = dstInfo.cy > srcInfo.cy;
      targetSrc = { x: srcInfo.cx, y: dstBelow ? srcInfo.rect.bottom : srcInfo.rect.top };
      targetDst = { x: dstInfo.cx, y: dstBelow ? dstInfo.rect.top : dstInfo.rect.bottom };
    } else {
      const dstEast = dstInfo.cx > srcInfo.cx;
      targetSrc = { x: dstEast ? srcInfo.rect.right : srcInfo.rect.left, y: srcInfo.cy };
      targetDst = { x: dstEast ? dstInfo.rect.left : dstInfo.rect.right, y: dstInfo.cy };
    }

    // The rescue only applies when the geometric straight line is
    // actually clear — otherwise the current U-detour is justified by
    // real obstacles and simplifyDetouredEdges already made the right
    // call.
    if (segmentHitsNode(targetSrc, targetDst, [srcId, dstId])) {
      continue;
    }

    // Try the centered straight line first (Kandinsky κ-th-fine-grid-line
    // invariant, Siebenhaller dissertation §2.3.2.1, NotebookLM src
    // 0fb2d84f: *"straight-line edges are centered at the corresponding
    // vertex side"*), then fall back to ±PORT_SHIFT if the center
    // collinearly overlaps a sibling's segment on the same axis.
    // Previously (iter 12) the deltas were [PORT_SHIFT, -PORT_SHIFT] with
    // no 0-shift trial; iter 15 prepends 0 and adds the collinear-overlap
    // check so the 5-car L_D_H_0 case (where L_D_E_0's centered straight
    // sits on D.cx and rules out the center for L_D_H_0) still falls
    // through to +PORT_SHIFT as before.
    const deltas = [0, PORT_SHIFT, -PORT_SHIFT];
    for (const delta of deltas) {
      const shiftedSrc = { ...targetSrc };
      const shiftedDst = { ...targetDst };
      if (collinearX) {
        shiftedSrc.x += delta;
        shiftedDst.x += delta;
        if (shiftedSrc.x <= srcInfo.rect.left || shiftedSrc.x >= srcInfo.rect.right) {
          continue;
        }
        if (shiftedDst.x <= dstInfo.rect.left || shiftedDst.x >= dstInfo.rect.right) {
          continue;
        }
      } else {
        shiftedSrc.y += delta;
        shiftedDst.y += delta;
        if (shiftedSrc.y <= srcInfo.rect.top || shiftedSrc.y >= srcInfo.rect.bottom) {
          continue;
        }
        if (shiftedDst.y <= dstInfo.rect.top || shiftedDst.y >= dstInfo.rect.bottom) {
          continue;
        }
      }

      // Re-check geometric clearance after the shift.
      if (segmentHitsNode(shiftedSrc, shiftedDst, [srcId, dstId])) {
        continue;
      }

      // Must not introduce a perpendicular crossing with any other edge,
      // and must not overlap on a shared axis (share axis + overlapping
      // range) with any other edge's segment. `segmentsCrossOrth` only
      // flags perpendicular crossings; two same-axis segments on the
      // same coordinate aren't a "crossing" in its sense but ARE an
      // edge overlap — both visually and in the `scoreLayout` count.
      // The shared-axis check is required for the 0-shift path (without
      // it, a centered rescue could land directly on top of an already-
      // centered sibling — the very case iter 12 introduced ±PORT_SHIFT
      // to avoid).
      const shiftedIsVertical = Math.abs(shiftedSrc.x - shiftedDst.x) < EPS;
      const shiftedMinX = Math.min(shiftedSrc.x, shiftedDst.x);
      const shiftedMaxX = Math.max(shiftedSrc.x, shiftedDst.x);
      const shiftedMinY = Math.min(shiftedSrc.y, shiftedDst.y);
      const shiftedMaxY = Math.max(shiftedSrc.y, shiftedDst.y);
      let introducesCrossing = false;
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
          continue;
        }
        const opts = (other as { points?: { x: number; y: number }[] }).points;
        if (!opts || opts.length < 2) {
          continue;
        }
        for (let i = 0; i < opts.length - 1; i++) {
          if (segmentsCrossOrth(shiftedSrc, shiftedDst, opts[i], opts[i + 1])) {
            introducesCrossing = true;
            break;
          }
          // Collinear-axis overlap check. Only rejects when the other
          // segment shares the same axis coordinate AND its span
          // overlaps our new line's span (not merely touching at an
          // endpoint).
          const oa = opts[i];
          const ob = opts[i + 1];
          const otherIsVertical = Math.abs(oa.x - ob.x) < EPS;
          const otherIsHorizontal = Math.abs(oa.y - ob.y) < EPS;
          if (shiftedIsVertical && otherIsVertical && Math.abs(oa.x - shiftedSrc.x) < EPS) {
            const oMinY = Math.min(oa.y, ob.y);
            const oMaxY = Math.max(oa.y, ob.y);
            if (oMaxY > shiftedMinY + EPS && oMinY < shiftedMaxY - EPS) {
              introducesCrossing = true;
              break;
            }
          } else if (
            !shiftedIsVertical &&
            otherIsHorizontal &&
            Math.abs(oa.y - shiftedSrc.y) < EPS
          ) {
            const oMinX = Math.min(oa.x, ob.x);
            const oMaxX = Math.max(oa.x, ob.x);
            if (oMaxX > shiftedMinX + EPS && oMinX < shiftedMaxX - EPS) {
              introducesCrossing = true;
              break;
            }
          }
        }
        if (introducesCrossing) {
          break;
        }
      }
      if (introducesCrossing) {
        continue;
      }

      (edge as { points?: { x: number; y: number }[] }).points = [shiftedSrc, shiftedDst];
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `coRouteSiblingsOnSharedFace: rescued ${edgeId} to 2-point straight at ${collinearX ? 'x' : 'y'}=${collinearX ? shiftedSrc.x : shiftedSrc.y} (delta=${delta})`
      );
      break;
    }
  }
}
