// cspell:ignore Wybrow

import {
  collectNodeRectEntries,
  countOrthogonalBends,
  dedupeConsecutivePoints,
  isHorizontalSegment,
  isVerticalSegment,
  samePoint,
  sameX,
  sameY,
  buildOrthogonalPortPath,
  buildSameSideTrackPath,
  orthogonalSegmentsForPoints,
  orthogonalSegmentsStrictlyCross,
  portForRectSide,
  rectOfNodeBounds,
  sameAxisSegmentOverlapLength,
  segmentHitsAnyRect,
  simplifyPolyline,
} from './geometry.js';
import type { OrthogonalSegment, Point, RectBounds, RectSide } from './geometry.js';

const EPS_LOCAL = 1e-3;
const MIN_SHARED = 8;

type PointLite = Point;
type RectLite = RectBounds;

type SegmentLite = OrthogonalSegment;

const segmentsFor = orthogonalSegmentsForPoints;

const orthogonallyAligned = (a: PointLite, b: PointLite): boolean =>
  sameX(a, b, EPS_LOCAL) || sameY(a, b, EPS_LOCAL);

export function separateSharedRenderedTerminalLanes(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
  const MIN_FACE_CLEARANCE = 16;
  const TRACK_SHIFT = 7;

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
    const points = dedupeConsecutivePoints((edge as { points?: PointLite[] }).points ?? []);
    if (points.length < 2) {
      return undefined;
    }

    const nodeId = atStart ? (edge as { start?: string }).start : (edge as { end?: string }).end;
    const node = nodeId ? nodeByIdMap.get(nodeId) : undefined;
    const rect = node ? rectOfNodeBounds(node) : undefined;
    if (!node || !nodeId || !rect) {
      return undefined;
    }

    const endpoint = atStart ? points[0] : points[points.length - 1];
    const adjacent = atStart ? points[1] : points[points.length - 2];
    const boundary = rectIntersect(node, endpoint);
    let railEnd = endpoint;
    if (orthogonallyAligned(adjacent, boundary)) {
      railEnd = adjacent;
    }

    if (sameX(boundary, railEnd, EPS_LOCAL)) {
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
    if (sameY(boundary, railEnd, EPS_LOCAL)) {
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
      return aOnHorizontalFace && sameX(a.boundary, b.boundary, 1);
    }

    const aOnVerticalFace =
      Math.abs(a.boundary.y - a.rect.top) < 1 || Math.abs(a.boundary.y - a.rect.bottom) < 1;
    return aOnVerticalFace && sameY(a.boundary, b.boundary, 1);
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
    const faceSpan = a.rect.bottom - a.rect.top;
    if (shared < faceSpan || shared > 2 * faceSpan) {
      return false;
    }

    // Wybrow-style nudging keeps connector topology fixed while preserving
    // ordering constraints; rendered terminal tracks on the same object face
    // need the same treatment before endpoint duplication pins them in place.
    return sameTerminalFace(a, b) && Math.abs(a.coord - b.coord) < MIN_FACE_CLEARANCE;
  };

  const shiftedCandidate = (lane: TerminalLane, shift: number): PointLite[] | undefined => {
    const points = dedupeConsecutivePoints((lane.edge as { points?: PointLite[] }).points ?? []);
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
          sameY(shiftedBoundary, lane.boundary, EPS_LOCAL) &&
          shiftedBoundary.x >= lane.rect.left + 1 &&
          shiftedBoundary.x <= lane.rect.right - 1
        );
      }

      if (
        Math.abs(lane.boundary.x - lane.rect.left) < 1 ||
        Math.abs(lane.boundary.x - lane.rect.right) < 1
      ) {
        return (
          sameX(shiftedBoundary, lane.boundary, EPS_LOCAL) &&
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
      const railEndIsAdjacent = points.length > 1 && samePoint(points[1], lane.railEnd, EPS_LOCAL);
      const rest = points.slice(railEndIsAdjacent ? 2 : 1);
      const next = rest[0];
      if (next && !orthogonallyAligned(next, shiftedRailEnd)) {
        return undefined;
      }
      return [shiftedBoundary, shiftedRailEnd, ...rest];
    }

    const railEndIsAdjacent =
      points.length > 1 && samePoint(points[points.length - 2], lane.railEnd, EPS_LOCAL);
    const before = points.slice(0, railEndIsAdjacent ? -2 : -1);
    const previous = before[before.length - 1];
    if (previous && !orthogonallyAligned(previous, shiftedRailEnd)) {
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
        if (
          first.edge === second.edge ||
          !(exactTerminalLaneConflict(first, second) || nearTerminalLaneConflict(first, second))
        ) {
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
  const BUFFER = 2;
  const MAX_ITERATIONS = 8;

  const { realNodeRects, labelNodeRects: labelRects } = collectNodeRectEntries(
    nodeByIdMap.values()
  );

  const candidateIsSafe = (edge: any, candidate: PointLite[]): boolean => {
    const sourceId = (edge as { start?: string }).start;
    const targetId = (edge as { end?: string }).end;
    const candidateSegments = segmentsFor(candidate);
    if (candidateSegments.length !== candidate.length - 1) {
      return false;
    }

    const endpointIds = [sourceId, targetId].filter((id): id is string => Boolean(id));
    for (const segment of candidateSegments) {
      if (segmentHitsAnyRect(segment.a, segment.b, realNodeRects, endpointIds, -BUFFER)) {
        return false;
      }
      if (segmentHitsAnyRect(segment.a, segment.b, labelRects, [], -BUFFER)) {
        return false;
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
        for (const otherSegment of segmentsFor(dedupeConsecutivePoints(otherPoints))) {
          if (sameAxisSegmentOverlapLength(candidateSegment, otherSegment, 0.5) >= MIN_SHARED) {
            return false;
          }
          if (
            orthogonalSegmentsStrictlyCross(
              candidateSegment.a,
              candidateSegment.b,
              otherSegment.a,
              otherSegment.b,
              EPS_LOCAL
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
      isHorizontalSegment(p0, p1) &&
      isVerticalSegment(p1, p2) &&
      isHorizontalSegment(p2, p3) &&
      isVerticalSegment(p3, p4) &&
      sameX(p0, p3, EPS_LOCAL) &&
      sameX(p0, p4, EPS_LOCAL) &&
      sameX(p1, p2, EPS_LOCAL) &&
      (p1.x - p0.x) * (p3.x - p2.x) < 0;

    const terminalHorizontalDogleg =
      isVerticalSegment(p0, p1) &&
      isHorizontalSegment(p1, p2) &&
      isVerticalSegment(p2, p3) &&
      isHorizontalSegment(p3, p4) &&
      sameY(p0, p3, EPS_LOCAL) &&
      sameY(p0, p4, EPS_LOCAL) &&
      sameY(p1, p2, EPS_LOCAL) &&
      (p1.y - p0.y) * (p3.y - p2.y) < 0;

    if (terminalVerticalDogleg || terminalHorizontalDogleg) {
      return dedupeConsecutivePoints([...points.slice(0, i + 1), p4, ...points.slice(i + 5)]);
    }

    if (i + 5 >= points.length) {
      return undefined;
    }
    const p5 = points[i + 5];

    const verticalDogleg =
      isVerticalSegment(p0, p1) &&
      isHorizontalSegment(p1, p2) &&
      isVerticalSegment(p2, p3) &&
      isHorizontalSegment(p3, p4) &&
      isVerticalSegment(p4, p5) &&
      sameX(p0, p4, EPS_LOCAL) &&
      sameX(p0, p5, EPS_LOCAL) &&
      sameX(p2, p3, EPS_LOCAL) &&
      (p2.x - p1.x) * (p4.x - p3.x) < 0;

    const horizontalDogleg =
      isHorizontalSegment(p0, p1) &&
      isVerticalSegment(p1, p2) &&
      isHorizontalSegment(p2, p3) &&
      isVerticalSegment(p3, p4) &&
      isHorizontalSegment(p4, p5) &&
      sameY(p0, p4, EPS_LOCAL) &&
      sameY(p0, p5, EPS_LOCAL) &&
      sameY(p2, p3, EPS_LOCAL) &&
      (p2.y - p1.y) * (p4.y - p3.y) < 0;

    if (!verticalDogleg && !horizontalDogleg) {
      return undefined;
    }

    return dedupeConsecutivePoints([...points.slice(0, i + 1), p5, ...points.slice(i + 6)]);
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let fixed = false;
    for (const edge of edges) {
      if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const points = dedupeConsecutivePoints((edge as { points?: PointLite[] }).points ?? []);
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

export function swapDestinationTerminalTailsToReduceCrossings(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
  const BUFFER = 2;
  const MAX_ITERATIONS = 4;

  interface TerminalTail {
    tailStart: PointLite;
    terminal: PointLite;
  }

  const { realNodeRects } = collectNodeRectEntries(nodeByIdMap.values());
  const visibleEdges = edges.filter((edge) => !(edge as { isLayoutOnly?: boolean }).isLayoutOnly);

  const replacementPointsFor = (
    edge: any,
    replacements: Map<any, PointLite[]> = new Map()
  ): PointLite[] =>
    dedupeConsecutivePoints(
      replacements.get(edge) ?? (edge as { points?: PointLite[] }).points ?? []
    );

  const crossingCount = (replacements: Map<any, PointLite[]> = new Map()): number => {
    let count = 0;
    for (let i = 0; i < visibleEdges.length; i++) {
      const firstSegments = segmentsFor(replacementPointsFor(visibleEdges[i], replacements));
      for (let j = i + 1; j < visibleEdges.length; j++) {
        const secondSegments = segmentsFor(replacementPointsFor(visibleEdges[j], replacements));
        for (const firstSegment of firstSegments) {
          for (const secondSegment of secondSegments) {
            if (
              orthogonalSegmentsStrictlyCross(
                firstSegment.a,
                firstSegment.b,
                secondSegment.a,
                secondSegment.b,
                EPS_LOCAL
              )
            ) {
              count++;
            }
          }
        }
      }
    }
    return count;
  };

  const totalBends = (replacements: Map<any, PointLite[]> = new Map()): number =>
    visibleEdges.reduce(
      (sum, edge) => sum + countOrthogonalBends(replacementPointsFor(edge, replacements)),
      0
    );

  const terminalTailFor = (edge: any): TerminalTail | undefined => {
    const points = replacementPointsFor(edge);
    if (points.length < 4) {
      return undefined;
    }
    const tailStart = points[points.length - 2];
    const terminal = points[points.length - 1];
    if (
      !isHorizontalSegment(tailStart, terminal, EPS_LOCAL) &&
      !isVerticalSegment(tailStart, terminal, EPS_LOCAL)
    ) {
      return undefined;
    }
    return { tailStart, terminal };
  };

  const candidateWithDestinationTail = (edge: any, tail: TerminalTail): PointLite[] | undefined => {
    const points = replacementPointsFor(edge);
    if (points.length < 3) {
      return undefined;
    }
    const start = points[0];
    const firstTurn = points[1];

    let connector: PointLite;
    if (isHorizontalSegment(start, firstTurn, EPS_LOCAL)) {
      connector = { x: firstTurn.x, y: tail.tailStart.y };
    } else if (isVerticalSegment(start, firstTurn, EPS_LOCAL)) {
      connector = { x: tail.tailStart.x, y: firstTurn.y };
    } else {
      return undefined;
    }

    const candidate = simplifyPolyline(
      dedupeConsecutivePoints([start, firstTurn, connector, tail.tailStart, tail.terminal])
    );
    return segmentsFor(candidate).length === candidate.length - 1 ? candidate : undefined;
  };

  const pathHasNodeHit = (edge: any, path: PointLite[]): boolean => {
    const endpointIds = [(edge as { start?: string }).start, (edge as { end?: string }).end].filter(
      (id): id is string => Boolean(id)
    );
    for (const segment of segmentsFor(path)) {
      if (segmentHitsAnyRect(segment.a, segment.b, realNodeRects, endpointIds, -BUFFER)) {
        return true;
      }
    }
    return false;
  };

  const pathHasSharedTrack = (
    edge: any,
    path: PointLite[],
    replacements: Map<any, PointLite[]>
  ): boolean => {
    for (const other of visibleEdges) {
      if (other === edge) {
        continue;
      }
      for (const candidateSegment of segmentsFor(path)) {
        for (const otherSegment of segmentsFor(replacementPointsFor(other, replacements))) {
          if (sameAxisSegmentOverlapLength(candidateSegment, otherSegment, 0.5) >= MIN_SHARED) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const candidateIsSafe = (
    edge: any,
    path: PointLite[],
    replacements: Map<any, PointLite[]>
  ): boolean => !pathHasNodeHit(edge, path) && !pathHasSharedTrack(edge, path, replacements);

  const edgesByDestination = (): Map<string, any[]> => {
    const result = new Map<string, any[]>();
    for (const edge of visibleEdges) {
      const dstId = (edge as { end?: string }).end;
      if (!dstId || !nodeByIdMap.has(dstId)) {
        continue;
      }
      const points = replacementPointsFor(edge);
      if (points.length < 4) {
        continue;
      }
      const bucket = result.get(dstId) ?? [];
      bucket.push(edge);
      result.set(dstId, bucket);
    }
    return result;
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const currentCrossings = crossingCount();
    if (currentCrossings === 0) {
      return;
    }
    const currentBends = totalBends();

    let bestReplacements: Map<any, PointLite[]> | undefined;
    let bestCrossings = currentCrossings;
    let bestBends = currentBends;

    for (const destinationEdges of edgesByDestination().values()) {
      for (let i = 0; i < destinationEdges.length; i++) {
        for (let j = i + 1; j < destinationEdges.length; j++) {
          const first = destinationEdges[i];
          const second = destinationEdges[j];
          const firstTail = terminalTailFor(first);
          const secondTail = terminalTailFor(second);
          if (!firstTail || !secondTail) {
            continue;
          }

          const firstCandidate = candidateWithDestinationTail(first, secondTail);
          const secondCandidate = candidateWithDestinationTail(second, firstTail);
          if (!firstCandidate || !secondCandidate) {
            continue;
          }

          const replacements = new Map<any, PointLite[]>([
            [first, firstCandidate],
            [second, secondCandidate],
          ]);
          if (
            !candidateIsSafe(first, firstCandidate, replacements) ||
            !candidateIsSafe(second, secondCandidate, replacements)
          ) {
            continue;
          }

          const candidateCrossings = crossingCount(replacements);
          const candidateBends = totalBends(replacements);
          if (candidateCrossings >= currentCrossings) {
            continue;
          }
          if (
            candidateCrossings > bestCrossings ||
            (candidateCrossings === bestCrossings && candidateBends >= bestBends)
          ) {
            continue;
          }
          bestReplacements = replacements;
          bestCrossings = candidateCrossings;
          bestBends = candidateBends;
        }
      }
    }

    if (!bestReplacements) {
      return;
    }

    for (const [edge, points] of bestReplacements) {
      (edge as { points: PointLite[] }).points = points;
    }
  }
}

export function resolveRenderedOrthogonalCrossings(
  edges: any[],
  nodeByIdMap: Map<string, any>
): void {
  const ANCHOR = 20;
  const MAX_ITERATIONS = 4;

  interface NodeInfo {
    id: string;
    cx: number;
    cy: number;
    rect: RectLite;
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
    const rect = rectOfNodeBounds(node);
    if (!rect) {
      continue;
    }
    realNodes.push({
      id: String((node as { id?: string }).id ?? ''),
      cx,
      cy,
      rect,
    });
  }

  if (realNodes.length === 0) {
    return;
  }

  const nodeInfoById = new Map(realNodes.map((node) => [node.id, node]));
  const sides: RectSide[] = ['top', 'bottom', 'left', 'right'];
  const outsideTracks = {
    top: Math.min(...realNodes.map((node) => node.rect.top)) - ANCHOR,
    bottom: Math.max(...realNodes.map((node) => node.rect.bottom)) + ANCHOR,
    left: Math.min(...realNodes.map((node) => node.rect.left)) - ANCHOR,
    right: Math.max(...realNodes.map((node) => node.rect.right)) + ANCHOR,
  };

  const visibleEdges = edges.filter((edge) => !(edge as { isLayoutOnly?: boolean }).isLayoutOnly);

  const pointsFor = (edge: any, replacementEdge?: any, replacement?: PointLite[]): PointLite[] =>
    dedupeConsecutivePoints(
      edge === replacementEdge
        ? (replacement ?? [])
        : ((edge as { points?: PointLite[] }).points ?? [])
    );

  const crossingCount = (replacementEdge?: any, replacement?: PointLite[]): number => {
    let count = 0;
    for (let i = 0; i < visibleEdges.length; i++) {
      const first = visibleEdges[i];
      const firstSegments = segmentsFor(pointsFor(first, replacementEdge, replacement));
      for (let j = i + 1; j < visibleEdges.length; j++) {
        const second = visibleEdges[j];
        const secondSegments = segmentsFor(pointsFor(second, replacementEdge, replacement));
        for (const firstSegment of firstSegments) {
          for (const secondSegment of secondSegments) {
            if (
              orthogonalSegmentsStrictlyCross(
                firstSegment.a,
                firstSegment.b,
                secondSegment.a,
                secondSegment.b,
                EPS_LOCAL
              )
            ) {
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
    for (const other of visibleEdges) {
      if (other === edge) {
        continue;
      }
      for (const candidateSegment of pathSegments) {
        for (const otherSegment of segmentsFor(pointsFor(other))) {
          if (sameAxisSegmentOverlapLength(candidateSegment, otherSegment, 0.5) >= MIN_SHARED) {
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

  const pathHitsNode = (path: PointLite[]): boolean => {
    for (const segment of segmentsFor(path)) {
      for (const node of realNodes) {
        if (segmentHitsRectInterior(segment, node.rect)) {
          return true;
        }
      }
    }
    return false;
  };

  const buildCandidatesForSides = (
    src: PointLite,
    srcSide: RectSide,
    dst: PointLite,
    dstSide: RectSide
  ): PointLite[][] => {
    const candidates: PointLite[][] = [];
    const base = buildOrthogonalPortPath(src, srcSide, dst, dstSide, ANCHOR, EPS_LOCAL);
    if (base) {
      candidates.push(base);
    }

    if (srcSide === dstSide) {
      if (srcSide === 'left' || srcSide === 'right') {
        const localX =
          srcSide === 'left' ? Math.min(src.x, dst.x) - ANCHOR : Math.max(src.x, dst.x) + ANCHOR;
        candidates.push(buildSameSideTrackPath(src, srcSide, dst, localX));
        candidates.push(buildSameSideTrackPath(src, srcSide, dst, outsideTracks[srcSide]));
      } else {
        const localY =
          srcSide === 'top' ? Math.min(src.y, dst.y) - ANCHOR : Math.max(src.y, dst.y) + ANCHOR;
        candidates.push(buildSameSideTrackPath(src, srcSide, dst, localY));
        candidates.push(buildSameSideTrackPath(src, srcSide, dst, outsideTracks[srcSide]));
      }
    }

    const seen = new Set<string>();
    return candidates
      .map((candidate) => dedupeConsecutivePoints(candidate))
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
      const srcPort = portForRectSide(srcNode, srcSide);
      for (const dstSide of sides) {
        candidates.push(
          ...buildCandidatesForSides(srcPort, srcSide, portForRectSide(dstNode, dstSide), dstSide)
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

    for (const edge of visibleEdges) {
      for (const candidate of candidatePathsFor(edge)) {
        if (pathHitsNode(candidate) || pathHasSegmentConflict(edge, candidate)) {
          continue;
        }
        const candidateCrossings = crossingCount(edge, candidate);
        const candidateBends = countOrthogonalBends(candidate, EPS_LOCAL);
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
