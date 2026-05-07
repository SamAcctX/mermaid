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
  resolveRenderedOrthogonalCrossings,
  separateSharedRenderedTerminalLanes,
} from './direction/materializedGeometry.js';
import { simplifyDetouredEdges } from './direction/detourSimplification.js';
import { anchorLabelsToPolyline } from './direction/labelAnchoring.js';
import { resolveEdgeNodeIntersections } from './direction/nodeIntersections.js';
import { preventSiblingLShapeCrossings } from './direction/siblingAntiCrossing.js';
import { straightenCollinearSiblingDetours } from './direction/siblingSharedFaceRouting.js';
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
  straightenCollinearSiblingDetours(edges as any[], nodes);

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
  // straightenCollinearSiblingDetours (2-point straight), and 5+ point
  // detours are owned by simplifyDetouredEdges.
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
  preventSiblingLShapeCrossings(edges as any[]);

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

  // Wybrow-style crossing cleanup for the materialized render geometry. This
  // pass only activates when strict H/V crossings remain after the lower-level
  // nudging passes. It tries bounded port-pair and outer-channel candidates,
  // preserving obstacle clearance and accepting only candidates that reduce the
  // rendered crossing count.
  resolveRenderedOrthogonalCrossings(edges, nodeByIdMap);

  anchorLabelsToPolyline(edges, nodeByIdMap);

  resolveRenderedOrthogonalCrossings(edges, nodeByIdMap);

  prepareEdgeEndpointsForRenderer(edges, nodeByIdMap);

  log.debug(SWIMLANE_DIR_LOG_PREFIX, 'Applied LR direction transform to swimlanes', {
    contentNodeCount: contentNodes.length,
  });
}
