// cspell:ignore ungated Hegemann Collinearly Kandinsky raykov Wybrow Helmers Eiglsperger Tamassia Battista Eades Tollis Fößmeier segs Gladisch
import type { LayoutData } from '../../types.js';
import { log } from '../../../logger.js';
import {
  clipEdgeEndpointsToNodeBoundaries,
  prepareEdgeEndpointsForRenderer,
} from './direction/endpointClip.js';
import { orthogonalizePolyline, simplifyPolyline } from './direction/geometry.js';
import { applyLrDirectionTransform } from './direction/lrTransform.js';
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
export function applySwimlaneDirectionTransform(layout: LayoutData, direction?: string): void {
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

  prepareEdgeEndpointsForRenderer(edges, nodeByIdMap);

  log.debug(SWIMLANE_DIR_LOG_PREFIX, 'Applied LR direction transform to swimlanes', {
    contentNodeCount: contentNodes.length,
  });
}

interface LabelRect {
  nodeId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LabelEdgeFixCandidate {
  edge: any;
  label: LabelRect;
  startIdx: number;
  endIdx: number;
}

const EPS = 1e-3;

/**
 * Detour-bypass pass: for each edge whose routed polyline has ≥ 4 bends
 * (a signal that the router took a multi-step detour around a real
 * obstacle), try to replace it with a shorter orthogonal path that uses
 * a different pair of port sides on source and destination.
 *
 * The search is deliberately simple:
 * - Enumerate all 16 (source side × destination side) port pairings.
 * - For each, construct the minimal 1- or 2-bend orthogonal path
 *   between the two side-center ports (extended by an anchor offset so
 *   the polyline endpoints match raykov's conventions).
 * - Reject candidates whose path intersects any non-endpoint real node
 *   (labels are not obstacles — see Strategy 1).
 * - Keep the candidate with the fewest bends. If none beats the
 *   original's bend count by at least 1, leave the polyline unchanged.
 *
 * This handles the classic "edge detouring around a single obstacle"
 * pattern without needing to re-enter raykov's port assignment logic.
 */
function simplifyDetouredEdges(edges: any[], nodes: any[]): void {
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
    w: number;
    h: number;
    rect: RectLite;
  }

  const realNodes: NodeInfo[] = [];
  const nodeInfoById = new Map<string, NodeInfo>();
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
    const info: NodeInfo = {
      id: String((n as { id?: string }).id ?? ''),
      cx,
      cy,
      w,
      h,
      rect: { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 },
    };
    realNodes.push(info);
    nodeInfoById.set(info.id, info);
  }

  const countBends = (pts: { x: number; y: number }[]): number => {
    let bends = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const abH = Math.abs(a.y - b.y) < EPS;
      const bcH = Math.abs(b.y - c.y) < EPS;
      if (abH !== bcH) {
        bends++;
      }
    }
    return bends;
  };

  type Side = 'top' | 'bottom' | 'left' | 'right';
  const sides: Side[] = ['top', 'bottom', 'left', 'right'];

  const portForSide = (n: NodeInfo, side: Side): { x: number; y: number } => {
    switch (side) {
      case 'top':
        return { x: n.cx, y: n.rect.top };
      case 'bottom':
        return { x: n.cx, y: n.rect.bottom };
      case 'left':
        return { x: n.rect.left, y: n.cy };
      case 'right':
        return { x: n.rect.right, y: n.cy };
    }
  };

  // Anchor offset for port exit. Each port's first/last segment must
  // extend in the port's perpendicular direction by at least this many
  // units before turning, so (a) the port-direction check in
  // validateLayout is satisfied and (b) the segment does not hug the
  // node's boundary. Matches raykov's ANCHOR_OFFSET.
  const ANCHOR = 20;

  // Minimal 1- or 2-bend orthogonal path between two cardinal-side
  // ports. Returns undefined if the two sides are incompatible for a
  // clean path (e.g. port directions contradict the required bend
  // direction) — in which case the caller should try another pair.
  const buildOrthogonalPath = (
    src: { x: number; y: number },
    srcSide: Side,
    dst: { x: number; y: number },
    dstSide: Side
  ): { x: number; y: number }[] | undefined => {
    const srcH = srcSide === 'left' || srcSide === 'right';
    const dstH = dstSide === 'left' || dstSide === 'right';

    // Case A: src horizontal, dst horizontal.
    if (srcH && dstH) {
      // Opposite sides (src right ↔ dst left or vice versa) going
      // toward each other — a valid 1-bend or 0-bend path.
      const opposingDir =
        (srcSide === 'right' && dstSide === 'left' && src.x < dst.x) ||
        (srcSide === 'left' && dstSide === 'right' && src.x > dst.x);
      if (opposingDir) {
        if (Math.abs(src.y - dst.y) < EPS) {
          return [src, dst];
        }
        const midX = (src.x + dst.x) / 2;
        return [src, { x: midX, y: src.y }, { x: midX, y: dst.y }, dst];
      }
      // Same-side pairing (left-left or right-right): route via an
      // intermediate x that lies OUTSIDE both nodes by at least ANCHOR.
      if (srcSide === dstSide) {
        if (Math.abs(src.y - dst.y) < EPS) {
          return undefined;
        }
        const intX =
          srcSide === 'left' ? Math.min(src.x, dst.x) - ANCHOR : Math.max(src.x, dst.x) + ANCHOR;
        return [src, { x: intX, y: src.y }, { x: intX, y: dst.y }, dst];
      }
      return undefined;
    }

    // Case B: src vertical, dst vertical.
    if (!srcH && !dstH) {
      // Same-side pairing (top-top or bottom-bottom): route via an
      // intermediate y that lies OUTSIDE both nodes by at least ANCHOR
      // so port-direction and border-hug checks are satisfied. The
      // intermediate y is min(src.y, dst.y) - ANCHOR for top-top, or
      // max(src.y, dst.y) + ANCHOR for bottom-bottom. Always produces a
      // 2-bend path, never 1.
      if (srcSide === dstSide) {
        if (Math.abs(src.x - dst.x) < EPS) {
          // Same x: a straight vertical line doesn't produce a valid
          // two-same-side exit/entry, reject.
          return undefined;
        }
        const intY =
          srcSide === 'top' ? Math.min(src.y, dst.y) - ANCHOR : Math.max(src.y, dst.y) + ANCHOR;
        return [src, { x: src.x, y: intY }, { x: dst.x, y: intY }, dst];
      }
      // Opposite-side pairing (src top ↔ dst bottom or vice versa).
      // Valid only if the two nodes' port directions point toward each
      // other: src bottom going down while dst top is at a larger y, or
      // src top going up while dst bottom is at a smaller y.
      const sameDir =
        (srcSide === 'bottom' && dstSide === 'top' && src.y < dst.y) ||
        (srcSide === 'top' && dstSide === 'bottom' && src.y > dst.y);
      if (!sameDir) {
        return undefined;
      }
      if (Math.abs(src.x - dst.x) < EPS) {
        return [src, dst];
      }
      const midY = (src.y + dst.y) / 2;
      return [src, { x: src.x, y: midY }, { x: dst.x, y: midY }, dst];
    }

    // Case C: src horizontal, dst vertical — 1 bend L-shape.
    if (srcH && !dstH) {
      const sameDirSrc =
        (srcSide === 'right' && dst.x > src.x) || (srcSide === 'left' && dst.x < src.x);
      const sameDirDst =
        (dstSide === 'top' && src.y < dst.y) || (dstSide === 'bottom' && src.y > dst.y);
      if (!sameDirSrc || !sameDirDst) {
        return undefined;
      }
      return [src, { x: dst.x, y: src.y }, dst];
    }

    // Case D: src vertical, dst horizontal — 1 bend L-shape.
    if (!srcH && dstH) {
      const sameDirSrc =
        (srcSide === 'bottom' && dst.y > src.y) || (srcSide === 'top' && dst.y < src.y);
      const sameDirDst =
        (dstSide === 'left' && src.x < dst.x) || (dstSide === 'right' && src.x > dst.x);
      if (!sameDirSrc || !sameDirDst) {
        return undefined;
      }
      return [src, { x: src.x, y: dst.y }, dst];
    }

    // Unreachable because srcH/dstH combinations are all handled above.
    /* istanbul ignore next */
    return undefined;
  };

  const pathHitsNode = (pts: { x: number; y: number }[], excludeIds: string[]): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const segMinX = Math.min(a.x, b.x);
      const segMaxX = Math.max(a.x, b.x);
      const segMinY = Math.min(a.y, b.y);
      const segMaxY = Math.max(a.y, b.y);
      for (const n of realNodes) {
        if (excludeIds.includes(n.id)) {
          continue;
        }
        // Strict interior test with a 1-unit tolerance.
        if (
          segMaxX > n.rect.left + 1 &&
          segMinX < n.rect.right - 1 &&
          segMaxY > n.rect.top + 1 &&
          segMinY < n.rect.bottom - 1
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const BEND_THRESHOLD = 4;

  // Collect which node faces are already claimed by other edges so the
  // rewrite loop below can reject a candidate port pair whose face is
  // contested. This realizes Hegemann-Wolff's bend-or-end global
  // feasibility rule (src d30cdbe1): two edges claiming the same node
  // face must be feasibility-checked as a set, never accepted as a
  // sequential patch.
  //
  // Iter 9 defect: raykov routed L_D_E_0 around H with 4 bends and
  // L_E_F_0 cleanly at E.top in parallel; this pass then rewrote
  // L_D_E_0 to the 2-bend (D.top, E.top) L-shape because it only
  // checked against real-node obstacles and was blind to the E.top
  // claim L_E_F_0 had already made.
  //
  // Note the face-detection uses `nearestSideOfRect` which picks
  // whichever of the 4 rect edges the point is closest to. The
  // polyline endpoints at this point in the pipeline are ALREADY
  // transformed to TB coordinates but the final endpoint-clip pass
  // (which snaps each endpoint onto the actual rect boundary) runs
  // LATER, so the raw attach points may sit a few units inside the
  // node rect. Nearest-side works regardless of whether the point is
  // on, just outside, or a few units inside the rect.
  const nearestSideOfRect = (pt: { x: number; y: number }, info: NodeInfo): Side => {
    const dTop = Math.abs(pt.y - info.rect.top);
    const dBottom = Math.abs(pt.y - info.rect.bottom);
    const dLeft = Math.abs(pt.x - info.rect.left);
    const dRight = Math.abs(pt.x - info.rect.right);
    let best: Side = 'top';
    let bestDist = dTop;
    if (dBottom < bestDist) {
      best = 'bottom';
      bestDist = dBottom;
    }
    if (dLeft < bestDist) {
      best = 'left';
      bestDist = dLeft;
    }
    if (dRight < bestDist) {
      best = 'right';
      bestDist = dRight;
    }
    return best;
  };

  interface FaceClaim {
    side: Side;
    edgeId: string;
  }
  const faceClaims = new Map<string, FaceClaim[]>();
  const addFaceClaim = (nodeId: string, side: Side, edgeId: string) => {
    if (!faceClaims.has(nodeId)) {
      faceClaims.set(nodeId, []);
    }
    faceClaims.get(nodeId)!.push({ side, edgeId });
  };
  for (const e of edges) {
    if ((e as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (e as { points?: { x: number; y: number }[] }).points ?? [];
    if (pts.length < 1) {
      continue;
    }
    const eId = (e as { id?: string }).id ?? '';
    const startId = (e as { start?: string }).start;
    const endId = (e as { end?: string }).end;
    if (startId) {
      const info = nodeInfoById.get(startId);
      if (info) {
        addFaceClaim(startId, nearestSideOfRect(pts[0], info), eId);
      }
    }
    if (endId) {
      const info = nodeInfoById.get(endId);
      if (info) {
        addFaceClaim(endId, nearestSideOfRect(pts[pts.length - 1], info), eId);
      }
    }
  }

  const faceIsClaimed = (nodeId: string, side: Side, ignoreEdgeId: string): boolean => {
    const claims = faceClaims.get(nodeId);
    if (!claims) {
      return false;
    }
    for (const c of claims) {
      if (c.edgeId === ignoreEdgeId) {
        continue;
      }
      if (c.side === side) {
        return true;
      }
    }
    return false;
  };

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points as { x: number; y: number }[] | undefined;
    if (!pts || pts.length < 2) {
      continue;
    }
    const currentBends = countBends(pts);
    if (currentBends < BEND_THRESHOLD) {
      continue;
    }
    const srcId = edge.start as string | undefined;
    const dstId = edge.end as string | undefined;
    if (!srcId || !dstId) {
      continue;
    }
    const srcInfo = nodeInfoById.get(srcId);
    const dstInfo = nodeInfoById.get(dstId);
    if (!srcInfo || !dstInfo) {
      continue;
    }
    const edgeId = (edge as { id?: string }).id ?? '';

    let bestPath: { x: number; y: number }[] | undefined;
    let bestBends = currentBends;

    for (const srcSide of sides) {
      if (faceIsClaimed(srcId, srcSide, edgeId)) {
        continue;
      }
      const srcPort = portForSide(srcInfo, srcSide);
      for (const dstSide of sides) {
        if (faceIsClaimed(dstId, dstSide, edgeId)) {
          continue;
        }
        const dstPort = portForSide(dstInfo, dstSide);
        const path = buildOrthogonalPath(srcPort, srcSide, dstPort, dstSide);
        if (!path) {
          continue;
        }
        if (pathHitsNode(path, [srcId, dstId])) {
          continue;
        }
        const pathBends = countBends(path);
        if (pathBends < bestBends) {
          bestBends = pathBends;
          bestPath = path;
        }
      }
    }

    if (bestPath) {
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `simplifyDetouredEdges: rewrote ${edge.id} (${currentBends}→${bestBends} bends)`
      );
      (edge as { points: { x: number; y: number }[] }).points = bestPath;
      // Refresh face claims for this edge so downstream iterations
      // see the new attach sides. The loop mutates edges in place;
      // stale claims would let two edges both commit to the same face.
      const refreshSrc = faceClaims.get(srcId);
      if (refreshSrc) {
        faceClaims.set(
          srcId,
          refreshSrc.filter((c) => c.edgeId !== edgeId)
        );
      }
      const refreshDst = faceClaims.get(dstId);
      if (refreshDst) {
        faceClaims.set(
          dstId,
          refreshDst.filter((c) => c.edgeId !== edgeId)
        );
      }
      addFaceClaim(srcId, nearestSideOfRect(bestPath[0], srcInfo), edgeId);
      addFaceClaim(dstId, nearestSideOfRect(bestPath[bestPath.length - 1], dstInfo), edgeId);
    }
  }
}

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
 * Strategy 1 late-insertion anchor pass (diss.pdf §118).
 *
 * For each edge carrying `labelNodeId`, pick a middle segment of its routed
 * polyline and set the label node's center to that segment's midpoint. The
 * label's position becomes a function of the routed geometry rather than
 * the Sugiyama layer assignment.
 *
 * Middle-segment rule per §118:
 * - Middle segment = any segment that is not the first and not the last
 *   (those are port-incident and must not host the label).
 * - Prefer orientation matching the label's long axis (horizontal for wide
 *   labels — the common case — vertical for tall labels).
 * - Tie-break on longest length (Mermaid calibration, not paper-backed).
 *
 * Compaction substitute (plan section 4b — Mermaid deviation from §118):
 * - If no middle segment is long enough to host the label, manufacture one
 *   by injecting a two-bend step on the longest available middle segment.
 *
 * Validator-rerun loop:
 * - After anchoring, if the chosen position produces an
 *   `edge-label-overlaps-foreign-edge` overlap against other polylines
 *   or nodes, try the next-best segment. Cap at 3 attempts before
 *   falling back to the longest-segment midpoint and logging.
 */
function anchorLabelsToPolyline(edges: any[], nodeByIdMap: Map<string, any>): void {
  // Build a set of foreign polylines once for overlap checks. Labelled
  // originals that haven't been anchored yet are still included — their
  // polylines exist, even if their labels haven't moved.
  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }
  interface SegmentLite {
    edgeId: string;
    p1: { x: number; y: number };
    p2: { x: number; y: number };
  }
  const allEdgeSegments: SegmentLite[] = [];
  for (const other of edges) {
    if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (other as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length < 2) {
      continue;
    }
    const eid = String((other as { id?: string }).id ?? '');
    for (let i = 0; i < pts.length - 1; i++) {
      allEdgeSegments.push({ edgeId: eid, p1: pts[i], p2: pts[i + 1] });
    }
  }

  const foreignNodeRects: { nodeId: string; rect: RectLite }[] = [];
  // Collect top-level lane groups so we can re-assign a label's parentId to
  // whichever lane geometrically contains its anchored position. Without
  // this, labels whose anchor crosses a lane boundary are reported as
  // node-overlap violations against sibling lane groups.
  const laneGroups: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    const isGroup = (n as { isGroup?: boolean }).isGroup;
    const parentId = (n as { parentId?: string }).parentId;
    if (isGroup && !parentId) {
      const cx = (n as { x?: number }).x ?? 0;
      const cy = (n as { y?: number }).y ?? 0;
      const w = (n as { width?: number }).width ?? 0;
      const h = (n as { height?: number }).height ?? 0;
      if (w > 0 && h > 0) {
        laneGroups.push({
          id: String((n as { id?: string }).id ?? ''),
          rect: { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 },
        });
      }
      continue;
    }
    if (isGroup) {
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
    foreignNodeRects.push({
      nodeId: String((n as { id?: string }).id ?? ''),
      rect: { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 },
    });
  }

  const rectContainsRect = (outer: RectLite, inner: RectLite): boolean =>
    outer.left <= inner.left &&
    outer.right >= inner.right &&
    outer.top <= inner.top &&
    outer.bottom >= inner.bottom;

  const rectsOverlap = (a: RectLite, b: RectLite): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  // Inflation margin for foreign-edge / foreign-node proximity. The layout
  // validator's `edge-border-hugging` check fires when a polyline runs
  // within ~2u of a label's visual border (EPS_BORDER). Inflate the label
  // rect we test by a little more than that when rejecting candidates, so
  // no chosen placement will trigger the hug check. 3u matches the buffer
  // resolveEdgeNodeIntersections historically used for labels.
  const LABEL_PLACEMENT_BUFFER = 3;

  const inflate = (r: RectLite, d: number): RectLite => ({
    left: r.left - d,
    right: r.right + d,
    top: r.top - d,
    bottom: r.bottom + d,
  });

  const segmentIntersectsRectInterior = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    r: RectLite
  ): boolean => {
    const segMinX = Math.min(p1.x, p2.x);
    const segMaxX = Math.max(p1.x, p2.x);
    const segMinY = Math.min(p1.y, p2.y);
    const segMaxY = Math.max(p1.y, p2.y);
    return segMaxX > r.left && segMinX < r.right && segMaxY > r.top && segMinY < r.bottom;
  };

  const labelOverlapsAnything = (labelId: string, edgeId: string, rect: RectLite): boolean => {
    const buffered = inflate(rect, LABEL_PLACEMENT_BUFFER);
    for (const { nodeId, rect: nr } of foreignNodeRects) {
      if (nodeId === labelId) {
        continue;
      }
      if (rectsOverlap(buffered, nr)) {
        return true;
      }
    }
    for (const s of allEdgeSegments) {
      if (s.edgeId === edgeId) {
        continue;
      }
      if (segmentIntersectsRectInterior(s.p1, s.p2, buffered)) {
        return true;
      }
    }
    return false;
  };

  const findContainingLane = (rect: RectLite): string | undefined => {
    for (const { id, rect: laneRect } of laneGroups) {
      if (rectContainsRect(laneRect, rect)) {
        return id;
      }
    }
    return undefined;
  };

  interface SegmentCandidate {
    idx: number;
    length: number;
    orientation: 'horizontal' | 'vertical';
    midX: number;
    midY: number;
  }

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const labelId = (edge as { labelNodeId?: string }).labelNodeId;
    if (!labelId) {
      continue;
    }
    const labelNode = nodeByIdMap.get(labelId);
    if (!labelNode) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length < 2) {
      continue;
    }
    const lw = labelNode.width ?? 0;
    const lh = labelNode.height ?? 0;
    if (lw <= 0 || lh <= 0) {
      continue;
    }

    // Collect every non-zero segment with orientation.
    const segments: SegmentCandidate[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < EPS && dy < EPS) {
        continue;
      }
      if (dx >= EPS && dy >= EPS) {
        continue; // non-orthogonal — should not happen post-orthogonalize
      }
      segments.push({
        idx: i,
        length: dx + dy,
        orientation: dx >= EPS ? 'horizontal' : 'vertical',
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      });
    }

    if (segments.length === 0) {
      continue;
    }

    // §118: middle segments only (exclude first and last). Fall back to
    // any segment if the polyline has fewer than 3 segments (the paper is
    // silent on degenerate cases — Mermaid calibration).
    const middleSegments =
      segments.length >= 3
        ? segments.filter((s) => s.idx > 0 && s.idx < segments.length - 1)
        : segments;
    const poolBase = middleSegments.length > 0 ? middleSegments : segments;

    // Label long axis: horizontal if wider than tall, else vertical. The
    // label is drawn horizontally inside its bbox regardless, so the long
    // axis only drives preference, not hard filtering.
    const labelLongAxis: 'horizontal' | 'vertical' = lw >= lh ? 'horizontal' : 'vertical';
    const labelExtentOnAxis = (axis: 'horizontal' | 'vertical') =>
      axis === 'horizontal' ? lw : lh;

    // Candidate ranking: (a) length >= labelExtent + 2, (b) orientation
    // matching label long axis preferred, (c) longest tie-break.
    const rankSegments = (pool: SegmentCandidate[]): SegmentCandidate[] => {
      return [...pool].sort((a, b) => {
        const aFits = a.length >= labelExtentOnAxis(a.orientation) + 2;
        const bFits = b.length >= labelExtentOnAxis(b.orientation) + 2;
        if (aFits !== bFits) {
          return aFits ? -1 : 1;
        }
        const aLongAxis = a.orientation === labelLongAxis;
        const bLongAxis = b.orientation === labelLongAxis;
        if (aLongAxis !== bLongAxis) {
          return aLongAxis ? -1 : 1;
        }
        return b.length - a.length;
      });
    };

    // Try the middle-segment pool first (§118), then expand to include
    // every orthogonal segment if the middle-only pool yields no
    // lane-containing, overlap-free candidate. The "any segment" expansion
    // is a Mermaid-specific adaptation for cross-lane edges whose only
    // middle segment is the vertical lane-crossing leg (which by
    // construction straddles a lane boundary and cannot host the label).
    //
    // Per-segment, if the midpoint (t=0.5) collides with a foreign edge
    // or label, walk along the segment at additional parametric positions
    // t ∈ {0.25, 0.75, 0.15, 0.85} before moving on. Helmers diss.pdf
    // §118 requires "one of e's middle segments" but is silent on the
    // exact anchor position along that segment, so along-segment shift is
    // consistent with the paper (Mermaid adaptation). Paper-adjacent to
    // Wybrow-Marriott alley-midpoint centering (src `e8804c93`), which
    // picks the placement with widest clearance to foreign geometry.
    const ALONG_SEGMENT_TS = [0.5, 0.25, 0.75, 0.15, 0.85];
    const rectAtT = (
      seg: SegmentCandidate,
      pts2: { x: number; y: number }[],
      t: number
    ): RectLite => {
      const a = pts2[seg.idx];
      const b = pts2[seg.idx + 1];
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      return {
        left: x - lw / 2,
        right: x + lw / 2,
        top: y - lh / 2,
        bottom: y + lh / 2,
      };
    };
    const anchorAtT = (seg: SegmentCandidate, t: number): { midX: number; midY: number } => {
      const a = pts[seg.idx];
      const b = pts[seg.idx + 1];
      return {
        midX: a.x + (b.x - a.x) * t,
        midY: a.y + (b.y - a.y) * t,
      };
    };

    const tryPool = (
      pool: SegmentCandidate[]
    ):
      | { seg: SegmentCandidate; laneId: string; anchor: { midX: number; midY: number } }
      | undefined => {
      const rankedPool = rankSegments(pool);
      for (const seg of rankedPool) {
        for (const t of ALONG_SEGMENT_TS) {
          const rect = rectAtT(seg, pts, t);
          const laneId = findContainingLane(rect);
          if (!laneId) {
            continue;
          }
          if (!labelOverlapsAnything(labelId, edge.id ?? '', rect)) {
            return { seg, laneId, anchor: anchorAtT(seg, t) };
          }
        }
      }
      return undefined;
    };

    const findLaneContainingFallback = (
      pool: SegmentCandidate[]
    ):
      | { seg: SegmentCandidate; laneId: string; anchor: { midX: number; midY: number } }
      | undefined => {
      const rankedPool = rankSegments(pool);
      for (const seg of rankedPool) {
        const rect: RectLite = {
          left: seg.midX - lw / 2,
          right: seg.midX + lw / 2,
          top: seg.midY - lh / 2,
          bottom: seg.midY + lh / 2,
        };
        const laneId = findContainingLane(rect);
        if (laneId) {
          return { seg, laneId, anchor: { midX: seg.midX, midY: seg.midY } };
        }
      }
      return undefined;
    };

    const chosen =
      tryPool(poolBase) ??
      (poolBase.length < segments.length ? tryPool(segments) : undefined) ??
      findLaneContainingFallback(segments);

    if (chosen) {
      labelNode.x = chosen.anchor.midX;
      labelNode.y = chosen.anchor.midY;
      labelNode.parentId = chosen.laneId;
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `Anchored ${labelId} to segment ${chosen.seg.idx} of ${edge.id} at (${chosen.anchor.midX.toFixed(1)}, ${chosen.anchor.midY.toFixed(1)}) — ${chosen.seg.orientation}, length=${chosen.seg.length.toFixed(1)}, lane=${chosen.laneId}`
      );
    } else {
      log.warn(
        SWIMLANE_DIR_LOG_PREFIX,
        `anchorLabelsToPolyline: no lane-containing segment for ${labelId} on ${edge.id} — left at Sugiyama position (label=${lw.toFixed(1)}x${lh.toFixed(1)})`
      );
    }
  }
}

/**
 * Stale port-offset Z-edge straightener (iter 7).
 *
 * Scans 4-point polylines for a short H-V-H (or V-H-V) "Z-jog" pattern
 * where one endpoint has a perpendicular offset from its node's center
 * that matches raykov's port-distribution output. When the jog can be
 * safely straightened — either by aligning with an adjacent collinear
 * incident edge at the shared endpoint (preferred) or by shifting to
 * node center (fallback) — the edge is rewritten as a straight line.
 *
 * Paper-backed by the Hegemann-Wolff paper (source b65b3d45, Fig. 11b
 * discussion) which names this class of cleanup. The LP-based "full
 * nudging" phase described there achieves the same effect globally via
 * zero-separation constraints on same-path segments; this function is
 * a local Mermaid proxy.
 *
 * Safety: the straightened polyline must not overlap foreign real
 * nodes (3u buffer) or any anchored label rect (produced by
 * `anchorLabelsToPolyline`). If any safety check fails, the edge is
 * left unchanged.
 */
function straightenStalePortOffsets(edges: any[], nodeByIdMap: Map<string, any>): void {
  const JOG_MAX = 20; // matches raykov MAX_PORT_SPACING
  const NODE_BUFFER = 3;
  const LABEL_BUFFER = 3;
  const EDGE_BUFFER = 2;

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  // Collect foreign real-node rects (excluding labels and groups).
  const realNodeRects: { id: string; rect: RectLite }[] = [];
  const labelRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    const isGroup = (n as { isGroup?: boolean }).isGroup;
    if (isGroup) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    const id = String((n as { id?: string }).id ?? '');
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      labelRects.push({ id, rect });
    } else {
      realNodeRects.push({ id, rect });
    }
  }

  // Collect all edge segments for edge-on-edge overlap checking.
  interface SegLite {
    edgeId: string;
    a: { x: number; y: number };
    b: { x: number; y: number };
  }
  const allSegments: SegLite[] = [];
  for (const other of edges) {
    if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const opts = (other as { points?: { x: number; y: number }[] }).points;
    if (!opts || opts.length < 2) {
      continue;
    }
    const eid = String((other as { id?: string }).id ?? '');
    for (let i = 0; i < opts.length - 1; i++) {
      allSegments.push({ edgeId: eid, a: opts[i], b: opts[i + 1] });
    }
  }

  const segHitsRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: RectLite,
    buffer: number
  ): boolean => {
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    return (
      segMaxX > r.left - buffer &&
      segMinX < r.right + buffer &&
      segMaxY > r.top - buffer &&
      segMinY < r.bottom + buffer
    );
  };

  // Collinear-incident-at-shared-node lookup for neighbor alignment.
  // Given a node and an axis ('y' for horizontal neighbors, 'x' for vertical),
  // return the coordinate of a collinear incident edge if one exists.
  const findCollinearNeighborCoord = (
    nodeId: string,
    excludeEdgeId: string,
    axis: 'y' | 'x'
  ): number | undefined => {
    for (const other of edges) {
      if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const oid = String((other as { id?: string }).id ?? '');
      if (oid === excludeEdgeId) {
        continue;
      }
      const opts = (other as { points?: { x: number; y: number }[] }).points;
      if (!opts || opts.length < 2) {
        continue;
      }
      const oStart = (other as { start?: string }).start;
      const oEnd = (other as { end?: string }).end;
      // Use the segment incident to the shared node.
      let incidentSeg: { a: { x: number; y: number }; b: { x: number; y: number } } | undefined;
      if (oStart === nodeId) {
        incidentSeg = { a: opts[0], b: opts[1] };
      } else if (oEnd === nodeId) {
        incidentSeg = { a: opts[opts.length - 1], b: opts[opts.length - 2] };
      } else {
        continue;
      }
      // If the incident segment is collinear on the requested axis,
      // return that axis coordinate.
      if (axis === 'y' && Math.abs(incidentSeg.a.y - incidentSeg.b.y) < EPS) {
        return incidentSeg.a.y;
      }
      if (axis === 'x' && Math.abs(incidentSeg.a.x - incidentSeg.b.x) < EPS) {
        return incidentSeg.a.x;
      }
    }
    return undefined;
  };

  // The core straightener. For each edge with a 4-point H-V-H or V-H-V
  // polyline, decide if it can be collapsed to a straight 2-point line.
  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const [p0, p1, p2, p3] = pts;
    const startId = (edge as { start?: string }).start;
    const endId = (edge as { end?: string }).end;
    const edgeId = String((edge as { id?: string }).id ?? '');
    if (!startId || !endId) {
      continue;
    }
    const startNode = nodeByIdMap.get(startId);
    const endNode = nodeByIdMap.get(endId);
    if (!startNode || !endNode) {
      continue;
    }
    const startRect: RectLite = {
      left: (startNode.x ?? 0) - (startNode.width ?? 0) / 2,
      right: (startNode.x ?? 0) + (startNode.width ?? 0) / 2,
      top: (startNode.y ?? 0) - (startNode.height ?? 0) / 2,
      bottom: (startNode.y ?? 0) + (startNode.height ?? 0) / 2,
    };
    const endRect: RectLite = {
      left: (endNode.x ?? 0) - (endNode.width ?? 0) / 2,
      right: (endNode.x ?? 0) + (endNode.width ?? 0) / 2,
      top: (endNode.y ?? 0) - (endNode.height ?? 0) / 2,
      bottom: (endNode.y ?? 0) + (endNode.height ?? 0) / 2,
    };

    // Identify the pattern: H-V-H or V-H-V with a short middle segment.
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
    // Middle segment length check.
    const middleLen = isHVH ? Math.abs(p2.y - p1.y) : Math.abs(p2.x - p1.x);
    if (middleLen > JOG_MAX) {
      continue;
    }

    // Determine target coordinate for the straightened line.
    // Preference order: (a) neighbor alignment at either endpoint,
    // (b) shift whichever endpoint is farther from its node's center.
    let targetCoord: number | undefined;
    let shiftStart = false;
    if (isHVH) {
      // Straighten to a single y. p0.y and p3.y differ by middleLen.
      const startNeighborY = findCollinearNeighborCoord(startId, edgeId, 'y');
      const endNeighborY = findCollinearNeighborCoord(endId, edgeId, 'y');
      const startCy = startNode.y ?? 0;
      const endCy = endNode.y ?? 0;
      // Prefer neighbor alignment if a collinear neighbor exists at
      // the corresponding endpoint's matching y (within EPS of that
      // endpoint's y).
      if (startNeighborY !== undefined && Math.abs(startNeighborY - p0.y) < EPS) {
        // Start endpoint already aligned with its neighbor; shift end.
        targetCoord = p0.y;
        shiftStart = false;
      } else if (endNeighborY !== undefined && Math.abs(endNeighborY - p3.y) < EPS) {
        targetCoord = p3.y;
        shiftStart = true;
      } else {
        // Fallback: shift whichever endpoint is farther from its node's center.
        const startOff = Math.abs(p0.y - startCy);
        const endOff = Math.abs(p3.y - endCy);
        if (endOff >= startOff) {
          targetCoord = p0.y;
          shiftStart = false;
        } else {
          targetCoord = p3.y;
          shiftStart = true;
        }
      }
    } else {
      // V-H-V mirror: straighten to a single x.
      const startNeighborX = findCollinearNeighborCoord(startId, edgeId, 'x');
      const endNeighborX = findCollinearNeighborCoord(endId, edgeId, 'x');
      const startCx = startNode.x ?? 0;
      const endCx = endNode.x ?? 0;
      if (startNeighborX !== undefined && Math.abs(startNeighborX - p0.x) < EPS) {
        targetCoord = p0.x;
        shiftStart = false;
      } else if (endNeighborX !== undefined && Math.abs(endNeighborX - p3.x) < EPS) {
        targetCoord = p3.x;
        shiftStart = true;
      } else {
        const startOff = Math.abs(p0.x - startCx);
        const endOff = Math.abs(p3.x - endCx);
        if (endOff >= startOff) {
          targetCoord = p0.x;
          shiftStart = false;
        } else {
          targetCoord = p3.x;
          shiftStart = true;
        }
      }
    }

    if (targetCoord === undefined) {
      continue;
    }

    // Construct the proposed straight line.
    const newStart = shiftStart
      ? isHVH
        ? { x: p0.x, y: targetCoord }
        : { x: targetCoord, y: p0.y }
      : { x: p0.x, y: p0.y };
    const newEnd = shiftStart
      ? { x: p3.x, y: p3.y }
      : isHVH
        ? { x: p3.x, y: targetCoord }
        : { x: targetCoord, y: p3.y };

    // Safety check: the shifted endpoint's axis coordinate must stay
    // within the node's span on the relevant side. The endpoint clip
    // pass (which runs after this one) will snap the point onto the
    // boundary exactly; we only need to know that the node can accept
    // the approach direction at the target coordinate.
    if (isHVH) {
      const rect = shiftStart ? startRect : endRect;
      if (targetCoord < rect.top - 0.5 || targetCoord > rect.bottom + 0.5) {
        continue;
      }
    } else {
      const rect = shiftStart ? startRect : endRect;
      if (targetCoord < rect.left - 0.5 || targetCoord > rect.right + 0.5) {
        continue;
      }
    }

    // Safety check: straightened line must not overlap foreign real nodes.
    let overlapsNode = false;
    for (const { id: nid, rect } of realNodeRects) {
      if (nid === startId || nid === endId) {
        continue;
      }
      if (segHitsRect(newStart, newEnd, rect, NODE_BUFFER)) {
        overlapsNode = true;
        break;
      }
    }
    if (overlapsNode) {
      continue;
    }

    // Safety check: straightened line must not overlap any anchored label rect.
    let overlapsLabel = false;
    for (const { rect } of labelRects) {
      if (segHitsRect(newStart, newEnd, rect, LABEL_BUFFER)) {
        overlapsLabel = true;
        break;
      }
    }
    if (overlapsLabel) {
      continue;
    }

    // Safety check: straightened line must not come within EDGE_BUFFER
    // of any other edge's segment.
    let hugsEdge = false;
    for (const seg of allSegments) {
      if (seg.edgeId === edgeId) {
        continue;
      }
      // Approximate: treat other segment as a tiny rect and see if the
      // new line is too close. Use a 1-unit inflation on the other seg
      // and require our new line + EDGE_BUFFER separation.
      const oMinX = Math.min(seg.a.x, seg.b.x) - EDGE_BUFFER;
      const oMaxX = Math.max(seg.a.x, seg.b.x) + EDGE_BUFFER;
      const oMinY = Math.min(seg.a.y, seg.b.y) - EDGE_BUFFER;
      const oMaxY = Math.max(seg.a.y, seg.b.y) + EDGE_BUFFER;
      const nMinX = Math.min(newStart.x, newEnd.x);
      const nMaxX = Math.max(newStart.x, newEnd.x);
      const nMinY = Math.min(newStart.y, newEnd.y);
      const nMaxY = Math.max(newStart.y, newEnd.y);
      if (nMaxX > oMinX && nMinX < oMaxX && nMaxY > oMinY && nMinY < oMaxY) {
        // Overlap in bounding box — check if segments are collinear
        // (acceptable, same flow) vs perpendicular crossing.
        const newIsH = Math.abs(newStart.y - newEnd.y) < EPS;
        const othIsH = Math.abs(seg.a.y - seg.b.y) < EPS;
        if (newIsH === othIsH) {
          // Parallel. A hug would require the other segment to share
          // or nearly share the axis coordinate. For collinear along
          // the flow (e.g. L_E_G_0 + L_G_F_0 both at y=240 through G),
          // they touch only at the shared endpoint — that's fine.
          // Reject only if there's a non-endpoint overlap.
          const shareAxis = newIsH
            ? Math.abs(newStart.y - seg.a.y) < EPS
            : Math.abs(newStart.x - seg.a.x) < EPS;
          if (shareAxis) {
            // Check for non-endpoint x (or y) overlap.
            const overlapLo = newIsH
              ? Math.max(nMinX, Math.min(seg.a.x, seg.b.x))
              : Math.max(nMinY, Math.min(seg.a.y, seg.b.y));
            const overlapHi = newIsH
              ? Math.min(nMaxX, Math.max(seg.a.x, seg.b.x))
              : Math.min(nMaxY, Math.max(seg.a.y, seg.b.y));
            if (overlapHi - overlapLo > EPS) {
              hugsEdge = true;
              break;
            }
          }
        } else {
          // Perpendicular — any bbox overlap is a true crossing.
          hugsEdge = true;
          break;
        }
      }
    }
    if (hugsEdge) {
      continue;
    }

    // Apply the straightening.
    (edge as { points: { x: number; y: number }[] }).points = [newStart, newEnd];
    log.debug(
      SWIMLANE_DIR_LOG_PREFIX,
      `straightenStalePortOffsets: collapsed ${edgeId} — ${shiftStart ? 'shifted start' : 'shifted end'} to ${targetCoord}`
    );
  }
}

function segmentIntersectsRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  rect: LabelRect,
  epsilon: number
): boolean {
  const segMinX = Math.min(p1.x, p2.x);
  const segMaxX = Math.max(p1.x, p2.x);
  const segMinY = Math.min(p1.y, p2.y);
  const segMaxY = Math.max(p1.y, p2.y);

  const intersectX = segMaxX > rect.left + epsilon && segMinX < rect.right - epsilon;
  const intersectY = segMaxY > rect.top + epsilon && segMinY < rect.bottom - epsilon;

  return intersectX && intersectY;
}

function rerouteSubpathAroundLabel(
  candidate: LabelEdgeFixCandidate,
  epsilon: number,
  margin: number
): boolean {
  const { edge, label, startIdx, endIdx } = candidate;
  const points = edge.points as { x: number; y: number }[];
  if (!points || points.length < 2) {
    return false;
  }

  const start = points[startIdx];
  const end = points[endIdx];

  // If either endpoint is inside the label rectangle, we currently skip fixing
  // this segment to avoid creating degenerate paths. In practice, the
  // intersections we care about are where the path passes *over* another
  // label's box, not where it starts/ends inside.
  const inside = (p: { x: number; y: number }) =>
    p.x > label.left + epsilon &&
    p.x < label.right - epsilon &&
    p.y > label.top + epsilon &&
    p.y < label.bottom - epsilon;

  if (inside(start) || inside(end)) {
    return false;
  }

  // Expand the rerouted region to absorb collinear stub segments on both ends.
  //
  // Orthogonal routing (e.g. the k=1 anchor preservation in raykov.ts) can
  // leave short "stub" segments collinear with the intersecting segment. When
  // stubs are included in the rerouted region, the U-shaped detour produces a
  // V→H→V path (2 bends) instead of H→V→H→V or V→H→V→H (3 bends each).
  //
  // Example: [0](src,222)→[1](src_anchor,222)→[2](dst_anchor,222)→[3](dst,222)
  // Without expansion the reroute replaces [1]→[2] and leaves both collinear
  // stubs, yielding: H→V→H→V = 3 bends. With both-ends expansion the reroute
  // covers [0]→[3] and yields: V→H→V = 2 bends.
  //
  // Use greedy (loop) expansion so that paths with multiple consecutive collinear
  // stubs (e.g. two k=1 anchor stubs on both ends) are all absorbed, not just
  // one step at a time.
  const isHorizontalSeg = Math.abs(start.y - end.y) < EPS;
  const isVerticalSeg = Math.abs(start.x - end.x) < EPS;
  let effectiveStartIdx = startIdx;
  while (effectiveStartIdx > 0) {
    const prev = points[effectiveStartIdx - 1];
    if (isHorizontalSeg && Math.abs(prev.y - start.y) < EPS) {
      effectiveStartIdx--;
    } else if (isVerticalSeg && Math.abs(prev.x - start.x) < EPS) {
      effectiveStartIdx--;
    } else {
      break;
    }
  }
  const effectiveStart = points[effectiveStartIdx];

  let effectiveEndIdx = endIdx;
  while (effectiveEndIdx < points.length - 1) {
    const next = points[effectiveEndIdx + 1];
    if (isHorizontalSeg && Math.abs(next.y - end.y) < EPS) {
      effectiveEndIdx++;
    } else if (isVerticalSeg && Math.abs(next.x - end.x) < EPS) {
      effectiveEndIdx++;
    } else {
      break;
    }
  }

  // Staircase-aware expansion: when the intersecting horizontal segment is
  // flanked by vertical steps going in the SAME direction (monotone staircase),
  // expand the rerouting region to include both vertical steps. This lets the
  // U-shaped detour cover the full staircase, producing a 2-bend path instead
  // of a 3-bend one.
  //
  // Pattern (from-label monotone staircase, all steps going "down"):
  //   [i-1](x0,y0) →[i](x0,y_mid) →[i+1](x1,y_mid) →[i+2](x1,y_end) →[i+3](x2,y_end)
  //   The intersecting segment is [i]→[i+1] (horizontal). Greedy collinear
  //   expansion doesn't help because [i-1]→[i] and [i+1]→[i+2] are vertical
  //   (different y). But if both vertical steps go the same direction the whole
  //   staircase is monotone and can be rerouted as a single U-shape.
  if (isHorizontalSeg && effectiveStartIdx > 0 && effectiveEndIdx < points.length - 1) {
    const prevStep = points[effectiveStartIdx - 1];
    const nextStep = points[effectiveEndIdx + 1];
    const curStart = points[effectiveStartIdx];
    const curEnd = points[effectiveEndIdx];
    const prevIsVerticalStep =
      Math.abs(prevStep.x - curStart.x) < EPS && Math.abs(prevStep.y - curStart.y) > EPS;
    const nextIsVerticalStep =
      Math.abs(nextStep.x - curEnd.x) < EPS && Math.abs(nextStep.y - curEnd.y) > EPS;
    if (prevIsVerticalStep && nextIsVerticalStep) {
      const beforeDir = Math.sign(curStart.y - prevStep.y);
      const afterDir = Math.sign(nextStep.y - curEnd.y);
      if (beforeDir !== 0 && afterDir !== 0 && beforeDir === afterDir) {
        effectiveStartIdx--;
        effectiveEndIdx++;
        // Absorb any additional collinear horizontal suffix after the new end.
        while (effectiveEndIdx < points.length - 1) {
          const next = points[effectiveEndIdx + 1];
          if (Math.abs(next.y - points[effectiveEndIdx].y) < EPS) {
            effectiveEndIdx++;
          } else {
            break;
          }
        }
      }
    }
  }

  const effectiveEnd = points[effectiveEndIdx];

  const subPoints = points.slice(effectiveStartIdx, effectiveEndIdx + 1);
  const avgY =
    subPoints.reduce((sum, p) => sum + p.y, 0) / (subPoints.length > 0 ? subPoints.length : 1);
  const labelMidY = (label.top + label.bottom) / 2;

  // Try routing above or below the label, preferring the side the original
  // subpath is already closer to.
  const preferredAbove = avgY <= labelMidY;
  const sides: ('above' | 'below')[] = preferredAbove ? ['above', 'below'] : ['below', 'above'];

  for (const side of sides) {
    const safeY = side === 'above' ? label.top - margin : label.bottom + margin;

    const newSub: { x: number; y: number }[] = [];
    newSub.push({ x: effectiveStart.x, y: effectiveStart.y });

    if (Math.abs(effectiveStart.y - safeY) > EPS) {
      newSub.push({ x: effectiveStart.x, y: safeY });
    }

    if (Math.abs(effectiveStart.x - effectiveEnd.x) > EPS) {
      newSub.push({ x: effectiveEnd.x, y: safeY });
    }

    if (Math.abs(effectiveEnd.y - safeY) > EPS || newSub.length === 1) {
      newSub.push({ x: effectiveEnd.x, y: effectiveEnd.y });
    } else {
      // If the last generated point already matches the end Y, just overwrite
      // its X so we end exactly at `effectiveEnd`.
      newSub[newSub.length - 1] = { x: effectiveEnd.x, y: effectiveEnd.y };
    }

    // Check that the new subpath does not intersect the label.
    let ok = true;
    for (let i = 0; i < newSub.length - 1; i++) {
      if (segmentIntersectsRect(newSub[i], newSub[i + 1], label, epsilon)) {
        ok = false;
        break;
      }
    }

    if (!ok) {
      continue;
    }

    // Splice the new subpath into the edge, replacing the original
    // [effectiveStartIdx..effectiveEndIdx] range.
    const prefix = points.slice(0, effectiveStartIdx);
    const suffix = points.slice(effectiveEndIdx + 1);

    const merged = [...prefix, ...newSub, ...suffix];

    // Remove duplicate consecutive points.
    const filtered: { x: number; y: number }[] = [];
    for (const p of merged) {
      const last = filtered[filtered.length - 1];
      if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
        filtered.push(p);
      }
    }

    edge.points = filtered;

    return true;
  }

  return false;
}

/**
 * Post-routing feedback loop: detect and fix edges that pass through
 * non-endpoint nodes. Runs iteratively until no intersections remain
 * (or max iterations reached).
 *
 * This catches issues the Raykov router misses due to:
 * - TB→LR coordinate transform changing clearance geometry
 * - Track compression pushing segments back inside obstacles
 * - Edge simplification losing obstacle-clearing bends
 */
function resolveEdgeNodeIntersections(layout: LayoutData): void {
  const nodes = layout.nodes ?? [];
  const edges = (layout.edges ?? []) as any[];

  if (!edges.length || !nodes.length) {
    return;
  }

  // Strategy 1: label positions are not decided yet (they are anchored to
  // the routed polyline after this pass), so edge-label nodes are not
  // obstacles here. Only real non-group nodes participate.
  const nodeRects: LabelRect[] = nodes
    .filter((n: any) => !n.isGroup && !n.isEdgeLabel)
    .map((n: any) => {
      const cx = n.x ?? 0;
      const cy = n.y ?? 0;
      const w = n.width ?? 0;
      const h = n.height ?? 0;
      return {
        nodeId: n.id as string,
        left: cx - w / 2,
        right: cx + w / 2,
        top: cy - h / 2,
        bottom: cy + h / 2,
      };
    });

  const epsilon = 2;
  const margin = 6;
  const maxGlobalIterations = 3;

  for (let globalIter = 0; globalIter < maxGlobalIterations; globalIter++) {
    let fixedAny = false;

    for (const edge of edges) {
      if (edge.isLayoutOnly) {
        continue;
      }
      const points = edge.points as { x: number; y: number }[] | undefined;
      if (!points || points.length < 2) {
        continue;
      }

      const edgeStart = edge.start as string | undefined;
      const edgeEnd = edge.end as string | undefined;

      // Up to 4 per-edge fix passes
      for (let iter = 0; iter < 4; iter++) {
        let candidate: LabelEdgeFixCandidate | undefined;

        for (const rect of nodeRects) {
          // Skip the edge's own endpoints (labels are already excluded from nodeRects)
          if (rect.nodeId === edgeStart || rect.nodeId === edgeEnd) {
            continue;
          }

          const intersectingSegIndices: number[] = [];
          for (let i = 0; i < points.length - 1; i++) {
            if (segmentIntersectsRect(points[i], points[i + 1], rect, epsilon)) {
              intersectingSegIndices.push(i);
            }
          }

          if (intersectingSegIndices.length > 0) {
            const startIdx = Math.min(...intersectingSegIndices);
            const endIdx = Math.max(...intersectingSegIndices) + 1;
            candidate = { edge, label: rect, startIdx, endIdx };
            break;
          }
        }

        if (!candidate) {
          break;
        }

        const fixed = rerouteSubpathAroundLabel(candidate, epsilon, margin);
        if (fixed) {
          fixedAny = true;
        } else {
          break;
        }
      }
    }

    if (!fixedAny) {
      break;
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

/**
 * Iter 17 — port-swap a 4-point H-V-H / V-H-V edge to a 3-point L-shape
 * when the current src port is "straight-through" (parallel to the
 * incoming edge) but a perpendicular src face permits a one-bend reach
 * to the existing dst port.
 *
 * Motivating case (user report 2026-04-16, 8-query-process-2.mmd):
 *   L_A2_E_0 currently:
 *     (A2.east=355.2, 0) → (gutter=402.3, 0)
 *       → (402.3, 213.4) → (E.west=844.1, 213.4)
 *   i.e. exits A2 on the east face (parallel to incoming A→A2), bends
 *   south, bends east — 2 interior bends. The south face of A2 points
 *   directly toward E's lane, so exiting south gives a 1-bend L-shape:
 *     (A2.south=cx±δ, 69.3) → (cx±δ, 213.4) → (E.west=844.1, 213.4)
 *   Saves one bend.
 *
 * Paper backing:
 *   - Tamassia's bend-minimization flow (1987, and
 *     Di Battista–Eades–Tamassia–Tollis §5): port/face assignment is a
 *     free variable and the optimum switches faces whenever it saves a
 *     bend.
 *   - Kandinsky port distribution (Fößmeier–Kaufmann 1995;
 *     Siebenhaller dissertation §2.3–§2.5): decision-diamond outgoing
 *     edges favor distinct perpendicular faces.
 *   - Siebenhaller §3.3 "Port Assignment" + §4.1 "Bend optimization":
 *     local port-swap accepted iff (a) bends strictly decrease, (b) no
 *     new crossings, (c) Kandinsky face-capacity preserved.
 *   - Hegemann–Wolff §4.2 joint-feasibility (paper src `b65b3d45`):
 *     the formal crossings + capacity guard set.
 *
 * Shape handled (src, dst NOT collinear):
 *   H-V-H:  p0 → p1 (horiz) → p2 (vert) → p3 (horiz);
 *           src face E/W (parallel to seg01); swap to N/S.
 *   V-H-V:  p0 → p1 (vert)  → p2 (horiz) → p3 (vert);
 *           src face N/S (parallel to seg01); swap to E/W.
 *
 * Rewrite (H-V-H):
 *   new_src_port = (src.cx + δ, dst-below ? src.bottom : src.top)
 *   new_polyline = [ new_src_port, (src.cx + δ, p3.y), p3 ]
 * (V-H-V symmetric across axes.)
 *
 * Safety (the six guards from the iter-17 plan):
 *   1. Strict bend-count decrease   — enforced by the 4-point → 3-point
 *                                     rewrite.
 *   2. No new edge-edge crossings    — segmentsCrossOrth vs every other
 *                                     non-self segment.
 *   3. No new edge-node collisions   — segmentHitsNode (both new segs,
 *                                     excluding src for seg-1 and dst
 *                                     for seg-2).
 *   4. Kandinsky face capacity       — port-offset delta chosen from
 *                                     0, ±PORT_SHIFT, ±2·PORT_SHIFT;
 *                                     each candidate must lie strictly
 *                                     within the src face span; the
 *                                     collinear-axis overlap check
 *                                     (shared axis + overlapping range)
 *                                     rejects δ values that collide
 *                                     with an existing sibling port.
 *   5. No label-rect overlap on new  — re-done by anchorLabelsToPolyline
 *      segments                        which runs after this pass.
 *   6. Monotonic on fixture suite    — enforced externally by the DDLT
 *                                     contract (no spec's totalBends or
 *                                     crossings may increase).
 *
 * Distinct from `coRouteSiblingsOnSharedFace` (iter 12) which handles
 * the COLLINEAR case (4-point → 2-point straight). This pass handles
 * the non-collinear case (4-point → 3-point L). The two are disjoint
 * by the collinearX === collinearY guard: coRoute runs first and
 * converts collinear edges to 2-point straights which this pass then
 * skips by shape filter.
 *
 * Distinct from Eiglsperger bend-stretching (cited in iter 16
 * collapseShortTerminalStub): that pass requires the first and last
 * direction to be preserved; this pass explicitly CHANGES the first
 * direction — the whole point.
 */
function portSwapToLShape(edges: any[], nodes: any[]): void {
  const EPS = 1e-6;
  // δ_s — the Kandinsky port-spacing constant (Fößmeier–Kaufmann 1995;
  // Siebenhaller dissertation §6.1.2.2). When this pass places a second
  // edge on a face already occupied by a sibling centered at delta=0,
  // the canonical pairing is (0, ±δ_s) — full δ_s separation between
  // port centers, not δ_s/2. `coRouteSiblingsOnSharedFace` uses δ_s/2
  // because that pass shifts BOTH members of a collinear pair
  // symmetrically (to ±δ_s/2, separation δ_s); this pass shifts only
  // the single edge being swapped, so it must move the full δ_s to
  // preserve the same canonical spacing.
  const MIN_PORT_SPACING = 8;
  const PORT_SHIFT = MIN_PORT_SPACING;

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

  // Axis-aligned segment-crossing detector (perpendicular crossings only,
  // T-intersections count), same semantics as scoreLayout.segmentsCross
  // and as the helper embedded in `coRouteSiblingsOnSharedFace`.
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

  // Collinear-axis overlap: two segments on the same axis at the same
  // coordinate with overlapping spans. Not flagged by segmentsCrossOrth
  // (perpendicular-only) but IS an edge overlap for scoreLayout and for
  // Kandinsky face-capacity (two ports at the same offset on the same
  // face).
  const segmentsOverlapAxis = (
    a1: { x: number; y: number },
    b1: { x: number; y: number },
    a2: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const s1H = Math.abs(a1.y - b1.y) < EPS;
    const s1V = Math.abs(a1.x - b1.x) < EPS;
    const s2H = Math.abs(a2.y - b2.y) < EPS;
    const s2V = Math.abs(a2.x - b2.x) < EPS;
    if (s1V && s2V && Math.abs(a1.x - a2.x) < EPS) {
      const m1 = Math.min(a1.y, b1.y);
      const M1 = Math.max(a1.y, b1.y);
      const m2 = Math.min(a2.y, b2.y);
      const M2 = Math.max(a2.y, b2.y);
      return M1 > m2 + EPS && M2 > m1 + EPS;
    }
    if (s1H && s2H && Math.abs(a1.y - a2.y) < EPS) {
      const m1 = Math.min(a1.x, b1.x);
      const M1 = Math.max(a1.x, b1.x);
      const m2 = Math.min(a2.x, b2.x);
      const M2 = Math.max(a2.x, b2.x);
      return M1 > m2 + EPS && M2 > m1 + EPS;
    }
    return false;
  };

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length < 4) {
      continue;
    }

    // Dedupe consecutive identical points (raykov / endpoint-clip can
    // produce duplicates). We operate on the DEDUPED polyline but write
    // back without duplicates too — the rendering-handoff pass later
    // re-duplicates endpoints for the intersect-rect guard.
    const deduped: { x: number; y: number }[] = [];
    for (const p of pts) {
      const last = deduped.length > 0 ? deduped[deduped.length - 1] : undefined;
      if (!last || Math.abs(p.x - last.x) > EPS || Math.abs(p.y - last.y) > EPS) {
        deduped.push(p);
      }
    }
    if (deduped.length !== 4) {
      continue;
    }

    const [p0, p1, p2, p3] = deduped;
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

    // Skip collinear src/dst — coRouteSiblingsOnSharedFace handles those.
    const collinearX = Math.abs(srcInfo.cx - dstInfo.cx) < EPS;
    const collinearY = Math.abs(srcInfo.cy - dstInfo.cy) < EPS;
    if (collinearX || collinearY) {
      continue;
    }

    // Build candidate new polyline.
    // H-V-H: swap src E/W face → N/S face. Preserve dst port (p3).
    //   new p0 = (src.cx + δ, dst-below ? src.bottom : src.top)
    //   new p1 = (src.cx + δ, p3.y)
    //   new p2 = p3
    // V-H-V symmetric.
    let newPts: { x: number; y: number }[] | undefined;
    const srcRect = srcInfo.rect;

    const tryDeltas = [0, PORT_SHIFT, -PORT_SHIFT, 2 * PORT_SHIFT, -2 * PORT_SHIFT];

    for (const delta of tryDeltas) {
      let np0: { x: number; y: number };
      let np1: { x: number; y: number };
      let np2: { x: number; y: number };

      if (isHVH) {
        const dstBelow = dstInfo.cy > srcInfo.cy;
        const newSrcY = dstBelow ? srcRect.bottom : srcRect.top;
        const newSrcX = srcInfo.cx + delta;
        // Must lie strictly within src face span (exclusive of corners).
        if (newSrcX <= srcRect.left + EPS || newSrcX >= srcRect.right - EPS) {
          continue;
        }
        np0 = { x: newSrcX, y: newSrcY };
        np1 = { x: newSrcX, y: p3.y };
        np2 = { x: p3.x, y: p3.y };
      } else {
        // isVHV
        const dstEast = dstInfo.cx > srcInfo.cx;
        const newSrcX = dstEast ? srcRect.right : srcRect.left;
        const newSrcY = srcInfo.cy + delta;
        if (newSrcY <= srcRect.top + EPS || newSrcY >= srcRect.bottom - EPS) {
          continue;
        }
        np0 = { x: newSrcX, y: newSrcY };
        np1 = { x: p3.x, y: newSrcY };
        np2 = { x: p3.x, y: p3.y };
      }

      // Degenerate: if np1 === np2, the "L" collapses to a straight line.
      // Accept it (even better than a 1-bend L), but keep it as 2 pts.
      const firstSegDegenerate = Math.abs(np0.x - np1.x) < EPS && Math.abs(np0.y - np1.y) < EPS;
      const secondSegDegenerate = Math.abs(np1.x - np2.x) < EPS && Math.abs(np1.y - np2.y) < EPS;
      if (firstSegDegenerate && secondSegDegenerate) {
        continue;
      }

      // Guard 3: no edge-node collisions. Seg 1 may touch src; seg 2 may
      // touch dst. Excluding those ids from the hit check.
      if (!firstSegDegenerate && segmentHitsNode(np0, np1, [srcId])) {
        continue;
      }
      if (!secondSegDegenerate && segmentHitsNode(np1, np2, [dstId])) {
        continue;
      }

      // Guard 5: label overlap is checked by anchorLabelsToPolyline which
      // runs AFTER this pass and re-anchors each label onto its owning
      // edge's polyline (with along-segment parametric retry from iter
      // 14). At this pipeline stage labels still sit at stale Sugiyama
      // positions so a label-rect check here would reject against
      // positions that will imminently be moved. If anchorLabelsToPolyline
      // cannot find any legal anchor on the rewritten polyline,
      // validateLayout's label-on-edge-segment invariant will flag it at
      // DDLT level 1. Deliberately not checked here.

      // Guards 2 + 4: check every other edge's every segment for a
      // perpendicular crossing or a collinear-axis overlap with EITHER
      // of the new segments.
      let conflict = false;
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
          const oa = opts[i];
          const ob = opts[i + 1];
          if (Math.abs(oa.x - ob.x) < EPS && Math.abs(oa.y - ob.y) < EPS) {
            continue; // zero-length segment of the other edge
          }
          if (!firstSegDegenerate) {
            if (segmentsCrossOrth(np0, np1, oa, ob)) {
              conflict = true;
              break;
            }
            if (segmentsOverlapAxis(np0, np1, oa, ob)) {
              conflict = true;
              break;
            }
          }
          if (!secondSegDegenerate) {
            if (segmentsCrossOrth(np1, np2, oa, ob)) {
              conflict = true;
              break;
            }
            if (segmentsOverlapAxis(np1, np2, oa, ob)) {
              conflict = true;
              break;
            }
          }
        }
        if (conflict) {
          break;
        }
      }
      if (conflict) {
        continue;
      }

      // All guards pass. Build the final polyline.
      if (firstSegDegenerate) {
        newPts = [np1, np2];
      } else if (secondSegDegenerate) {
        newPts = [np0, np1];
      } else {
        newPts = [np0, np1, np2];
      }
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `portSwapToLShape: swapped ${edgeId} src port → ${isHVH ? 'N/S' : 'E/W'} face (delta=${delta}); bends ${deduped.length - 2} → ${newPts.length - 2}`
      );
      break;
    }

    if (newPts) {
      (edge as { points?: { x: number; y: number }[] }).points = newPts;
    }
  }
}

/**
 * Iter 16 — collapse a short terminal stub at an edge's destination by
 * retargeting the destination face and dropping the corner. See the call-
 * site comment in `applySwimlaneDirectionTransform` for the user report and
 * paper backing (Siebenhaller `21f7ca55`; precedent in
 * `straightenStalePortOffsets`, Hegemann-Wolff `b65b3d45`).
 *
 * Shape handled:
 *   ... → prev → penult → end
 *                ~~~~~~~~~~~~~
 *                penult perpendicular to last; `|end - penult| < MIN_STUB`.
 *
 * Rewrite:
 *   ... → prev' → end'
 *   where prev' keeps prev's "far" coordinate and adopts the destination's
 *   face-center on the other axis, and end' is the destination face-center
 *   on the approach axis (i.e. bottom/top when penult is vertical;
 *   left/right when penult is horizontal — face chosen opposite to the
 *   approach direction).
 *
 * Safety:
 *   - Reject when the new prev'→end' segment would enter any real-node
 *     rect (excluding the dst itself), any label rect, or cross an
 *     existing segment of a different edge (excluding its own segments).
 *   - Reject when the new prev' lies inside the src node's rect.
 *   - Only applied to the dst end; applying symmetrically on src
 *     would need identical safety accounting and is out of scope here.
 */
function collapseShortTerminalStub(edges: any[], nodeByIdMap: Map<string, any>): void {
  const MIN_STUB = 10;
  const EPS_LOCAL = 1e-3;
  const BUFFER = 2;

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  const realNodeRects: { id: string; rect: RectLite }[] = [];
  const labelRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    if ((n as { isGroup?: boolean }).isGroup) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    const id = String((n as { id?: string }).id ?? '');
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      labelRects.push({ id, rect });
    } else {
      realNodeRects.push({ id, rect });
    }
  }

  const segHitsRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: RectLite,
    buffer: number
  ): boolean => {
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    return (
      segMaxX > r.left - buffer &&
      segMinX < r.right + buffer &&
      segMaxY > r.top - buffer &&
      segMinY < r.bottom + buffer
    );
  };

  // Orthogonal segment pair intersection test (T-junctions and crossings).
  // Returns true only when one is horizontal and the other vertical AND they
  // cross strictly in the interior; collinear / shared-endpoint cases
  // are not considered crossings here.
  const segmentsCross = (
    a1: { x: number; y: number },
    a2: { x: number; y: number },
    b1: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const aHoriz = Math.abs(a1.y - a2.y) < EPS_LOCAL;
    const aVert = Math.abs(a1.x - a2.x) < EPS_LOCAL;
    const bHoriz = Math.abs(b1.y - b2.y) < EPS_LOCAL;
    const bVert = Math.abs(b1.x - b2.x) < EPS_LOCAL;
    if ((aHoriz && bVert) || (aVert && bHoriz)) {
      const hA = aHoriz ? { a: a1, b: a2 } : { a: b1, b: b2 };
      const vA = aHoriz ? { a: b1, b: b2 } : { a: a1, b: a2 };
      const hY = hA.a.y;
      const hXmin = Math.min(hA.a.x, hA.b.x);
      const hXmax = Math.max(hA.a.x, hA.b.x);
      const vX = vA.a.x;
      const vYmin = Math.min(vA.a.y, vA.b.y);
      const vYmax = Math.max(vA.a.y, vA.b.y);
      return (
        vX > hXmin + EPS_LOCAL &&
        vX < hXmax - EPS_LOCAL &&
        hY > vYmin + EPS_LOCAL &&
        hY < vYmax - EPS_LOCAL
      );
    }
    return false;
  };

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const rawPts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!rawPts || rawPts.length < 4) {
      continue;
    }

    // Dedupe consecutive equal points so we measure the real last segment.
    const pts: { x: number; y: number }[] = [];
    for (const p of rawPts) {
      const last = pts.length > 0 ? pts[pts.length - 1] : undefined;
      if (!last || Math.abs(p.x - last.x) > EPS_LOCAL || Math.abs(p.y - last.y) > EPS_LOCAL) {
        pts.push(p);
      }
    }
    if (pts.length < 4) {
      continue;
    }

    const nLast = pts.length - 1;
    const endPt = pts[nLast];
    const penultPt = pts[nLast - 1];
    const prevPt = pts[nLast - 2];

    // Last segment (penult → end): must be short.
    const lastDx = endPt.x - penultPt.x;
    const lastDy = endPt.y - penultPt.y;
    const lastLen = Math.hypot(lastDx, lastDy);
    if (lastLen >= MIN_STUB || lastLen < EPS_LOCAL) {
      continue;
    }

    // Penult segment (prev → penult): must be non-degenerate and
    // perpendicular to last.
    const penultDx = penultPt.x - prevPt.x;
    const penultDy = penultPt.y - prevPt.y;
    const penultLen = Math.hypot(penultDx, penultDy);
    if (penultLen < EPS_LOCAL) {
      continue;
    }

    const lastIsHoriz = Math.abs(lastDy) < EPS_LOCAL && Math.abs(lastDx) > EPS_LOCAL;
    const lastIsVert = Math.abs(lastDx) < EPS_LOCAL && Math.abs(lastDy) > EPS_LOCAL;
    const penultIsHoriz = Math.abs(penultDy) < EPS_LOCAL && Math.abs(penultDx) > EPS_LOCAL;
    const penultIsVert = Math.abs(penultDx) < EPS_LOCAL && Math.abs(penultDy) > EPS_LOCAL;
    if (!((lastIsHoriz && penultIsVert) || (lastIsVert && penultIsHoriz))) {
      continue;
    }

    const dstId = (edge as { end?: string }).end;
    const srcId = (edge as { start?: string }).start;
    const edgeId = String((edge as { id?: string }).id ?? '');
    const dst = dstId ? nodeByIdMap.get(dstId) : undefined;
    if (!dst) {
      continue;
    }
    const dstCx = (dst as { x?: number }).x ?? 0;
    const dstCy = (dst as { y?: number }).y ?? 0;
    const dstW = (dst as { width?: number }).width ?? 0;
    const dstH = (dst as { height?: number }).height ?? 0;
    if (dstW <= 0 || dstH <= 0) {
      continue;
    }
    const dstLeft = dstCx - dstW / 2;
    const dstRight = dstCx + dstW / 2;
    const dstTop = dstCy - dstH / 2;
    const dstBottom = dstCy + dstH / 2;

    // Compute the new prev' and end'. The axis of approach is the
    // penult segment's axis; the new face is on the perpendicular to
    // the approach, opposite to the approach direction.
    let newPrev: { x: number; y: number };
    let newEnd: { x: number; y: number };
    if (penultIsVert) {
      // Vertical approach: penult goes up (penultDy<0) or down (penultDy>0).
      const approachFromBelow = penultDy < 0;
      newPrev = { x: dstCx, y: prevPt.y };
      newEnd = { x: dstCx, y: approachFromBelow ? dstBottom : dstTop };
    } else {
      // Horizontal approach: penult goes right (penultDx>0) or left.
      const approachFromLeft = penultDx > 0;
      newPrev = { x: prevPt.x, y: dstCy };
      newEnd = { x: approachFromLeft ? dstRight : dstLeft, y: dstCy };
    }

    // Reject if the new prev'→end' vertical/horizontal segment would cross
    // any real-node rect (other than dst itself).
    let blocked = false;
    for (const rn of realNodeRects) {
      if (rn.id === dstId) {
        continue;
      }
      if (segHitsRect(newPrev, newEnd, rn.rect, BUFFER)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }

    // Reject if the new approach segment would run through any label rect.
    for (const lr of labelRects) {
      if (segHitsRect(newPrev, newEnd, lr.rect, BUFFER)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }

    // Reject if new prev' lies inside the src node's rect (pathological).
    if (srcId) {
      const src = nodeByIdMap.get(srcId);
      const srcCx = (src as { x?: number })?.x ?? 0;
      const srcCy = (src as { y?: number })?.y ?? 0;
      const srcW = (src as { width?: number })?.width ?? 0;
      const srcH = (src as { height?: number })?.height ?? 0;
      if (srcW > 0 && srcH > 0) {
        const srcL = srcCx - srcW / 2;
        const srcR = srcCx + srcW / 2;
        const srcT = srcCy - srcH / 2;
        const srcB = srcCy + srcH / 2;
        if (
          newPrev.x > srcL + BUFFER &&
          newPrev.x < srcR - BUFFER &&
          newPrev.y > srcT + BUFFER &&
          newPrev.y < srcB - BUFFER
        ) {
          continue;
        }
      }
    }

    // Also reject if the new prev'→end' segment crosses any other edge's
    // existing segment (excluding our own segments we're about to replace).
    const ownSegmentKey = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      `${a.x.toFixed(3)},${a.y.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)}`;
    const selfSegments = new Set<string>();
    for (let i = 0; i < pts.length - 1; i++) {
      selfSegments.add(ownSegmentKey(pts[i], pts[i + 1]));
    }
    for (const other of edges) {
      if (other === edge) {
        continue;
      }
      if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const oPts = (other as { points?: { x: number; y: number }[] }).points;
      if (!oPts || oPts.length < 2) {
        continue;
      }
      for (let i = 0; i < oPts.length - 1; i++) {
        const a = oPts[i];
        const b = oPts[i + 1];
        if (selfSegments.has(ownSegmentKey(a, b))) {
          continue;
        }
        if (segmentsCross(newPrev, newEnd, a, b)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        break;
      }
    }
    if (blocked) {
      continue;
    }

    // Also: if the new prev' segment (from prev-before-prev to newPrev) is
    // degenerate or crosses anything, reject. The segment before the
    // original prev (pts[nLast-3] → prev) becomes (pts[nLast-3] → newPrev)
    // when we shift prev's axis.
    if (nLast - 3 >= 0) {
      const beforePrev = pts[nLast - 3];
      // The pre-existing segment was beforePrev → prev on the axis perpendicular
      // to penult. Shifting prev to newPrev preserves that axis alignment
      // (only the axis we're shifting changes). Re-check for obstacles on
      // the NEW extended segment.
      for (const rn of realNodeRects) {
        if (rn.id === srcId || rn.id === dstId) {
          continue;
        }
        if (segHitsRect(beforePrev, newPrev, rn.rect, BUFFER)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
          continue;
        }
        const oPts = (other as { points?: { x: number; y: number }[] }).points;
        if (!oPts || oPts.length < 2) {
          continue;
        }
        for (let i = 0; i < oPts.length - 1; i++) {
          const a = oPts[i];
          const b = oPts[i + 1];
          if (selfSegments.has(ownSegmentKey(a, b))) {
            continue;
          }
          if (segmentsCross(beforePrev, newPrev, a, b)) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          break;
        }
      }
      if (blocked) {
        continue;
      }
    }

    // Build rewritten polyline: pts[0..nLast-3] + newPrev + newEnd.
    // This drops the original prev, penult, and end; replaces with newPrev
    // and newEnd (one fewer bend).
    const head = pts.slice(0, nLast - 2);
    const newPts = [...head, newPrev, newEnd];
    (edge as { points: { x: number; y: number }[] }).points = newPts;

    // Re-anchor the edge's label (if any) onto the new polyline. The
    // original anchorLabelsToPolyline pass ran earlier in the pipeline
    // and placed the label against the old geometry; validateLayout
    // requires the polyline to pass through its label node. Place the
    // label at the midpoint of the longest segment of the new polyline
    // whose orientation matches the label's aspect.
    const labelId = (edge as { labelNodeId?: string }).labelNodeId;
    if (labelId) {
      const labelNode = nodeByIdMap.get(labelId);
      if (labelNode) {
        const lw = (labelNode as { width?: number }).width ?? 0;
        const lh = (labelNode as { height?: number }).height ?? 0;
        if (lw > 0 && lh > 0) {
          // Find longest segment — use its midpoint. Prefer axis-aligned
          // segments whose length >= the label's corresponding dim so
          // the label fits inside the segment's bounding run.
          let bestMidX: number | undefined;
          let bestMidY: number | undefined;
          let bestLen = -1;
          for (let i = 0; i < newPts.length - 1; i++) {
            const a = newPts[i];
            const b = newPts[i + 1];
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            const isHoriz = Math.abs(a.y - b.y) < EPS_LOCAL;
            const isVert = Math.abs(a.x - b.x) < EPS_LOCAL;
            // Require axis-aligned and long enough to hold the label.
            const fits = (isHoriz && segLen >= lw + 2) || (isVert && segLen >= lh + 2);
            if (!fits) {
              continue;
            }
            if (segLen > bestLen) {
              bestLen = segLen;
              bestMidX = (a.x + b.x) / 2;
              bestMidY = (a.y + b.y) / 2;
            }
          }
          if (bestMidX !== undefined && bestMidY !== undefined) {
            (labelNode as { x: number }).x = bestMidX;
            (labelNode as { y: number }).y = bestMidY;
          }
        }
      }
    }

    log.debug(
      SWIMLANE_DIR_LOG_PREFIX,
      `collapseShortTerminalStub: rewrote ${edgeId} — stub was ${lastLen.toFixed(2)}, retargeted dst face`
    );
  }
}

/**
 * Iter 17 — Wybrow-style post-route nudge for interior vertical segments
 * that run too close to a large obstacle's side face. See call-site comment
 * in `applySwimlaneDirectionTransform` for paper backing (Wybrow `e8804c93`,
 * Hegemann & Wolff `b65b3d45`, Gladisch `32fe421c`).
 *
 * For each edge and each interior vertical segment (indices 1..len-3,
 * where `len` is the deduped point count and the adjacent segments are
 * both axis-aligned horizontals), we:
 *
 *   1. Identify the "alley" — the nearest real-node face to the LEFT and
 *      to the RIGHT of the segment, restricted to nodes whose y-span
 *      overlaps the segment's y-span. (Src/dst of the edge are excluded
 *      because their faces are the edge's own endpoints.) A node that
 *      straddles the segment's x bails the nudge for safety.
 *   2. Compute `gapLeft` and `gapRight`. If the nearer gap is
 *      `>= MIN_CLEARANCE`, the segment is already well-placed — skip.
 *   3. Pick a `targetX` toward the alley centre, clamped so both sides
 *      have `>= MIN_CLEARANCE` when possible (for narrow alleys, settle
 *      for the centre; we will still improve over the baseline in that
 *      case).
 *   4. Safety-gate the move against real-node rects, other-edge
 *      crossings, and edge-label rects (mirroring collapseShortTerminalStub).
 *   5. If gated out, leave the segment untouched — no regression possible.
 *
 * The pass preserves stubs (first/last segment) and never changes the
 * orientation of any segment (only shifts the x of a vertical). It is
 * idempotent on routes that already respect MIN_CLEARANCE.
 *
 * Scope note: only operates on vertical segments in this iteration —
 * horizontal nudging is symmetric but out of scope (the user-reported
 * symptom is a vertical hug). Adding horizontal nudging later is a
 * mechanical mirror of this function.
 */
function nudgeInteriorVerticalsFromObstacles(edges: any[], nodeByIdMap: Map<string, any>): void {
  const MIN_CLEARANCE = 20; // Gladisch δ — safety gap
  const EPS_LOCAL = 1e-3;
  const BUFFER = 2;

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  const realNodeRects: { id: string; rect: RectLite }[] = [];
  const labelRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    if ((n as { isGroup?: boolean }).isGroup) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    const id = String((n as { id?: string }).id ?? '');
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      labelRects.push({ id, rect });
    } else {
      realNodeRects.push({ id, rect });
    }
  }

  const segHitsRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: RectLite,
    buffer: number
  ): boolean => {
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    return (
      segMaxX > r.left - buffer &&
      segMinX < r.right + buffer &&
      segMaxY > r.top - buffer &&
      segMinY < r.bottom + buffer
    );
  };

  // Orthogonal segment crossing test (strict interior crossing of one
  // horizontal with one vertical; shared endpoints and collinear
  // overlaps are not considered crossings).
  const segmentsCross = (
    a1: { x: number; y: number },
    a2: { x: number; y: number },
    b1: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const aHoriz = Math.abs(a1.y - a2.y) < EPS_LOCAL;
    const aVert = Math.abs(a1.x - a2.x) < EPS_LOCAL;
    const bHoriz = Math.abs(b1.y - b2.y) < EPS_LOCAL;
    const bVert = Math.abs(b1.x - b2.x) < EPS_LOCAL;
    if ((aHoriz && bVert) || (aVert && bHoriz)) {
      const hA = aHoriz ? { a: a1, b: a2 } : { a: b1, b: b2 };
      const vA = aHoriz ? { a: b1, b: b2 } : { a: a1, b: a2 };
      const hY = hA.a.y;
      const hXmin = Math.min(hA.a.x, hA.b.x);
      const hXmax = Math.max(hA.a.x, hA.b.x);
      const vX = vA.a.x;
      const vYmin = Math.min(vA.a.y, vA.b.y);
      const vYmax = Math.max(vA.a.y, vA.b.y);
      return (
        vX > hXmin + EPS_LOCAL &&
        vX < hXmax - EPS_LOCAL &&
        hY > vYmin + EPS_LOCAL &&
        hY < vYmax - EPS_LOCAL
      );
    }
    return false;
  };

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const rawPts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!rawPts || rawPts.length < 4) {
      continue;
    }

    // Dedupe consecutive equal points so interior indices are accurate.
    const pts: { x: number; y: number }[] = [];
    for (const p of rawPts) {
      const last = pts.length > 0 ? pts[pts.length - 1] : undefined;
      if (!last || Math.abs(p.x - last.x) > EPS_LOCAL || Math.abs(p.y - last.y) > EPS_LOCAL) {
        pts.push(p);
      }
    }
    if (pts.length < 4) {
      continue;
    }

    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const edgeId = String((edge as { id?: string }).id ?? '');

    let changed = false;
    let working = [...pts];
    // Iterate interior vertical segments (indices 1 .. len-3).
    for (let i = 1; i <= working.length - 3; i++) {
      const a = working[i];
      const b = working[i + 1];
      const isVertical = Math.abs(a.x - b.x) < EPS_LOCAL && Math.abs(a.y - b.y) > EPS_LOCAL;
      if (!isVertical) {
        continue;
      }
      const before = working[i - 1];
      const after = working[i + 2];
      const beforeHoriz =
        Math.abs(before.y - a.y) < EPS_LOCAL && Math.abs(before.x - a.x) > EPS_LOCAL;
      const afterHoriz = Math.abs(after.y - b.y) < EPS_LOCAL && Math.abs(after.x - b.x) > EPS_LOCAL;
      if (!beforeHoriz || !afterHoriz) {
        continue;
      }

      const segX = a.x;
      const segYmin = Math.min(a.y, b.y);
      const segYmax = Math.max(a.y, b.y);

      // Compute the alley bounds: nearest obstacle face on each side
      // restricted to obstacles whose y-range overlaps the segment.
      let alleyLeft = -Infinity;
      let alleyRight = Infinity;
      let straddle = false;
      for (const rn of realNodeRects) {
        if (rn.id === srcId || rn.id === dstId) {
          continue;
        }
        const r = rn.rect;
        // y-overlap of obstacle with the segment (strict)
        if (r.bottom <= segYmin + EPS_LOCAL || r.top >= segYmax - EPS_LOCAL) {
          continue;
        }
        if (r.right < segX - EPS_LOCAL) {
          if (r.right > alleyLeft) {
            alleyLeft = r.right;
          }
        } else if (r.left > segX + EPS_LOCAL) {
          if (r.left < alleyRight) {
            alleyRight = r.left;
          }
        } else {
          // Obstacle overlaps the segment's x — the router has already
          // decided to pass through this x. Bail the nudge for safety.
          straddle = true;
          break;
        }
      }
      if (straddle) {
        continue;
      }

      const gapLeft = alleyLeft === -Infinity ? Infinity : segX - alleyLeft;
      const gapRight = alleyRight === Infinity ? Infinity : alleyRight - segX;
      const nearerGap = Math.min(gapLeft, gapRight);
      if (nearerGap >= MIN_CLEARANCE) {
        continue; // already well-placed
      }

      // Pick targetX toward alley centre, clamped to >= MIN_CLEARANCE
      // on each side when possible.
      let targetX: number;
      if (alleyLeft !== -Infinity && alleyRight !== Infinity) {
        if (alleyRight - alleyLeft < 2 * MIN_CLEARANCE) {
          // Alley too narrow to guarantee MIN_CLEARANCE on both sides —
          // settle for centre.
          targetX = (alleyLeft + alleyRight) / 2;
        } else {
          const centre = (alleyLeft + alleyRight) / 2;
          targetX = Math.max(
            alleyLeft + MIN_CLEARANCE,
            Math.min(alleyRight - MIN_CLEARANCE, centre)
          );
        }
      } else if (alleyLeft !== -Infinity) {
        targetX = alleyLeft + MIN_CLEARANCE;
      } else if (alleyRight !== Infinity) {
        targetX = alleyRight - MIN_CLEARANCE;
      } else {
        continue; // no obstacles within y-span, don't move
      }

      // No-op guard
      if (Math.abs(targetX - segX) < EPS_LOCAL) {
        continue;
      }

      const newA = { x: targetX, y: a.y };
      const newB = { x: targetX, y: b.y };
      const newBeforeHorizA = before;
      const newBeforeHorizB = newA;
      const newAfterHorizA = newB;
      const newAfterHorizB = after;

      // Gate (c): real-node rect collision for all three affected segments.
      let blocked = false;
      for (const rn of realNodeRects) {
        if (rn.id === srcId || rn.id === dstId) {
          continue;
        }
        if (
          segHitsRect(newA, newB, rn.rect, BUFFER) ||
          segHitsRect(newBeforeHorizA, newBeforeHorizB, rn.rect, BUFFER) ||
          segHitsRect(newAfterHorizA, newAfterHorizB, rn.rect, BUFFER)
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }

      // Gate (d): other-edge crossings. Skip own segments.
      const ownSegmentKey = (p: { x: number; y: number }, q: { x: number; y: number }) =>
        `${p.x.toFixed(3)},${p.y.toFixed(3)}|${q.x.toFixed(3)},${q.y.toFixed(3)}`;
      const selfSegments = new Set<string>();
      for (let k = 0; k < working.length - 1; k++) {
        selfSegments.add(ownSegmentKey(working[k], working[k + 1]));
        selfSegments.add(ownSegmentKey(working[k + 1], working[k]));
      }
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
          continue;
        }
        const oPts = (other as { points?: { x: number; y: number }[] }).points;
        if (!oPts || oPts.length < 2) {
          continue;
        }
        for (let j = 0; j < oPts.length - 1; j++) {
          const p1 = oPts[j];
          const p2 = oPts[j + 1];
          if (selfSegments.has(ownSegmentKey(p1, p2))) {
            continue;
          }
          if (
            segmentsCross(newA, newB, p1, p2) ||
            segmentsCross(newBeforeHorizA, newBeforeHorizB, p1, p2) ||
            segmentsCross(newAfterHorizA, newAfterHorizB, p1, p2)
          ) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          break;
        }
      }
      if (blocked) {
        continue;
      }

      // Gate (e): edge-label rect collision.
      for (const lr of labelRects) {
        if (
          segHitsRect(newA, newB, lr.rect, BUFFER) ||
          segHitsRect(newBeforeHorizA, newBeforeHorizB, lr.rect, BUFFER) ||
          segHitsRect(newAfterHorizA, newAfterHorizB, lr.rect, BUFFER)
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }

      // Apply the shift.
      working = working.map((p, idx) => (idx === i ? newA : idx === i + 1 ? newB : p));
      changed = true;
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `nudgeInteriorVerticalsFromObstacles: ${edgeId} seg ${i}-${i + 1} x ${segX.toFixed(2)} → ${targetX.toFixed(2)} (alley [${alleyLeft === -Infinity ? '-∞' : alleyLeft.toFixed(2)}, ${alleyRight === Infinity ? '∞' : alleyRight.toFixed(2)}])`
      );
    }

    if (changed) {
      // Re-anchor the edge label if it now sits off the shifted polyline.
      // The shift may have moved a vertical segment out from under a label
      // that was previously centered on it; validateLayout enforces that
      // the polyline passes through the label node. Only re-anchor if
      // necessary (idempotent otherwise).
      (edge as { points: { x: number; y: number }[] }).points = working;
      const labelId = (edge as { labelNodeId?: string }).labelNodeId;
      if (labelId) {
        const labelNode = nodeByIdMap.get(labelId);
        if (labelNode) {
          const lw = (labelNode as { width?: number }).width ?? 0;
          const lh = (labelNode as { height?: number }).height ?? 0;
          const lx = (labelNode as { x?: number }).x ?? 0;
          const ly = (labelNode as { y?: number }).y ?? 0;
          if (lw > 0 && lh > 0) {
            // Check whether the current label centre still lies on some
            // segment of the new polyline (axis-aligned containment).
            let onPolyline = false;
            for (let k = 0; k < working.length - 1; k++) {
              const p = working[k];
              const q = working[k + 1];
              const isHoriz = Math.abs(p.y - q.y) < EPS_LOCAL;
              const isVert = Math.abs(p.x - q.x) < EPS_LOCAL;
              if (isHoriz && Math.abs(ly - p.y) < EPS_LOCAL) {
                const xMin = Math.min(p.x, q.x);
                const xMax = Math.max(p.x, q.x);
                if (lx >= xMin - EPS_LOCAL && lx <= xMax + EPS_LOCAL) {
                  onPolyline = true;
                  break;
                }
              } else if (isVert && Math.abs(lx - p.x) < EPS_LOCAL) {
                const yMin = Math.min(p.y, q.y);
                const yMax = Math.max(p.y, q.y);
                if (ly >= yMin - EPS_LOCAL && ly <= yMax + EPS_LOCAL) {
                  onPolyline = true;
                  break;
                }
              }
            }
            if (!onPolyline) {
              // Re-anchor to the longest axis-aligned segment that fits.
              let bestMidX: number | undefined;
              let bestMidY: number | undefined;
              let bestLen = -1;
              for (let k = 0; k < working.length - 1; k++) {
                const p = working[k];
                const q = working[k + 1];
                const segLen = Math.hypot(q.x - p.x, q.y - p.y);
                const isHoriz = Math.abs(p.y - q.y) < EPS_LOCAL;
                const isVert = Math.abs(p.x - q.x) < EPS_LOCAL;
                const fits = (isHoriz && segLen >= lw + 2) || (isVert && segLen >= lh + 2);
                if (!fits) {
                  continue;
                }
                if (segLen > bestLen) {
                  bestLen = segLen;
                  bestMidX = (p.x + q.x) / 2;
                  bestMidY = (p.y + q.y) / 2;
                }
              }
              if (bestMidX !== undefined && bestMidY !== undefined) {
                (labelNode as { x: number }).x = bestMidX;
                (labelNode as { y: number }).y = bestMidY;
              }
            }
          }
        }
      }
    }
  }
}

function nudgeSharedInteriorSubpaths(edges: any[], nodeByIdMap: Map<string, any>): void {
  const EPS_LOCAL = 1e-3;
  const MIN_SHARED = 8;
  const TRACK_SHIFT = 7;
  const BUFFER = 2;
  const MAX_ITERATIONS = 12;

  interface PointLite {
    x: number;
    y: number;
  }

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  interface SegmentLite {
    edge: any;
    edgeId: string;
    index: number;
    a: PointLite;
    b: PointLite;
    horizontal: boolean;
    vertical: boolean;
    interior: boolean;
  }

  const realNodeRects: { id: string; rect: RectLite }[] = [];
  const labelRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    if ((n as { isGroup?: boolean }).isGroup) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    const id = String((n as { id?: string }).id ?? '');
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      labelRects.push({ id, rect });
    } else {
      realNodeRects.push({ id, rect });
    }
  }

  const dedupe = (points: PointLite[]): PointLite[] => {
    const result: PointLite[] = [];
    for (const p of points) {
      const last = result.length > 0 ? result[result.length - 1] : undefined;
      if (!last || Math.abs(p.x - last.x) > EPS_LOCAL || Math.abs(p.y - last.y) > EPS_LOCAL) {
        result.push({ x: p.x, y: p.y });
      }
    }
    return result;
  };

  const isHorizontal = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.y - b.y) < EPS_LOCAL && Math.abs(a.x - b.x) > EPS_LOCAL;

  const isVertical = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.x - b.x) < EPS_LOCAL && Math.abs(a.y - b.y) > EPS_LOCAL;

  const overlapLength = (a1: number, a2: number, b1: number, b2: number): number =>
    Math.max(
      0,
      Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
    );

  const sameAxisOverlap = (a: SegmentLite, b: SegmentLite): number => {
    if (a.horizontal && b.horizontal && Math.abs(a.a.y - b.a.y) < EPS_LOCAL) {
      return overlapLength(a.a.x, a.b.x, b.a.x, b.b.x);
    }
    if (a.vertical && b.vertical && Math.abs(a.a.x - b.a.x) < EPS_LOCAL) {
      return overlapLength(a.a.y, a.b.y, b.a.y, b.b.y);
    }
    return 0;
  };

  const segmentHitsRect = (a: PointLite, b: PointLite, r: RectLite, buffer: number): boolean => {
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    return (
      segMaxX > r.left - buffer &&
      segMinX < r.right + buffer &&
      segMaxY > r.top - buffer &&
      segMinY < r.bottom + buffer
    );
  };

  const segmentsCrossStrict = (
    a1: PointLite,
    a2: PointLite,
    b1: PointLite,
    b2: PointLite
  ): boolean => {
    const aHoriz = isHorizontal(a1, a2);
    const aVert = isVertical(a1, a2);
    const bHoriz = isHorizontal(b1, b2);
    const bVert = isVertical(b1, b2);
    if (!((aHoriz && bVert) || (aVert && bHoriz))) {
      return false;
    }
    const h = aHoriz ? { a: a1, b: a2 } : { a: b1, b: b2 };
    const v = aHoriz ? { a: b1, b: b2 } : { a: a1, b: a2 };
    const hY = h.a.y;
    const hXMin = Math.min(h.a.x, h.b.x);
    const hXMax = Math.max(h.a.x, h.b.x);
    const vX = v.a.x;
    const vYMin = Math.min(v.a.y, v.b.y);
    const vYMax = Math.max(v.a.y, v.b.y);
    return (
      vX > hXMin + EPS_LOCAL &&
      vX < hXMax - EPS_LOCAL &&
      hY > vYMin + EPS_LOCAL &&
      hY < vYMax - EPS_LOCAL
    );
  };

  const segmentsFor = (edge: any, points: PointLite[]): SegmentLite[] => {
    const result: SegmentLite[] = [];
    const edgeId = String((edge as { id?: string }).id ?? '');
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const horizontal = isHorizontal(a, b);
      const vertical = isVertical(a, b);
      if (!horizontal && !vertical) {
        continue;
      }
      result.push({
        edge,
        edgeId,
        index: i,
        a,
        b,
        horizontal,
        vertical,
        interior: i >= 1 && i <= points.length - 3,
      });
    }
    return result;
  };

  const allSegments = (): SegmentLite[] => {
    const result: SegmentLite[] = [];
    for (const edge of edges) {
      if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const points = (edge as { points?: PointLite[] }).points;
      if (!points || points.length < 2) {
        continue;
      }
      result.push(...segmentsFor(edge, dedupe(points)));
    }
    return result;
  };

  const candidateIsSafe = (edge: any, candidate: PointLite[]): boolean => {
    const sourceId = (edge as { start?: string }).start;
    const targetId = (edge as { end?: string }).end;
    const candidateSegments = segmentsFor(edge, candidate);
    if (candidateSegments.length !== candidate.length - 1) {
      return false;
    }

    for (const segment of candidateSegments) {
      for (const nodeRect of realNodeRects) {
        if (nodeRect.id === sourceId || nodeRect.id === targetId) {
          continue;
        }
        if (segmentHitsRect(segment.a, segment.b, nodeRect.rect, BUFFER)) {
          return false;
        }
      }
      for (const labelRect of labelRects) {
        if (segmentHitsRect(segment.a, segment.b, labelRect.rect, BUFFER)) {
          return false;
        }
      }
    }

    for (const other of edges) {
      if (other === edge || (other as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const otherPoints = (other as { points?: PointLite[] }).points;
      if (!otherPoints || otherPoints.length < 2) {
        continue;
      }
      for (const candidateSegment of candidateSegments) {
        for (const otherSegment of segmentsFor(other, dedupe(otherPoints))) {
          if (sameAxisOverlap(candidateSegment, otherSegment) >= MIN_SHARED) {
            return false;
          }
          if (
            segmentsCrossStrict(
              candidateSegment.a,
              candidateSegment.b,
              otherSegment.a,
              otherSegment.b
            )
          ) {
            return false;
          }
        }
      }
    }

    return true;
  };

  const shiftedCandidate = (segment: SegmentLite, shift: number): PointLite[] | undefined => {
    const points = dedupe((segment.edge as { points?: PointLite[] }).points ?? []);
    if (points.length < 4 || segment.index >= points.length - 1) {
      return undefined;
    }
    const candidate = points.map((p) => ({ ...p }));
    if (segment.horizontal) {
      candidate[segment.index].y += shift;
      candidate[segment.index + 1].y += shift;
    } else if (segment.vertical) {
      candidate[segment.index].x += shift;
      candidate[segment.index + 1].x += shift;
    } else {
      return undefined;
    }
    return segmentsFor(segment.edge, candidate).length === candidate.length - 1
      ? candidate
      : undefined;
  };

  const shifts = [
    -TRACK_SHIFT,
    TRACK_SHIFT,
    -2 * TRACK_SHIFT,
    2 * TRACK_SHIFT,
    -3 * TRACK_SHIFT,
    3 * TRACK_SHIFT,
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const segments = allSegments();
    let fixed = false;

    for (let i = 0; i < segments.length && !fixed; i++) {
      for (let j = i + 1; j < segments.length && !fixed; j++) {
        const first = segments[i];
        const second = segments[j];
        if (first.edge === second.edge || sameAxisOverlap(first, second) < MIN_SHARED) {
          continue;
        }

        const candidates = [first, second].filter((segment) => segment.interior);
        for (const segment of candidates) {
          for (const shift of shifts) {
            const candidate = shiftedCandidate(segment, shift);
            if (!candidate || !candidateIsSafe(segment.edge, candidate)) {
              continue;
            }

            (segment.edge as { points: PointLite[] }).points = candidate;
            log.debug(
              SWIMLANE_DIR_LOG_PREFIX,
              `nudgeSharedInteriorSubpaths: ${segment.edgeId} seg ${segment.index}-${segment.index + 1} ${segment.horizontal ? 'y' : 'x'} shift ${shift.toFixed(2)}`
            );
            fixed = true;
            break;
          }
          if (fixed) {
            break;
          }
        }
      }
    }

    if (!fixed) {
      return;
    }
  }
}

function separateSharedRenderedTerminalLanes(edges: any[], nodeByIdMap: Map<string, any>): void {
  const EPS_LOCAL = 1e-3;
  const MIN_SHARED = 8;
  const TRACK_SHIFT = 7;

  interface PointLite {
    x: number;
    y: number;
  }

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  interface TerminalLane {
    edge: any;
    edgeId: string;
    nodeId: string;
    atStart: boolean;
    orientation: 'H' | 'V';
    coord: number;
    min: number;
    max: number;
    boundary: PointLite;
    railEnd: PointLite;
    rect: RectLite;
  }

  const rectOfNode = (node: any): RectLite | undefined => {
    const cx = (node as { x?: number }).x ?? 0;
    const cy = (node as { y?: number }).y ?? 0;
    const w = (node as { width?: number }).width ?? 0;
    const h = (node as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      return undefined;
    }
    return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
  };

  const dedupe = (points: PointLite[]): PointLite[] => {
    const result: PointLite[] = [];
    for (const point of points) {
      const last = result.length > 0 ? result[result.length - 1] : undefined;
      if (
        !last ||
        Math.abs(point.x - last.x) > EPS_LOCAL ||
        Math.abs(point.y - last.y) > EPS_LOCAL
      ) {
        result.push({ x: point.x, y: point.y });
      }
    }
    return result;
  };

  const rectIntersect = (node: any, point: PointLite): PointLite => {
    const x = (node as { x?: number }).x ?? 0;
    const y = (node as { y?: number }).y ?? 0;
    const dx = point.x - x;
    const dy = point.y - y;
    let w = ((node as { width?: number }).width ?? 0) / 2;
    let h = ((node as { height?: number }).height ?? 0) / 2;

    if (Math.abs(dy) * w > Math.abs(dx) * h) {
      if (dy < 0) {
        h = -h;
      }
      return { x: x + (dy === 0 ? 0 : (h * dx) / dy), y: y + h };
    }

    if (dx < 0) {
      w = -w;
    }
    return { x: x + w, y: y + (dx === 0 ? 0 : (w * dy) / dx) };
  };

  const terminalLaneFor = (edge: any, atStart: boolean): TerminalLane | undefined => {
    const points = dedupe((edge as { points?: PointLite[] }).points ?? []);
    if (points.length < 2) {
      return undefined;
    }

    const nodeId = atStart ? (edge as { start?: string }).start : (edge as { end?: string }).end;
    const node = nodeId ? nodeByIdMap.get(nodeId) : undefined;
    const rect = node ? rectOfNode(node) : undefined;
    if (!node || !nodeId || !rect) {
      return undefined;
    }

    const endpoint = atStart ? points[0] : points[points.length - 1];
    const adjacent = atStart ? points[1] : points[points.length - 2];
    const boundary = rectIntersect(node, endpoint);
    let railEnd = endpoint;
    if (
      Math.abs(adjacent.x - boundary.x) < EPS_LOCAL ||
      Math.abs(adjacent.y - boundary.y) < EPS_LOCAL
    ) {
      railEnd = adjacent;
    }

    if (Math.abs(boundary.x - railEnd.x) < EPS_LOCAL) {
      return {
        edge,
        edgeId: String((edge as { id?: string }).id ?? ''),
        nodeId,
        atStart,
        orientation: 'V',
        coord: boundary.x,
        min: Math.min(boundary.y, railEnd.y),
        max: Math.max(boundary.y, railEnd.y),
        boundary,
        railEnd,
        rect,
      };
    }
    if (Math.abs(boundary.y - railEnd.y) < EPS_LOCAL) {
      return {
        edge,
        edgeId: String((edge as { id?: string }).id ?? ''),
        nodeId,
        atStart,
        orientation: 'H',
        coord: boundary.y,
        min: Math.min(boundary.x, railEnd.x),
        max: Math.max(boundary.x, railEnd.x),
        boundary,
        railEnd,
        rect,
      };
    }
    return undefined;
  };

  const overlapLength = (a: TerminalLane, b: TerminalLane): number =>
    a.nodeId === b.nodeId && a.orientation === b.orientation && Math.abs(a.coord - b.coord) < 0.5
      ? Math.max(0, Math.min(a.max, b.max) - Math.max(a.min, b.min))
      : 0;

  const shiftedCandidate = (lane: TerminalLane, shift: number): PointLite[] | undefined => {
    const points = dedupe((lane.edge as { points?: PointLite[] }).points ?? []);
    if (points.length < 2) {
      return undefined;
    }

    const shiftedBoundary =
      lane.orientation === 'V'
        ? { x: lane.boundary.x + shift, y: lane.boundary.y }
        : { x: lane.boundary.x, y: lane.boundary.y + shift };
    const shiftedRailEnd =
      lane.orientation === 'V'
        ? { x: lane.railEnd.x + shift, y: lane.railEnd.y }
        : { x: lane.railEnd.x, y: lane.railEnd.y + shift };

    const boundaryStaysOnSameFace = (): boolean => {
      if (
        Math.abs(lane.boundary.y - lane.rect.top) < 1 ||
        Math.abs(lane.boundary.y - lane.rect.bottom) < 1
      ) {
        return (
          Math.abs(shiftedBoundary.y - lane.boundary.y) < EPS_LOCAL &&
          shiftedBoundary.x >= lane.rect.left + 1 &&
          shiftedBoundary.x <= lane.rect.right - 1
        );
      }

      if (
        Math.abs(lane.boundary.x - lane.rect.left) < 1 ||
        Math.abs(lane.boundary.x - lane.rect.right) < 1
      ) {
        return (
          Math.abs(shiftedBoundary.x - lane.boundary.x) < EPS_LOCAL &&
          shiftedBoundary.y >= lane.rect.top + 1 &&
          shiftedBoundary.y <= lane.rect.bottom - 1
        );
      }

      return false;
    };

    if (!boundaryStaysOnSameFace()) {
      return undefined;
    }

    if (lane.atStart) {
      const railEndIsAdjacent =
        points.length > 1 &&
        Math.abs(points[1].x - lane.railEnd.x) < EPS_LOCAL &&
        Math.abs(points[1].y - lane.railEnd.y) < EPS_LOCAL;
      const rest = points.slice(railEndIsAdjacent ? 2 : 1);
      const next = rest[0];
      if (
        next &&
        Math.abs(next.x - shiftedRailEnd.x) > EPS_LOCAL &&
        Math.abs(next.y - shiftedRailEnd.y) > EPS_LOCAL
      ) {
        return undefined;
      }
      return [shiftedBoundary, shiftedRailEnd, ...rest];
    }

    const railEndIsAdjacent =
      points.length > 1 &&
      Math.abs(points[points.length - 2].x - lane.railEnd.x) < EPS_LOCAL &&
      Math.abs(points[points.length - 2].y - lane.railEnd.y) < EPS_LOCAL;
    const before = points.slice(0, railEndIsAdjacent ? -2 : -1);
    const previous = before[before.length - 1];
    if (
      previous &&
      Math.abs(previous.x - shiftedRailEnd.x) > EPS_LOCAL &&
      Math.abs(previous.y - shiftedRailEnd.y) > EPS_LOCAL
    ) {
      return undefined;
    }
    return [...before, shiftedRailEnd, shiftedBoundary];
  };

  const shifts = [-TRACK_SHIFT, TRACK_SHIFT, -2 * TRACK_SHIFT, 2 * TRACK_SHIFT];

  for (let iteration = 0; iteration < 8; iteration++) {
    const lanes = edges
      .filter((edge) => !(edge as { isLayoutOnly?: boolean }).isLayoutOnly)
      .flatMap((edge) => [terminalLaneFor(edge, true), terminalLaneFor(edge, false)])
      .filter((lane): lane is TerminalLane => Boolean(lane));

    let fixed = false;
    for (let i = 0; i < lanes.length && !fixed; i++) {
      for (let j = i + 1; j < lanes.length && !fixed; j++) {
        const first = lanes[i];
        const second = lanes[j];
        if (first.edge === second.edge || overlapLength(first, second) < MIN_SHARED) {
          continue;
        }

        const candidates = [first, second].sort((a, b) => Number(!b.atStart) - Number(!a.atStart));
        for (const lane of candidates) {
          for (const shift of shifts) {
            const candidate = shiftedCandidate(lane, shift);
            if (!candidate) {
              continue;
            }
            const nextLane = terminalLaneFor({ ...lane.edge, points: candidate }, lane.atStart);
            if (
              !nextLane ||
              lanes.some(
                (other) => other.edge !== lane.edge && overlapLength(nextLane, other) >= MIN_SHARED
              )
            ) {
              continue;
            }

            (lane.edge as { points: PointLite[] }).points = candidate;
            fixed = true;
            break;
          }
          if (fixed) {
            break;
          }
        }
      }
    }

    if (!fixed) {
      return;
    }
  }
}

function collapseRedundantRectangularDoglegs(edges: any[], nodeByIdMap: Map<string, any>): void {
  const EPS_LOCAL = 1e-3;
  const MIN_SHARED = 8;
  const BUFFER = 2;
  const MAX_ITERATIONS = 8;

  interface PointLite {
    x: number;
    y: number;
  }

  interface RectLite {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }

  interface SegmentLite {
    edge: any;
    a: PointLite;
    b: PointLite;
    horizontal: boolean;
    vertical: boolean;
  }

  const realNodeRects: { id: string; rect: RectLite }[] = [];
  const labelRects: { id: string; rect: RectLite }[] = [];
  for (const n of nodeByIdMap.values()) {
    if ((n as { isGroup?: boolean }).isGroup) {
      continue;
    }
    const cx = (n as { x?: number }).x ?? 0;
    const cy = (n as { y?: number }).y ?? 0;
    const w = (n as { width?: number }).width ?? 0;
    const h = (n as { height?: number }).height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
    const id = String((n as { id?: string }).id ?? '');
    if ((n as { isEdgeLabel?: boolean }).isEdgeLabel) {
      labelRects.push({ id, rect });
    } else {
      realNodeRects.push({ id, rect });
    }
  }

  const dedupe = (points: PointLite[]): PointLite[] => {
    const result: PointLite[] = [];
    for (const point of points) {
      const last = result.length > 0 ? result[result.length - 1] : undefined;
      if (
        !last ||
        Math.abs(point.x - last.x) > EPS_LOCAL ||
        Math.abs(point.y - last.y) > EPS_LOCAL
      ) {
        result.push({ x: point.x, y: point.y });
      }
    }
    return result;
  };

  const isHorizontal = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.y - b.y) < EPS_LOCAL && Math.abs(a.x - b.x) > EPS_LOCAL;

  const isVertical = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.x - b.x) < EPS_LOCAL && Math.abs(a.y - b.y) > EPS_LOCAL;

  const overlapLength = (a1: number, a2: number, b1: number, b2: number): number =>
    Math.max(
      0,
      Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
    );

  const sameAxisOverlap = (a: SegmentLite, b: SegmentLite): number => {
    if (a.horizontal && b.horizontal && Math.abs(a.a.y - b.a.y) < 0.5) {
      return overlapLength(a.a.x, a.b.x, b.a.x, b.b.x);
    }
    if (a.vertical && b.vertical && Math.abs(a.a.x - b.a.x) < 0.5) {
      return overlapLength(a.a.y, a.b.y, b.a.y, b.b.y);
    }
    return 0;
  };

  const segmentHitsRect = (a: PointLite, b: PointLite, r: RectLite, buffer: number): boolean => {
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    const segMinY = Math.min(a.y, b.y);
    const segMaxY = Math.max(a.y, b.y);
    return (
      segMaxX > r.left - buffer &&
      segMinX < r.right + buffer &&
      segMaxY > r.top - buffer &&
      segMinY < r.bottom + buffer
    );
  };

  const segmentsCrossStrict = (
    a1: PointLite,
    a2: PointLite,
    b1: PointLite,
    b2: PointLite
  ): boolean => {
    const aHoriz = isHorizontal(a1, a2);
    const aVert = isVertical(a1, a2);
    const bHoriz = isHorizontal(b1, b2);
    const bVert = isVertical(b1, b2);
    if (!((aHoriz && bVert) || (aVert && bHoriz))) {
      return false;
    }
    const h = aHoriz ? { a: a1, b: a2 } : { a: b1, b: b2 };
    const v = aHoriz ? { a: b1, b: b2 } : { a: a1, b: a2 };
    const hY = h.a.y;
    const hXMin = Math.min(h.a.x, h.b.x);
    const hXMax = Math.max(h.a.x, h.b.x);
    const vX = v.a.x;
    const vYMin = Math.min(v.a.y, v.b.y);
    const vYMax = Math.max(v.a.y, v.b.y);
    return (
      vX > hXMin + EPS_LOCAL &&
      vX < hXMax - EPS_LOCAL &&
      hY > vYMin + EPS_LOCAL &&
      hY < vYMax - EPS_LOCAL
    );
  };

  const segmentsFor = (edge: any, points: PointLite[]): SegmentLite[] => {
    const result: SegmentLite[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const horizontal = isHorizontal(a, b);
      const vertical = isVertical(a, b);
      if (!horizontal && !vertical) {
        continue;
      }
      result.push({ edge, a, b, horizontal, vertical });
    }
    return result;
  };

  const candidateIsSafe = (edge: any, candidate: PointLite[]): boolean => {
    const sourceId = (edge as { start?: string }).start;
    const targetId = (edge as { end?: string }).end;
    const candidateSegments = segmentsFor(edge, candidate);
    if (candidateSegments.length !== candidate.length - 1) {
      return false;
    }

    for (const segment of candidateSegments) {
      for (const nodeRect of realNodeRects) {
        if (nodeRect.id === sourceId || nodeRect.id === targetId) {
          continue;
        }
        if (segmentHitsRect(segment.a, segment.b, nodeRect.rect, BUFFER)) {
          return false;
        }
      }
      for (const labelRect of labelRects) {
        if (segmentHitsRect(segment.a, segment.b, labelRect.rect, BUFFER)) {
          return false;
        }
      }
    }

    for (const other of edges) {
      if (other === edge || (other as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const otherPoints = (other as { points?: PointLite[] }).points;
      if (!otherPoints || otherPoints.length < 2) {
        continue;
      }
      for (const candidateSegment of candidateSegments) {
        for (const otherSegment of segmentsFor(other, dedupe(otherPoints))) {
          if (sameAxisOverlap(candidateSegment, otherSegment) >= MIN_SHARED) {
            return false;
          }
          if (
            segmentsCrossStrict(
              candidateSegment.a,
              candidateSegment.b,
              otherSegment.a,
              otherSegment.b
            )
          ) {
            return false;
          }
        }
      }
    }

    return true;
  };

  const withoutDogleg = (points: PointLite[], i: number): PointLite[] | undefined => {
    if (i + 4 >= points.length) {
      return undefined;
    }
    const p0 = points[i];
    const p1 = points[i + 1];
    const p2 = points[i + 2];
    const p3 = points[i + 3];
    const p4 = points[i + 4];

    const terminalVerticalDogleg =
      isHorizontal(p0, p1) &&
      isVertical(p1, p2) &&
      isHorizontal(p2, p3) &&
      isVertical(p3, p4) &&
      Math.abs(p0.x - p3.x) < EPS_LOCAL &&
      Math.abs(p0.x - p4.x) < EPS_LOCAL &&
      Math.abs(p1.x - p2.x) < EPS_LOCAL &&
      (p1.x - p0.x) * (p3.x - p2.x) < 0;

    const terminalHorizontalDogleg =
      isVertical(p0, p1) &&
      isHorizontal(p1, p2) &&
      isVertical(p2, p3) &&
      isHorizontal(p3, p4) &&
      Math.abs(p0.y - p3.y) < EPS_LOCAL &&
      Math.abs(p0.y - p4.y) < EPS_LOCAL &&
      Math.abs(p1.y - p2.y) < EPS_LOCAL &&
      (p1.y - p0.y) * (p3.y - p2.y) < 0;

    if (terminalVerticalDogleg || terminalHorizontalDogleg) {
      return dedupe([...points.slice(0, i + 1), p4, ...points.slice(i + 5)]);
    }

    if (i + 5 >= points.length) {
      return undefined;
    }
    const p5 = points[i + 5];

    const verticalDogleg =
      isVertical(p0, p1) &&
      isHorizontal(p1, p2) &&
      isVertical(p2, p3) &&
      isHorizontal(p3, p4) &&
      isVertical(p4, p5) &&
      Math.abs(p0.x - p4.x) < EPS_LOCAL &&
      Math.abs(p0.x - p5.x) < EPS_LOCAL &&
      Math.abs(p2.x - p3.x) < EPS_LOCAL &&
      (p2.x - p1.x) * (p4.x - p3.x) < 0;

    const horizontalDogleg =
      isHorizontal(p0, p1) &&
      isVertical(p1, p2) &&
      isHorizontal(p2, p3) &&
      isVertical(p3, p4) &&
      isHorizontal(p4, p5) &&
      Math.abs(p0.y - p4.y) < EPS_LOCAL &&
      Math.abs(p0.y - p5.y) < EPS_LOCAL &&
      Math.abs(p2.y - p3.y) < EPS_LOCAL &&
      (p2.y - p1.y) * (p4.y - p3.y) < 0;

    if (!verticalDogleg && !horizontalDogleg) {
      return undefined;
    }

    return dedupe([...points.slice(0, i + 1), p5, ...points.slice(i + 6)]);
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let fixed = false;
    for (const edge of edges) {
      if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const points = dedupe((edge as { points?: PointLite[] }).points ?? []);
      for (let i = 0; i <= points.length - 5; i++) {
        const candidate = withoutDogleg(points, i);
        if (!candidate || !candidateIsSafe(edge, candidate)) {
          continue;
        }
        (edge as { points: PointLite[] }).points = candidate;
        fixed = true;
        break;
      }
      if (fixed) {
        break;
      }
    }
    if (!fixed) {
      return;
    }
  }
}
