import { orthogonalizePolyline, simplifyPolyline } from './geometry.js';

const EPS = 1e-3;
const INSIDE_EPS = 0.5;

interface Point {
  x: number;
  y: number;
}

interface NodeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

type BorderSide = 'top' | 'bottom' | 'left' | 'right';

function rectOfNode(node: any): NodeRect | undefined {
  const cx = node?.x ?? 0;
  const cy = node?.y ?? 0;
  const w = node?.width ?? 0;
  const h = node?.height ?? 0;
  if (w <= 0 || h <= 0) {
    return undefined;
  }
  return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

function strictlyInside(p: Point, r: NodeRect): boolean {
  return (
    p.x > r.left + INSIDE_EPS &&
    p.x < r.right - INSIDE_EPS &&
    p.y > r.top + INSIDE_EPS &&
    p.y < r.bottom - INSIDE_EPS
  );
}

// Given an axis-aligned segment from outside a rect to inside it, return the
// point where the segment enters the rect boundary.
function segmentEnterPoint(outside: Point, inside: Point, r: NodeRect): Point {
  if (Math.abs(outside.y - inside.y) < EPS) {
    const x = outside.x < r.left ? r.left : r.right;
    return { x, y: outside.y };
  }
  if (Math.abs(outside.x - inside.x) < EPS) {
    const y = outside.y < r.top ? r.top : r.bottom;
    return { x: outside.x, y };
  }
  return {
    x: Math.min(r.right, Math.max(r.left, outside.x)),
    y: Math.min(r.bottom, Math.max(r.top, outside.y)),
  };
}

function clipStart(points: Point[], rect: NodeRect): Point[] {
  let firstOutside = 0;
  while (firstOutside < points.length && strictlyInside(points[firstOutside], rect)) {
    firstOutside++;
  }
  if (firstOutside > 0 && firstOutside < points.length) {
    const entry = segmentEnterPoint(points[firstOutside], points[firstOutside - 1], rect);
    return [entry, ...points.slice(firstOutside)];
  }
  return points;
}

function clipEnd(points: Point[], rect: NodeRect): Point[] {
  let lastOutside = points.length - 1;
  while (lastOutside >= 0 && strictlyInside(points[lastOutside], rect)) {
    lastOutside--;
  }
  if (lastOutside < points.length - 1 && lastOutside >= 0) {
    const entry = segmentEnterPoint(points[lastOutside], points[lastOutside + 1], rect);
    return [...points.slice(0, lastOutside + 1), entry];
  }
  return points;
}

export function clipEdgeEndpointsToNodeBoundaries(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: Point[] }).points;
    if (!pts || pts.length < 2) {
      continue;
    }
    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const src = srcId ? nodeByIdMap.get(srcId) : undefined;
    const dst = dstId ? nodeByIdMap.get(dstId) : undefined;
    const srcRect = src ? rectOfNode(src) : undefined;
    const dstRect = dst ? rectOfNode(dst) : undefined;

    let next = [...pts];
    if (srcRect) {
      next = clipStart(next, srcRect);
    }
    if (dstRect) {
      next = clipEnd(next, dstRect);
    }

    (edge as { points: Point[] }).points = simplifyPolyline(orthogonalizePolyline(next));
  }
}

function snapEndpointToBoundary(inner: Point, endpoint: Point, r: NodeRect): Point {
  if (Math.abs(inner.y - endpoint.y) < EPS) {
    if (endpoint.y < r.top - EPS || endpoint.y > r.bottom + EPS) {
      return endpoint;
    }
    const toLeft = Math.abs(endpoint.x - r.left) <= Math.abs(endpoint.x - r.right);
    return { x: toLeft ? r.left : r.right, y: inner.y };
  }
  if (Math.abs(inner.x - endpoint.x) < EPS) {
    if (endpoint.x < r.left - EPS || endpoint.x > r.right + EPS) {
      return endpoint;
    }
    const toTop = Math.abs(endpoint.y - r.top) <= Math.abs(endpoint.y - r.bottom);
    return { x: inner.x, y: toTop ? r.top : r.bottom };
  }
  return endpoint;
}

function firstDistinctAdjacent(points: Point[], endpointIndex: number, step: 1 | -1): Point {
  const endpoint = points[endpointIndex];
  for (let index = endpointIndex + step; index >= 0 && index < points.length; index += step) {
    const candidate = points[index];
    if (Math.abs(candidate.x - endpoint.x) > EPS || Math.abs(candidate.y - endpoint.y) > EPS) {
      return candidate;
    }
  }
  return points[endpointIndex + step];
}

function borderSideForSegment(a: Point, b: Point, r: NodeRect): BorderSide | undefined {
  const xWithin = Math.min(a.x, b.x) >= r.left - EPS && Math.max(a.x, b.x) <= r.right + EPS;
  const yWithin = Math.min(a.y, b.y) >= r.top - EPS && Math.max(a.y, b.y) <= r.bottom + EPS;
  if (Math.abs(a.y - r.top) < EPS && Math.abs(b.y - r.top) < EPS && xWithin) {
    return 'top';
  }
  if (Math.abs(a.y - r.bottom) < EPS && Math.abs(b.y - r.bottom) < EPS && xWithin) {
    return 'bottom';
  }
  if (Math.abs(a.x - r.left) < EPS && Math.abs(b.x - r.left) < EPS && yWithin) {
    return 'left';
  }
  if (Math.abs(a.x - r.right) < EPS && Math.abs(b.x - r.right) < EPS && yWithin) {
    return 'right';
  }
  return undefined;
}

function leavesOutward(side: BorderSide, from: Point, to: Point, r: NodeRect): boolean {
  switch (side) {
    case 'top':
      return Math.abs(from.x - to.x) < EPS && to.y < r.top - EPS;
    case 'bottom':
      return Math.abs(from.x - to.x) < EPS && to.y > r.bottom + EPS;
    case 'left':
      return Math.abs(from.y - to.y) < EPS && to.x < r.left - EPS;
    case 'right':
      return Math.abs(from.y - to.y) < EPS && to.x > r.right + EPS;
  }
}

function collapseOwnBorderStub(points: Point[], r: NodeRect, atStart: boolean): Point[] {
  if (points.length < 3) {
    return points;
  }
  if (atStart) {
    const side = borderSideForSegment(points[0], points[1], r);
    if (side && leavesOutward(side, points[1], points[2], r)) {
      return points.slice(1);
    }
    return points;
  }

  const last = points.length - 1;
  const side = borderSideForSegment(points[last - 1], points[last], r);
  if (side && leavesOutward(side, points[last - 1], points[last - 2], r)) {
    return points.slice(0, last);
  }
  return points;
}

function snapAndCollapseEndpoints(
  points: Point[],
  srcRect?: NodeRect,
  dstRect?: NodeRect
): Point[] {
  let next = points;
  if (srcRect) {
    const snapped = snapEndpointToBoundary(firstDistinctAdjacent(next, 0, 1), next[0], srcRect);
    if (snapped !== next[0]) {
      next = [snapped, ...next.slice(1)];
    }
    next = collapseOwnBorderStub(next, srcRect, true);
  }
  if (dstRect) {
    const last = next.length - 1;
    const snapped = snapEndpointToBoundary(
      firstDistinctAdjacent(next, last, -1),
      next[last],
      dstRect
    );
    if (snapped !== next[last]) {
      next = [...next.slice(0, last), snapped];
    }
    next = collapseOwnBorderStub(next, dstRect, false);
  }
  return next;
}

export function prepareEdgeEndpointsForRenderer(edges: unknown[], nodeByIdMap: Map<string, any>) {
  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: Point[] }).points;
    if (!pts || pts.length < 3) {
      continue;
    }
    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const src = srcId ? nodeByIdMap.get(srcId) : undefined;
    const dst = dstId ? nodeByIdMap.get(dstId) : undefined;
    const srcRect = src ? rectOfNode(src) : undefined;
    const dstRect = dst ? rectOfNode(dst) : undefined;

    const newPts = snapAndCollapseEndpoints(pts, srcRect, dstRect);
    const duplicated = [
      newPts[0],
      { ...newPts[0] },
      ...newPts.slice(1, -1),
      newPts[newPts.length - 1],
      { ...newPts[newPts.length - 1] },
    ];
    (edge as { points: Point[] }).points = duplicated;
  }
}
