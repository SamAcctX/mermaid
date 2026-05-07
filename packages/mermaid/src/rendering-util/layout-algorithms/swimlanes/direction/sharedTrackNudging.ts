import { log } from '../../../../logger.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';

export function nudgeSharedInteriorSubpaths(edges: any[], nodeByIdMap: Map<string, any>): void {
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
      const ownLabelId = (edge as { labelNodeId?: string }).labelNodeId;
      for (const labelRect of labelRects) {
        if (ownLabelId && labelRect.id === ownLabelId) {
          continue;
        }
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
