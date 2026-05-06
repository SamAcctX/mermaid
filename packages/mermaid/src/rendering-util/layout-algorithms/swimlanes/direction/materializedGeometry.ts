// cspell:ignore Wybrow

export function separateSharedRenderedTerminalLanes(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
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

export function collapseRedundantRectangularDoglegs(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
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
