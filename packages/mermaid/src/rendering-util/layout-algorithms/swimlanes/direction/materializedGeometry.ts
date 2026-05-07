// cspell:ignore Wybrow

export function separateSharedRenderedTerminalLanes(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
  const EPS_LOCAL = 1e-3;
  const MIN_SHARED = 8;
  const MIN_FACE_CLEARANCE = 16;
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

  const projectedOverlapLength = (a: TerminalLane, b: TerminalLane): number =>
    Math.max(0, Math.min(a.max, b.max) - Math.max(a.min, b.min));

  const sameTerminalFace = (a: TerminalLane, b: TerminalLane): boolean => {
    if (a.nodeId !== b.nodeId || a.orientation !== b.orientation) {
      return false;
    }

    if (a.orientation === 'H') {
      const aOnHorizontalFace =
        Math.abs(a.boundary.x - a.rect.left) < 1 || Math.abs(a.boundary.x - a.rect.right) < 1;
      return aOnHorizontalFace && Math.abs(a.boundary.x - b.boundary.x) < 1;
    }

    const aOnVerticalFace =
      Math.abs(a.boundary.y - a.rect.top) < 1 || Math.abs(a.boundary.y - a.rect.bottom) < 1;
    return aOnVerticalFace && Math.abs(a.boundary.y - b.boundary.y) < 1;
  };

  const exactTerminalLaneConflict = (a: TerminalLane, b: TerminalLane): boolean => {
    if (a.nodeId !== b.nodeId || a.orientation !== b.orientation) {
      return false;
    }

    const shared = projectedOverlapLength(a, b);
    return shared >= MIN_SHARED && Math.abs(a.coord - b.coord) < 0.5;
  };

  const nearTerminalLaneConflict = (a: TerminalLane, b: TerminalLane): boolean => {
    if (
      a.nodeId !== b.nodeId ||
      a.orientation !== b.orientation ||
      a.orientation !== 'H' ||
      a.atStart === b.atStart
    ) {
      return false;
    }

    const shared = projectedOverlapLength(a, b);
    if (shared < MIN_SHARED) {
      return false;
    }
    const faceSpan =
      a.orientation === 'H' ? a.rect.bottom - a.rect.top : a.rect.right - a.rect.left;
    if (shared < faceSpan || shared > 2 * faceSpan) {
      return false;
    }

    // Wybrow-style nudging keeps connector topology fixed while preserving
    // ordering constraints; rendered terminal tracks on the same object face
    // need the same treatment before endpoint duplication pins them in place.
    return sameTerminalFace(a, b) && Math.abs(a.coord - b.coord) < MIN_FACE_CLEARANCE;
  };

  const terminalLaneConflict = (a: TerminalLane, b: TerminalLane): boolean =>
    exactTerminalLaneConflict(a, b) || nearTerminalLaneConflict(a, b);

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

  const shifts = [
    -TRACK_SHIFT,
    TRACK_SHIFT,
    -2 * TRACK_SHIFT,
    2 * TRACK_SHIFT,
    -3 * TRACK_SHIFT,
    3 * TRACK_SHIFT,
  ];

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
        if (first.edge === second.edge || !terminalLaneConflict(first, second)) {
          continue;
        }

        const fixingNearConflict = !exactTerminalLaneConflict(first, second);
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
                (other) =>
                  other.edge !== lane.edge &&
                  (exactTerminalLaneConflict(nextLane, other) ||
                    (fixingNearConflict && nearTerminalLaneConflict(nextLane, other)))
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

export function resolveRenderedOrthogonalCrossings(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
  const EPS_LOCAL = 1e-3;
  const ANCHOR = 20;
  const MIN_SHARED = 8;
  const MAX_ITERATIONS = 4;

  type Side = 'top' | 'bottom' | 'left' | 'right';

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

  interface NodeInfo {
    id: string;
    cx: number;
    cy: number;
    rect: RectLite;
  }

  interface SegmentLite {
    a: PointLite;
    b: PointLite;
    horizontal: boolean;
    vertical: boolean;
  }

  const realNodes: NodeInfo[] = [];
  for (const node of nodeByIdMap.values()) {
    if (
      (node as { isGroup?: boolean }).isGroup ||
      (node as { isEdgeLabel?: boolean }).isEdgeLabel
    ) {
      continue;
    }
    const cx = (node as { x?: number }).x ?? 0;
    const cy = (node as { y?: number }).y ?? 0;
    const width = (node as { width?: number }).width ?? 0;
    const height = (node as { height?: number }).height ?? 0;
    if (width <= 0 || height <= 0) {
      continue;
    }
    realNodes.push({
      id: String((node as { id?: string }).id ?? ''),
      cx,
      cy,
      rect: {
        left: cx - width / 2,
        right: cx + width / 2,
        top: cy - height / 2,
        bottom: cy + height / 2,
      },
    });
  }

  if (realNodes.length === 0) {
    return;
  }

  const nodeInfoById = new Map(realNodes.map((node) => [node.id, node]));
  const sides: Side[] = ['top', 'bottom', 'left', 'right'];
  const outsideTracks = {
    top: Math.min(...realNodes.map((node) => node.rect.top)) - ANCHOR,
    bottom: Math.max(...realNodes.map((node) => node.rect.bottom)) + ANCHOR,
    left: Math.min(...realNodes.map((node) => node.rect.left)) - ANCHOR,
    right: Math.max(...realNodes.map((node) => node.rect.right)) + ANCHOR,
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

  const isHorizontal = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.y - b.y) < EPS_LOCAL && Math.abs(a.x - b.x) > EPS_LOCAL;

  const isVertical = (a: PointLite, b: PointLite): boolean =>
    Math.abs(a.x - b.x) < EPS_LOCAL && Math.abs(a.y - b.y) > EPS_LOCAL;

  const segmentsFor = (points: PointLite[]): SegmentLite[] => {
    const result: SegmentLite[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const horizontal = isHorizontal(a, b);
      const vertical = isVertical(a, b);
      if (horizontal || vertical) {
        result.push({ a, b, horizontal, vertical });
      }
    }
    return result;
  };

  const segmentsCrossStrict = (a: SegmentLite, b: SegmentLite): boolean => {
    if (!((a.horizontal && b.vertical) || (a.vertical && b.horizontal))) {
      return false;
    }
    const h = a.horizontal ? a : b;
    const v = a.vertical ? a : b;
    const hY = h.a.y;
    const hMin = Math.min(h.a.x, h.b.x);
    const hMax = Math.max(h.a.x, h.b.x);
    const vX = v.a.x;
    const vMin = Math.min(v.a.y, v.b.y);
    const vMax = Math.max(v.a.y, v.b.y);
    return (
      vX > hMin + EPS_LOCAL &&
      vX < hMax - EPS_LOCAL &&
      hY > vMin + EPS_LOCAL &&
      hY < vMax - EPS_LOCAL
    );
  };

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

  const visibleEdges = (): any[] =>
    edges.filter((edge) => !(edge as { isLayoutOnly?: boolean }).isLayoutOnly);

  const pointsFor = (edge: any, replacementEdge?: any, replacement?: PointLite[]): PointLite[] =>
    dedupe(
      edge === replacementEdge
        ? (replacement ?? [])
        : ((edge as { points?: PointLite[] }).points ?? [])
    );

  const crossingCount = (replacementEdge?: any, replacement?: PointLite[]): number => {
    const candidates = visibleEdges();
    let count = 0;
    for (let i = 0; i < candidates.length; i++) {
      const first = candidates[i];
      const firstSegments = segmentsFor(pointsFor(first, replacementEdge, replacement));
      for (let j = i + 1; j < candidates.length; j++) {
        const second = candidates[j];
        const secondSegments = segmentsFor(pointsFor(second, replacementEdge, replacement));
        for (const firstSegment of firstSegments) {
          for (const secondSegment of secondSegments) {
            if (segmentsCrossStrict(firstSegment, secondSegment)) {
              count++;
            }
          }
        }
      }
    }
    return count;
  };

  const pathHasSegmentConflict = (edge: any, path: PointLite[]): boolean => {
    const pathSegments = segmentsFor(path);
    for (const other of visibleEdges()) {
      if (other === edge) {
        continue;
      }
      for (const candidateSegment of pathSegments) {
        for (const otherSegment of segmentsFor(pointsFor(other))) {
          if (sameAxisOverlap(candidateSegment, otherSegment) >= MIN_SHARED) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const segmentHitsRectInterior = (segment: SegmentLite, rect: RectLite): boolean => {
    const minX = Math.min(segment.a.x, segment.b.x);
    const maxX = Math.max(segment.a.x, segment.b.x);
    const minY = Math.min(segment.a.y, segment.b.y);
    const maxY = Math.max(segment.a.y, segment.b.y);
    return (
      maxX > rect.left + 1 && minX < rect.right - 1 && maxY > rect.top + 1 && minY < rect.bottom - 1
    );
  };

  const pathHitsNode = (edge: any, path: PointLite[]): boolean => {
    for (const segment of segmentsFor(path)) {
      for (const node of realNodes) {
        if (segmentHitsRectInterior(segment, node.rect)) {
          return true;
        }
      }
    }
    return false;
  };

  const countBends = (path: PointLite[]): number => {
    const segments = segmentsFor(path);
    let bends = 0;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i - 1].horizontal !== segments[i].horizontal) {
        bends++;
      }
    }
    return bends;
  };

  const portForSide = (node: NodeInfo, side: Side): PointLite => {
    switch (side) {
      case 'top':
        return { x: node.cx, y: node.rect.top };
      case 'bottom':
        return { x: node.cx, y: node.rect.bottom };
      case 'left':
        return { x: node.rect.left, y: node.cy };
      case 'right':
        return { x: node.rect.right, y: node.cy };
    }
  };

  const buildCandidatesForSides = (
    src: PointLite,
    srcSide: Side,
    dst: PointLite,
    dstSide: Side
  ): PointLite[][] => {
    const candidates: PointLite[][] = [];
    const srcH = srcSide === 'left' || srcSide === 'right';
    const dstH = dstSide === 'left' || dstSide === 'right';

    if (srcH && dstH) {
      const opposingDir =
        (srcSide === 'right' && dstSide === 'left' && src.x < dst.x) ||
        (srcSide === 'left' && dstSide === 'right' && src.x > dst.x);
      if (opposingDir) {
        candidates.push(
          Math.abs(src.y - dst.y) < EPS_LOCAL
            ? [src, dst]
            : [src, { x: (src.x + dst.x) / 2, y: src.y }, { x: (src.x + dst.x) / 2, y: dst.y }, dst]
        );
      }
      if (srcSide === dstSide) {
        const localX =
          srcSide === 'left' ? Math.min(src.x, dst.x) - ANCHOR : Math.max(src.x, dst.x) + ANCHOR;
        const globalX = srcSide === 'left' ? outsideTracks.left : outsideTracks.right;
        candidates.push([src, { x: localX, y: src.y }, { x: localX, y: dst.y }, dst]);
        candidates.push([src, { x: globalX, y: src.y }, { x: globalX, y: dst.y }, dst]);
      }
    } else if (!srcH && !dstH) {
      if (srcSide === dstSide) {
        const localY =
          srcSide === 'top' ? Math.min(src.y, dst.y) - ANCHOR : Math.max(src.y, dst.y) + ANCHOR;
        const globalY = srcSide === 'top' ? outsideTracks.top : outsideTracks.bottom;
        candidates.push([src, { x: src.x, y: localY }, { x: dst.x, y: localY }, dst]);
        candidates.push([src, { x: src.x, y: globalY }, { x: dst.x, y: globalY }, dst]);
      }
      const sameDir =
        (srcSide === 'bottom' && dstSide === 'top' && src.y < dst.y) ||
        (srcSide === 'top' && dstSide === 'bottom' && src.y > dst.y);
      if (sameDir) {
        candidates.push(
          Math.abs(src.x - dst.x) < EPS_LOCAL
            ? [src, dst]
            : [src, { x: src.x, y: (src.y + dst.y) / 2 }, { x: dst.x, y: (src.y + dst.y) / 2 }, dst]
        );
      }
    } else if (srcH && !dstH) {
      const sameDirSrc =
        (srcSide === 'right' && dst.x > src.x) || (srcSide === 'left' && dst.x < src.x);
      const sameDirDst =
        (dstSide === 'top' && src.y < dst.y) || (dstSide === 'bottom' && src.y > dst.y);
      if (sameDirSrc && sameDirDst) {
        candidates.push([src, { x: dst.x, y: src.y }, dst]);
      }
    } else {
      const sameDirSrc =
        (srcSide === 'bottom' && dst.y > src.y) || (srcSide === 'top' && dst.y < src.y);
      const sameDirDst =
        (dstSide === 'left' && src.x < dst.x) || (dstSide === 'right' && src.x > dst.x);
      if (sameDirSrc && sameDirDst) {
        candidates.push([src, { x: src.x, y: dst.y }, dst]);
      }
    }

    const seen = new Set<string>();
    return candidates
      .map((candidate) => dedupe(candidate))
      .filter((candidate) => {
        const key = candidate
          .map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`)
          .join('|');
        if (seen.has(key) || candidate.length < 2) {
          return false;
        }
        seen.add(key);
        return true;
      });
  };

  const candidatePathsFor = (edge: any): PointLite[][] => {
    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const srcNode = srcId ? nodeInfoById.get(srcId) : undefined;
    const dstNode = dstId ? nodeInfoById.get(dstId) : undefined;
    if (!srcNode || !dstNode) {
      return [];
    }

    const candidates: PointLite[][] = [];
    for (const srcSide of sides) {
      const srcPort = portForSide(srcNode, srcSide);
      for (const dstSide of sides) {
        candidates.push(
          ...buildCandidatesForSides(srcPort, srcSide, portForSide(dstNode, dstSide), dstSide)
        );
      }
    }
    return candidates;
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const currentCrossings = crossingCount();
    if (currentCrossings === 0) {
      return;
    }

    let bestEdge: { points?: PointLite[] } | undefined;
    let bestPath: PointLite[] | undefined;
    let bestCrossings = currentCrossings;
    let bestBends = Number.POSITIVE_INFINITY;

    for (const edge of visibleEdges()) {
      for (const candidate of candidatePathsFor(edge)) {
        if (pathHitsNode(edge, candidate) || pathHasSegmentConflict(edge, candidate)) {
          continue;
        }
        const candidateCrossings = crossingCount(edge, candidate);
        const candidateBends = countBends(candidate);
        if (
          candidateCrossings > bestCrossings ||
          (candidateCrossings === bestCrossings && candidateBends >= bestBends)
        ) {
          continue;
        }
        bestEdge = edge;
        bestPath = candidate;
        bestCrossings = candidateCrossings;
        bestBends = candidateBends;
      }
    }

    if (!bestEdge || !bestPath) {
      return;
    }

    bestEdge.points = bestPath;
  }
}
