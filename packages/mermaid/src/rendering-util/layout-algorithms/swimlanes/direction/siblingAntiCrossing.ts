import { isHorizontalSegment, isVerticalSegment } from './geometry.js';

const EPS = 1e-3;

/**
 * Post-routing fix for a specific class of crossings between sibling
 * L-shape edges. When two edges share a source node and both have the
 * 4-point shape [port, turnPoint, turnPoint, portIn] (one horizontal -\>
 * one vertical -\> one horizontal), port distribution can leave them with
 * vertical legs whose x-coordinates cross the other's horizontal legs.
 *
 * The test is geometric: given two L-shape edges from the same source
 * with port-y offsets (port_a above port_b), going in the same general
 * direction (both right, or both left), their vertical legs at track_a
 * and track_b do NOT cross iff:
 *
 * - If port direction is right: track_a is at least as far right as track_b.
 * - If port direction is left: track_a is at least as far left as track_b.
 *
 * When the order is wrong we swap track_a and track_b, which swaps each
 * edge's turn points without changing its endpoints, producing a valid
 * orthogonal path with the same number of bends but no crossing.
 */
export function preventSiblingLShapeCrossings(edges: any[]): void {
  interface LShapeEdge {
    edge: any;
    pts: { x: number; y: number }[];
    src: string;
    portY: number;
    portX: number;
    trackX: number;
    endPortY: number;
    endPortX: number;
    goesRight: boolean;
  }

  const bySrc = new Map<string, LShapeEdge[]>();

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points as { x: number; y: number }[] | undefined;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const [p0, p1, p2, p3] = pts;
    const firstHoriz = isHorizontalSegment(p0, p1, EPS);
    const midVert = isVerticalSegment(p1, p2, EPS);
    const lastHoriz = isHorizontalSegment(p2, p3, EPS);
    if (!firstHoriz || !midVert || !lastHoriz) {
      continue;
    }

    const src = edge.start as string | undefined;
    if (!src) {
      continue;
    }

    const entry: LShapeEdge = {
      edge,
      pts,
      src,
      portY: p0.y,
      portX: p0.x,
      trackX: p1.x,
      endPortX: p3.x,
      endPortY: p3.y,
      goesRight: p1.x > p0.x,
    };
    if (!bySrc.has(src)) {
      bySrc.set(src, []);
    }
    bySrc.get(src)!.push(entry);
  }

  const swapTracks = (a: LShapeEdge, b: LShapeEdge): void => {
    const aTrack = a.trackX;
    const bTrack = b.trackX;
    a.pts[1] = { x: bTrack, y: a.portY };
    a.pts[2] = { x: bTrack, y: a.endPortY };
    b.pts[1] = { x: aTrack, y: b.portY };
    b.pts[2] = { x: aTrack, y: b.endPortY };
    a.trackX = bTrack;
    b.trackX = aTrack;
    (a.edge as { points: { x: number; y: number }[] }).points = a.pts;
    (b.edge as { points: { x: number; y: number }[] }).points = b.pts;
  };

  for (const group of bySrc.values()) {
    if (group.length < 2) {
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.goesRight !== b.goesRight) {
          continue;
        }
        const upper = a.portY <= b.portY ? a : b;
        const lower = upper === a ? b : a;
        const upVertMinY = Math.min(upper.portY, upper.endPortY);
        const upVertMaxY = Math.max(upper.portY, upper.endPortY);
        const loHorizMinX = Math.min(lower.portX, lower.trackX);
        const loHorizMaxX = Math.max(lower.portX, lower.trackX);
        const crosses =
          upper.trackX > loHorizMinX + EPS &&
          upper.trackX < loHorizMaxX - EPS &&
          lower.portY > upVertMinY + EPS &&
          lower.portY < upVertMaxY - EPS;
        if (crosses) {
          swapTracks(a, b);
        }
      }
    }
  }
}
