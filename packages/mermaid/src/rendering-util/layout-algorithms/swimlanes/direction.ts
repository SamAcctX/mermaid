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
