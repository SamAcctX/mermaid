// cspell:ignore Wybrow Hegemann Gladisch reanchor
import type { Edge, Node } from '../../../types.js';
import {
  collectNodeRectEntries,
  dedupeConsecutivePoints,
  orthogonalSegmentsStrictlyCross as segmentsCross,
  sameX,
  sameY,
  segmentBoundsOverlapRect,
} from './geometry.js';
import type { Point, RectBounds } from './geometry.js';

const MIN_CLEARANCE = 20; // Gladisch δ — safety gap
const EPS = 1e-3;
const BUFFER = 2;

type PointLite = Point;
type RectLite = RectBounds;

function shiftedSegmentsHitRect(
  before: PointLite,
  newA: PointLite,
  newB: PointLite,
  after: PointLite,
  r: RectLite
): boolean {
  return (
    segmentBoundsOverlapRect(newA, newB, r, BUFFER) ||
    segmentBoundsOverlapRect(before, newA, r, BUFFER) ||
    segmentBoundsOverlapRect(newB, after, r, BUFFER)
  );
}

function segmentKey(p: PointLite, q: PointLite): string {
  return `${p.x.toFixed(3)},${p.y.toFixed(3)}|${q.x.toFixed(3)},${q.y.toFixed(3)}`;
}

function pointOnSegment(x: number, y: number, p: PointLite, q: PointLite): boolean {
  if (sameY(p, q) && Math.abs(y - p.y) < EPS) {
    const xMin = Math.min(p.x, q.x);
    const xMax = Math.max(p.x, q.x);
    return x >= xMin - EPS && x <= xMax + EPS;
  }
  if (sameX(p, q) && Math.abs(x - p.x) < EPS) {
    const yMin = Math.min(p.y, q.y);
    const yMax = Math.max(p.y, q.y);
    return y >= yMin - EPS && y <= yMax + EPS;
  }
  return false;
}

function pointOnPolyline(points: PointLite[], x: number, y: number): boolean {
  for (let k = 0; k < points.length - 1; k++) {
    if (pointOnSegment(x, y, points[k], points[k + 1])) {
      return true;
    }
  }
  return false;
}

function longestLabelAnchor(
  points: PointLite[],
  labelWidth: number,
  labelHeight: number
): PointLite | undefined {
  let best: PointLite | undefined;
  let bestLen = -1;
  for (let k = 0; k < points.length - 1; k++) {
    const p = points[k];
    const q = points[k + 1];
    const segLen = Math.hypot(q.x - p.x, q.y - p.y);
    const fits =
      (sameY(p, q) && segLen >= labelWidth + 2) || (sameX(p, q) && segLen >= labelHeight + 2);
    if (fits && segLen > bestLen) {
      bestLen = segLen;
      best = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }
  }
  return best;
}

function reanchorLabelIfNeeded(
  edge: Edge,
  points: PointLite[],
  nodeByIdMap: Map<string, Node>
): void {
  const labelId = edge.labelNodeId;
  if (!labelId) {
    return;
  }
  const labelNode = nodeByIdMap.get(labelId);
  if (!labelNode) {
    return;
  }
  const lw = labelNode.width ?? 0;
  const lh = labelNode.height ?? 0;
  const lx = labelNode.x ?? 0;
  const ly = labelNode.y ?? 0;
  if (lw <= 0 || lh <= 0 || pointOnPolyline(points, lx, ly)) {
    return;
  }
  const anchor = longestLabelAnchor(points, lw, lh);
  if (anchor) {
    labelNode.x = anchor.x;
    labelNode.y = anchor.y;
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
export function nudgeInteriorVerticalsFromObstacles(
  edges: Edge[],
  nodeByIdMap: Map<string, Node>
): void {
  const { realNodeRects, labelNodeRects } = collectNodeRectEntries(nodeByIdMap.values());
  const labelRects = labelNodeRects.map(({ rect }) => rect);

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const rawPts = edge.points;
    if (!rawPts || rawPts.length < 4) {
      continue;
    }

    // Dedupe consecutive equal points so interior indices are accurate.
    const pts = dedupeConsecutivePoints(rawPts);
    if (pts.length < 4) {
      continue;
    }

    const srcId = edge.start;
    const dstId = edge.end;

    let changed = false;
    let working = [...pts];
    // Iterate interior vertical segments (indices 1 .. len-3).
    for (let i = 1; i <= working.length - 3; i++) {
      const a = working[i];
      const b = working[i + 1];
      const isVertical = sameX(a, b) && Math.abs(a.y - b.y) > EPS;
      if (!isVertical) {
        continue;
      }
      const before = working[i - 1];
      const after = working[i + 2];
      const beforeHoriz = sameY(before, a) && Math.abs(before.x - a.x) > EPS;
      const afterHoriz = sameY(after, b) && Math.abs(after.x - b.x) > EPS;
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
        if (r.bottom <= segYmin + EPS || r.top >= segYmax - EPS) {
          continue;
        }
        if (r.right < segX - EPS) {
          if (r.right > alleyLeft) {
            alleyLeft = r.right;
          }
        } else if (r.left > segX + EPS) {
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
      if (Math.abs(targetX - segX) < EPS) {
        continue;
      }

      const newA = { x: targetX, y: a.y };
      const newB = { x: targetX, y: b.y };

      // Gate (c): real-node rect collision for all three affected segments.
      let blocked = false;
      for (const rn of realNodeRects) {
        if (rn.id === srcId || rn.id === dstId) {
          continue;
        }
        if (shiftedSegmentsHitRect(before, newA, newB, after, rn.rect)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }

      // Gate (d): other-edge crossings. Skip own segments.
      const selfSegments = new Set<string>();
      for (let k = 0; k < working.length - 1; k++) {
        selfSegments.add(segmentKey(working[k], working[k + 1]));
        selfSegments.add(segmentKey(working[k + 1], working[k]));
      }
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if (other.isLayoutOnly) {
          continue;
        }
        const oPts = other.points;
        if (!oPts || oPts.length < 2) {
          continue;
        }
        for (let j = 0; j < oPts.length - 1; j++) {
          const p1 = oPts[j];
          const p2 = oPts[j + 1];
          if (selfSegments.has(segmentKey(p1, p2))) {
            continue;
          }
          if (
            segmentsCross(newA, newB, p1, p2) ||
            segmentsCross(before, newA, p1, p2) ||
            segmentsCross(newB, after, p1, p2)
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
      for (const r of labelRects) {
        if (shiftedSegmentsHitRect(before, newA, newB, after, r)) {
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
    }

    if (changed) {
      // Re-anchor the edge label if it now sits off the shifted polyline.
      // The shift may have moved a vertical segment out from under a label
      // that was previously centered on it; validateLayout enforces that
      // the polyline passes through the label node. Only re-anchor if
      // necessary (idempotent otherwise).
      edge.points = working;
      reanchorLabelIfNeeded(edge, working, nodeByIdMap);
    }
  }
}
