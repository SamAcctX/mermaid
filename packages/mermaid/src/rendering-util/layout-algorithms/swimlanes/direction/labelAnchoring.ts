// cspell:ignore Helmers Wybrow
import { log } from '../../../../logger.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';
const EPS = 1e-3;

export function anchorLabelsToPolyline(edges: any[], nodeByIdMap: Map<string, any>): void {
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

  const placedLabelRects: { labelId: string; rect: RectLite }[] = [];

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
          if (
            placedLabelRects.some(
              (placed) => placed.labelId !== labelId && rectsOverlap(rect, placed.rect)
            )
          ) {
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
        if (
          laneId &&
          !placedLabelRects.some(
            (placed) => placed.labelId !== labelId && rectsOverlap(rect, placed.rect)
          )
        ) {
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
      const chosenRect = {
        left: chosen.anchor.midX - lw / 2,
        right: chosen.anchor.midX + lw / 2,
        top: chosen.anchor.midY - lh / 2,
        bottom: chosen.anchor.midY + lh / 2,
      };
      const priorIdx = placedLabelRects.findIndex((placed) => placed.labelId === labelId);
      if (priorIdx >= 0) {
        placedLabelRects[priorIdx] = { labelId, rect: chosenRect };
      } else {
        placedLabelRects.push({ labelId, rect: chosenRect });
      }
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
