const EPS = 1e-3;

export interface Point {
  x: number;
  y: number;
}

export interface RectBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface RectEntry {
  id: string;
  rect: RectBounds;
}

export interface NodeBoundsInfo extends RectEntry {
  cx: number;
  cy: number;
}

interface NodeBoundsInput {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isGroup?: boolean;
  isEdgeLabel?: boolean;
}

interface SimplifyPassResult {
  points: Point[];
  changed: boolean;
}

export function samePoint(a: Point, b: Point, epsilon = EPS): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

export function sameX(a: Point, b: Point, epsilon = EPS): boolean {
  return Math.abs(a.x - b.x) < epsilon;
}

export function sameY(a: Point, b: Point, epsilon = EPS): boolean {
  return Math.abs(a.y - b.y) < epsilon;
}

export function isHorizontalSegment(a: Point, b: Point, epsilon = EPS): boolean {
  return sameY(a, b, epsilon) && Math.abs(a.x - b.x) > epsilon;
}

export function isVerticalSegment(a: Point, b: Point, epsilon = EPS): boolean {
  return sameX(a, b, epsilon) && Math.abs(a.y - b.y) > epsilon;
}

export function overlapLength(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(
    0,
    Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
  );
}

export function dedupeConsecutivePoints(points: Point[], epsilon = EPS): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.length > 0 ? result[result.length - 1] : undefined;
    if (!last || !samePoint(last, point, epsilon)) {
      result.push({ x: point.x, y: point.y });
    }
  }
  return result;
}

export function segmentBoundsOverlapRect(
  a: Point,
  b: Point,
  rect: RectBounds,
  buffer = 0
): boolean {
  const segMinX = Math.min(a.x, b.x);
  const segMaxX = Math.max(a.x, b.x);
  const segMinY = Math.min(a.y, b.y);
  const segMaxY = Math.max(a.y, b.y);
  return (
    segMaxX > rect.left - buffer &&
    segMinX < rect.right + buffer &&
    segMaxY > rect.top - buffer &&
    segMinY < rect.bottom + buffer
  );
}

export function rectFromCenterSize(
  cx: number,
  cy: number,
  width: number,
  height: number
): RectBounds {
  return {
    left: cx - width / 2,
    right: cx + width / 2,
    top: cy - height / 2,
    bottom: cy + height / 2,
  };
}

export function collectRealNodeBounds(nodes: Iterable<NodeBoundsInput>): {
  nodeInfoById: Map<string, NodeBoundsInfo>;
  realNodeRects: RectEntry[];
} {
  const nodeInfoById = new Map<string, NodeBoundsInfo>();
  const realNodeRects: RectEntry[] = [];
  for (const node of nodes) {
    if (node.isGroup || node.isEdgeLabel) {
      continue;
    }
    const cx = node.x ?? 0;
    const cy = node.y ?? 0;
    const width = node.width ?? 0;
    const height = node.height ?? 0;
    if (width <= 0 || height <= 0) {
      continue;
    }
    const id = String(node.id ?? '');
    const info: NodeBoundsInfo = {
      id,
      cx,
      cy,
      rect: rectFromCenterSize(cx, cy, width, height),
    };
    nodeInfoById.set(id, info);
    realNodeRects.push({ id, rect: info.rect });
  }
  return { nodeInfoById, realNodeRects };
}

export function segmentHitsAnyRect(
  a: Point,
  b: Point,
  rects: RectEntry[],
  excludeIds: string[] = [],
  shrink = 0
): boolean {
  for (const entry of rects) {
    if (excludeIds.includes(entry.id)) {
      continue;
    }
    if (segmentBoundsOverlapRect(a, b, entry.rect, -shrink)) {
      return true;
    }
  }
  return false;
}

export function orthogonalSegmentsCross(
  a1: Point,
  b1: Point,
  a2: Point,
  b2: Point,
  epsilon = EPS,
  endpointTolerance = 1e-6
): boolean {
  const s1H = Math.abs(a1.y - b1.y) < epsilon;
  const s1V = Math.abs(a1.x - b1.x) < epsilon;
  const s2H = Math.abs(a2.y - b2.y) < epsilon;
  const s2V = Math.abs(a2.x - b2.x) < epsilon;
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

  const matchesHorizEndpoint =
    (Math.abs(vX - horiz.a.x) < endpointTolerance &&
      Math.abs(hY - horiz.a.y) < endpointTolerance) ||
    (Math.abs(vX - horiz.b.x) < endpointTolerance && Math.abs(hY - horiz.b.y) < endpointTolerance);
  const matchesVertEndpoint =
    (Math.abs(vX - vert.a.x) < endpointTolerance && Math.abs(hY - vert.a.y) < endpointTolerance) ||
    (Math.abs(vX - vert.b.x) < endpointTolerance && Math.abs(hY - vert.b.y) < endpointTolerance);
  return !(matchesHorizEndpoint && matchesVertEndpoint);
}

export function orthogonalSegmentsStrictlyCross(
  a1: Point,
  b1: Point,
  a2: Point,
  b2: Point,
  epsilon = EPS
): boolean {
  const aHoriz = sameY(a1, b1, epsilon);
  const aVert = sameX(a1, b1, epsilon);
  const bHoriz = sameY(a2, b2, epsilon);
  const bVert = sameX(a2, b2, epsilon);
  if (!((aHoriz && bVert) || (aVert && bHoriz))) {
    return false;
  }

  const horiz = aHoriz ? { a: a1, b: b1 } : { a: a2, b: b2 };
  const vert = aHoriz ? { a: a2, b: b2 } : { a: a1, b: b1 };
  const hY = horiz.a.y;
  const hXmin = Math.min(horiz.a.x, horiz.b.x);
  const hXmax = Math.max(horiz.a.x, horiz.b.x);
  const vX = vert.a.x;
  const vYmin = Math.min(vert.a.y, vert.b.y);
  const vYmax = Math.max(vert.a.y, vert.b.y);
  return (
    vX > hXmin + epsilon && vX < hXmax - epsilon && hY > vYmin + epsilon && hY < vYmax - epsilon
  );
}

function strictlyBetween(value: number, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return value > lo + EPS && value < hi - EPS;
}

function isCollinearIntermediate(prev: Point, cur: Point, next: Point): boolean {
  if (sameX(prev, cur) && sameX(cur, next)) {
    return strictlyBetween(cur.y, prev.y, next.y);
  }

  if (sameY(prev, cur) && sameY(cur, next)) {
    return strictlyBetween(cur.x, prev.x, next.x);
  }

  return false;
}

function simplifyPolylineOnce(points: Point[]): SimplifyPassResult {
  let changed = false;
  const out: Point[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = i + 1 < points.length ? points[i + 1] : undefined;
    if (prev && next) {
      if (samePoint(prev, next)) {
        i++;
        changed = true;
        continue;
      }

      if (isCollinearIntermediate(prev, cur, next)) {
        changed = true;
        continue;
      }
    }
    out.push(cur);
  }

  return { points: out, changed };
}

// Inserts orthogonal L-bends and removes consecutive duplicate points.
export function orthogonalizePolyline(pts: Point[]): Point[] {
  const cleaned: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const curr = pts[i];
    if (!sameX(prev, curr) && !sameY(prev, curr)) {
      const prevPrev = cleaned.length >= 2 ? cleaned[cleaned.length - 2] : undefined;
      const incomingVertical = prevPrev ? sameX(prevPrev, prev) : false;
      const corner = incomingVertical ? { x: prev.x, y: curr.y } : { x: curr.x, y: prev.y };
      cleaned.push(corner);
    }
    cleaned.push(curr);
  }
  const deduped: Point[] = [];
  for (const p of cleaned) {
    const last = deduped[deduped.length - 1];
    if (!last || !samePoint(last, p)) {
      deduped.push(p);
    }
  }
  return deduped;
}

export function simplifyPolyline(pts: Point[]): Point[] {
  if (pts.length < 3) {
    return pts;
  }
  let work = [...pts];
  for (let guard = 0; guard < 32; guard++) {
    const result = simplifyPolylineOnce(work);
    work = result.points;
    if (!result.changed) {
      break;
    }
  }
  return work;
}
