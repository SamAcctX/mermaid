// cspell:ignore Hegemann Wolff raykov
import type { Edge, Node } from '../../../types.js';
import {
  classifyThreeSegmentRoute,
  collectNodeRectEntries,
  rectFromCenterSize,
  segmentBoundsOverlapRect,
} from './geometry.js';
import type { Point } from './geometry.js';

const EPS = 1e-3;
const JOG_MAX = 20; // matches raykov MAX_PORT_SPACING
const NODE_BUFFER = 3;
const LABEL_BUFFER = 3;
const EDGE_BUFFER = 2;

type PointLite = Point;

interface SegLite {
  edgeId: string;
  a: PointLite;
  b: PointLite;
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
export function straightenStalePortOffsets(edges: Edge[], nodeByIdMap: Map<string, Node>): void {
  const { realNodeRects, labelNodeRects: labelRects } = collectNodeRectEntries(
    nodeByIdMap.values()
  );

  // Collect all edge segments for edge-on-edge overlap checking.
  const allSegments: SegLite[] = [];
  for (const other of edges) {
    if (other.isLayoutOnly) {
      continue;
    }
    const opts = other.points;
    if (!opts || opts.length < 2) {
      continue;
    }
    for (let i = 0; i < opts.length - 1; i++) {
      allSegments.push({ edgeId: other.id, a: opts[i], b: opts[i + 1] });
    }
  }

  // Collinear-incident-at-shared-node lookup for neighbor alignment.
  // Given a node and an axis ('y' for horizontal neighbors, 'x' for vertical),
  // return the coordinate of a collinear incident edge if one exists.
  const findCollinearNeighborCoord = (
    nodeId: string,
    excludeEdgeId: string,
    axis: 'y' | 'x'
  ): number | undefined => {
    for (const other of edges) {
      if (other.isLayoutOnly) {
        continue;
      }
      if (other.id === excludeEdgeId) {
        continue;
      }
      const opts = other.points;
      if (!opts || opts.length < 2) {
        continue;
      }
      const oStart = other.start;
      const oEnd = other.end;
      // Use the segment incident to the shared node.
      let incidentSeg: { a: PointLite; b: PointLite } | undefined;
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
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const route = classifyThreeSegmentRoute(pts, EPS);
    if (!route) {
      continue;
    }
    const { p0, p1, p2, p3 } = route;
    const startId = edge.start;
    const endId = edge.end;
    const edgeId = edge.id;
    if (!startId || !endId) {
      continue;
    }
    const startNode = nodeByIdMap.get(startId);
    const endNode = nodeByIdMap.get(endId);
    if (!startNode || !endNode) {
      continue;
    }
    const startRect = rectFromCenterSize(
      startNode.x ?? 0,
      startNode.y ?? 0,
      startNode.width ?? 0,
      startNode.height ?? 0
    );
    const endRect = rectFromCenterSize(
      endNode.x ?? 0,
      endNode.y ?? 0,
      endNode.width ?? 0,
      endNode.height ?? 0
    );

    // Identify the pattern: H-V-H or V-H-V with a short middle segment.
    const isHVH = route.kind === 'HVH';
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
      if (segmentBoundsOverlapRect(newStart, newEnd, rect, NODE_BUFFER)) {
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
      if (segmentBoundsOverlapRect(newStart, newEnd, rect, LABEL_BUFFER)) {
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
    edge.points = [newStart, newEnd];
  }
}
