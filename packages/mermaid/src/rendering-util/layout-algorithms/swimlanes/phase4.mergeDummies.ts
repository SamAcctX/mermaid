import type { Graph, Coordinates, NodeId, EdgeRef } from './helpers.js';
import { EDGE_ROUTING } from './config.js';

// cspell:ignore bvert

const EDGE_GAP = EDGE_ROUTING.EDGE_GAP;
const LANE_MARGIN = EDGE_ROUTING.LANE_MARGIN;

interface LaneInfo {
  left: number;
  right: number;
  center: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  id: NodeId;
}

interface Interval {
  a: number;
  b: number;
}

interface CorridorLocation {
  x: number;
  key: string;
}

function createNodeAccessors(gWithDummies: Graph, original: Graph) {
  const getNode = (id: NodeId) => original.nodeById.get(id) as any;
  const isDummy = (id: NodeId) => !!(gWithDummies.nodeById.get(id) as any)?.isDummy;
  const isEdgeLabelNode = (id: NodeId) => !!(gWithDummies.nodeById.get(id) as any)?.isEdgeLabel;
  const getWidth = (id: NodeId) => (getNode(id)?.width as number | undefined) ?? 0;
  const getHeight = (id: NodeId) => (getNode(id)?.height as number | undefined) ?? 0;

  const topLaneOf = (id: NodeId): string | null => {
    const n = getNode(id);
    if (!n || (isDummy(id) && !isEdgeLabelNode(id))) {
      return null;
    }
    let pid: string | undefined = n.parentId;
    if (!pid) {
      return null;
    }
    let parent = original.nodeById.get(pid) as any;
    while (parent?.parentId) {
      pid = parent.parentId;
      parent = original.nodeById.get(pid!) as any;
    }
    return pid ?? null;
  };

  return { getNode, isDummy, getWidth, getHeight, topLaneOf };
}

function buildLaneExtents(
  coords: Coordinates,
  accessors: ReturnType<typeof createNodeAccessors>
): Map<string | null, LaneInfo> {
  const { isDummy, topLaneOf, getWidth } = accessors;
  const lanes = new Map<string | null, LaneInfo>();

  for (const [idStr, xi] of Object.entries(coords.x)) {
    const id = idStr;
    if (isDummy(id)) {
      continue;
    }
    const lane = topLaneOf(id);
    const w = getWidth(id);
    const left = xi - w / 2;
    const right = xi + w / 2;
    const li = lanes.get(lane) ?? { left: Infinity, right: -Infinity, center: 0 };
    li.left = Math.min(li.left, left);
    li.right = Math.max(li.right, right);
    li.center = (li.left + li.right) / 2;
    lanes.set(lane, li);
  }

  return lanes;
}

function createCorridorUtils(lanes: Map<string | null, LaneInfo>) {
  const laneMargin = LANE_MARGIN;

  const laneOrder = [...lanes.entries()]
    .map(([k, v]) => ({ id: k, ...v }))
    .sort((a, b) => a.center - b.center)
    .map((x) => x.id);

  const laneIndex = (laneId: string | null) => laneOrder.indexOf(laneId);
  const laneLeft = (laneId: string | null) => lanes.get(laneId)?.left ?? 0;
  const laneRight = (laneId: string | null) => lanes.get(laneId)?.right ?? 0;

  const corridorBetween = (la: string | null, lb: string | null): CorridorLocation => {
    const ia = laneIndex(la);
    const ib = laneIndex(lb);
    const leftLane = ia <= ib ? la : lb;
    const rightLane = ia <= ib ? lb : la;
    const leftR = laneRight(leftLane);
    const rightL = laneLeft(rightLane);
    const cx = (leftR + rightL) / 2;
    const key = `between:${leftLane}|${rightLane}`;
    return { x: cx, key };
  };

  const internalRight = (laneId: string | null): CorridorLocation => {
    const x = laneRight(laneId) + laneMargin;
    return { x, key: `internal:${laneId}:right` };
  };

  const internalLeft = (laneId: string | null): CorridorLocation => {
    const x = laneLeft(laneId) - laneMargin;
    return { x, key: `internal:${laneId}:left` };
  };

  return {
    laneMargin,
    laneLeft,
    laneRight,
    corridorBetween,
    internalRight,
    internalLeft,
  };
}

function buildObstacles(
  coords: Coordinates,
  accessors: ReturnType<typeof createNodeAccessors>
): Rect[] {
  const { isDummy, getNode, getWidth, getHeight } = accessors;
  const obstacles: Rect[] = [];

  for (const [idStr] of Object.entries(coords.x)) {
    const id = idStr;
    if (isDummy(id)) {
      continue;
    }
    const n = getNode(id);
    if (!n || n.isGroup) {
      continue;
    }
    const cx = coords.x[id];
    const cy = coords.y[id];
    const w = getWidth(id);
    const h = getHeight(id);
    obstacles.push({
      id,
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    });
  }

  return obstacles;
}

function createClearanceCheckers(obstacles: Rect[]) {
  const clearHorizontal = (y: number, x1: number, x2: number, skip: Set<NodeId>) => {
    const a = Math.min(x1, x2);
    const b = Math.max(x1, x2);
    for (const r of obstacles) {
      if (skip.has(r.id)) {
        continue;
      }
      if (y >= r.top && y <= r.bottom && !(b <= r.left || a >= r.right)) {
        return false;
      }
    }
    return true;
  };

  const clearVertical = (x: number, y1: number, y2: number, skip: Set<NodeId>) => {
    const a = Math.min(y1, y2);
    const b = Math.max(y1, y2);
    for (const r of obstacles) {
      if (skip.has(r.id)) {
        continue;
      }
      if (x >= r.left && x <= r.right && !(b <= r.top || a >= r.bottom)) {
        return false;
      }
    }
    return true;
  };

  return { clearHorizontal, clearVertical };
}

function createIntervalUtils() {
  const occupies = (intervals: Interval[], a: number, b: number): boolean => {
    const x = Math.min(a, b);
    const y = Math.max(a, b);
    for (const iv of intervals) {
      if (!(y <= iv.a || x >= iv.b)) {
        return true;
      }
    }
    return false;
  };

  const reserveInterval = (intervals: Interval[], a: number, b: number) => {
    intervals.push({ a: Math.min(a, b), b: Math.max(a, b) });
  };

  return { occupies, reserveInterval };
}

function createTrackAllocator(
  edgeGap: number,
  intervalUtils: ReturnType<typeof createIntervalUtils>
) {
  const { occupies, reserveInterval } = intervalUtils;

  const intervalsForTrack = (
    reservations: Map<string, Map<number, Interval[]>>,
    key: string,
    track: number
  ): Interval[] => {
    let tracks = reservations.get(key);
    if (!tracks) {
      tracks = new Map<number, Interval[]>();
      reservations.set(key, tracks);
    }
    let laneIntervals = tracks.get(track);
    if (!laneIntervals) {
      laneIntervals = [];
      tracks.set(track, laneIntervals);
    }
    return laneIntervals;
  };

  const chooseTrack = (
    reservations: Map<string, Map<number, Interval[]>>,
    key: string,
    a: number,
    b: number
  ): number => {
    for (let k = 0; ; k++) {
      const laneIntervals = intervalsForTrack(reservations, key, k);
      if (!occupies(laneIntervals, a, b)) {
        reserveInterval(laneIntervals, a, b);
        return k * edgeGap;
      }
    }
  };

  const corridorRes = new Map<string, Map<number, Interval[]>>();

  const hCorridorRes = new Map<string, Map<number, Interval[]>>();

  const chooseHTrackOffset = (key: string, x1: number, x2: number): number =>
    chooseTrack(hCorridorRes, key, x1, x2);

  const horizRes = new Map<string, Interval[]>();
  const vertRes = new Map<string, Interval[]>();
  const horizKey = (y: number) => y.toFixed(2);
  const vertKey = (x: number) => x.toFixed(2);

  const canReserveHorizontal = (y: number, x1: number, x2: number): boolean => {
    const key = horizKey(y);
    const arr = horizRes.get(key);
    if (!arr) {
      return true;
    }
    return !occupies(arr, x1, x2);
  };

  const reserveHorizontal = (y: number, x1: number, x2: number) => {
    const key = horizKey(y);
    let arr = horizRes.get(key);
    if (!arr) {
      arr = [];
      horizRes.set(key, arr);
    }
    reserveInterval(arr, x1, x2);
  };

  const canReserveVertical = (x: number, y1: number, y2: number): boolean => {
    const key = vertKey(x);
    const arr = vertRes.get(key);
    if (!arr) {
      return true;
    }
    return !occupies(arr, y1, y2);
  };

  const reserveVertical = (x: number, y1: number, y2: number) => {
    const key = vertKey(x);
    let arr = vertRes.get(key);
    if (!arr) {
      arr = [];
      vertRes.set(key, arr);
    }
    reserveInterval(arr, y1, y2);
  };

  const boundaryVRes = new Map<string, Map<number, Interval[]>>();

  const chooseBoundaryVTrack = (key: string, y1: number, y2: number): number =>
    chooseTrack(boundaryVRes, key, y1, y2);

  const allocateCorridorVTrack = (key: string, baseX: number, y1: number, y2: number): number => {
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    for (let k = 0; ; k++) {
      const laneIntervals = intervalsForTrack(corridorRes, key, k);
      if (!occupies(laneIntervals, lo, hi)) {
        const cx = baseX + k * edgeGap;
        if (canReserveVertical(cx, lo, hi)) {
          reserveInterval(laneIntervals, lo, hi);
          reserveVertical(cx, lo, hi);
          return k * edgeGap;
        }
      }
    }
  };

  return {
    chooseHTrackOffset,
    canReserveHorizontal,
    reserveHorizontal,
    canReserveVertical,
    reserveVertical,
    chooseBoundaryVTrack,
    allocateCorridorVTrack,
  };
}

export function mergeDummies(
  coords: Coordinates,
  gWithDummies: Graph,
  original: Graph
): Coordinates {
  const out: Coordinates = {
    x: { ...coords.x },
    y: { ...coords.y },
    edgePoints: {},
  };

  const accessors = createNodeAccessors(gWithDummies, original);
  const { topLaneOf } = accessors;

  const lanes = buildLaneExtents(out, accessors);
  const corridorUtils = createCorridorUtils(lanes);
  const { laneMargin, laneLeft, laneRight, corridorBetween, internalRight, internalLeft } =
    corridorUtils;

  const obstacles = buildObstacles(out, accessors);
  const { clearHorizontal, clearVertical } = createClearanceCheckers(obstacles);

  const intervalUtils = createIntervalUtils();
  const trackAllocator = createTrackAllocator(EDGE_GAP, intervalUtils);
  const {
    chooseHTrackOffset,
    canReserveHorizontal,
    reserveHorizontal,
    canReserveVertical,
    reserveVertical,
    chooseBoundaryVTrack,
    allocateCorridorVTrack,
  } = trackAllocator;

  const byRef = new Map<string, EdgeRef[]>();

  for (const e of gWithDummies.edges) {
    const rid = e.ref.id;
    if (!byRef.has(rid)) {
      byRef.set(rid, []);
    }
    byRef.get(rid)!.push(e);
  }

  const fanoutSide = new Map<NodeId, 'left' | 'right'>();
  {
    const perSrc = new Map<NodeId, NodeId[]>();
    for (const [, chain] of byRef) {
      const r = chain[0]?.ref;
      if (r?.start == null || r.end == null) {
        continue;
      }
      const arr = perSrc.get(r.start) ?? [];
      arr.push(r.end);
      perSrc.set(r.start, arr);
    }
    for (const [s, outs] of perSrc) {
      if (outs.length <= 1) {
        continue;
      }
      const sl = topLaneOf(s);
      const left = internalLeft(sl).x;
      const right = internalRight(sl).x;
      const sx = out.x[s] ?? 0;
      let costL = 0;
      let costR = 0;
      for (const t of outs) {
        const tx = out.x[t] ?? 0;
        costL += Math.abs(sx - left) + Math.abs(tx - left);
        costR += Math.abs(sx - right) + Math.abs(tx - right);
      }
      fanoutSide.set(s, costR <= costL ? 'right' : 'left');
    }
  }

  for (const [rid, chainEdges] of byRef) {
    const ref = chainEdges[0]?.ref;
    if (!ref) {
      continue;
    }
    const src = ref.start!;
    const dst = ref.end!;
    const points: { x: number; y: number }[] = [];
    if (out.x[src] == null || out.y[src] == null || out.x[dst] == null || out.y[dst] == null) {
      (out.edgePoints as any)[rid] = points;
      continue;
    }

    const sx = out.x[src];
    const sy = out.y[src];
    const tx = out.x[dst];
    const ty = out.y[dst];
    const sl = topLaneOf(src);
    const tl = topLaneOf(dst);

    points.push({ x: sx, y: sy });

    const skip = new Set<NodeId>([src, dst]);
    if (
      Math.abs(sy - ty) < 1e-6 &&
      clearHorizontal(sy, sx, tx, skip) &&
      canReserveHorizontal(sy, sx, tx)
    ) {
      reserveHorizontal(sy, sx, tx);
      points.push({ x: tx, y: ty });
      (out.edgePoints as any)[rid] = points;
      continue;
    }
    if (
      Math.abs(sx - tx) < 1e-6 &&
      clearVertical(sx, sy, ty, skip) &&
      canReserveVertical(sx, sy, ty)
    ) {
      reserveVertical(sx, sy, ty);
      const midY = (sy + ty) / 2;
      points.push({ x: sx, y: midY });
      points.push({ x: tx, y: ty });
      (out.edgePoints as any)[rid] = points;
      continue;
    }

    const sameLane = sl === tl;
    const sr = laneRight(sl);
    const slf = laneLeft(sl);
    const tr = laneRight(tl);
    const tlf = laneLeft(tl);

    if (sameLane) {
      const right = internalRight(sl);
      const left = internalLeft(sl);
      const costR = Math.abs(right.x - sx) + Math.abs(tx - right.x);
      const costL = Math.abs(left.x - sx) + Math.abs(tx - left.x);
      let useRight = costR <= costL;
      const foSide = fanoutSide.get(src);
      if (foSide) {
        useRight = foSide === 'right';
      }
      const base = useRight ? right : left;
      const baseX = base.x;
      const key = base.key;
      const outKey = `boundary:${sl}:${useRight ? 'right' : 'left'}:y=${sy.toFixed(2)}`;
      const hOut = chooseHTrackOffset(outKey, Math.min(sx, baseX), Math.max(sx, baseX));
      const shy = sy + hOut;
      if (shy !== sy) {
        points.push({ x: sx, y: shy });
      }
      const vOff = allocateCorridorVTrack(key, baseX, Math.min(shy, ty), Math.max(shy, ty));
      const cx = baseX + vOff;
      points.push({ x: cx, y: shy });
      points.push({ x: cx, y: ty });
      const inKey = `boundary:${tl}:${useRight ? 'right' : 'left'}:y=${ty.toFixed(2)}`;
      const hIn = chooseHTrackOffset(inKey, Math.min(cx, tx), Math.max(cx, tx));
      const thy = ty + hIn;
      if (thy !== ty) {
        points.push({ x: cx, y: thy });
      }
      points.push({ x: tx, y: thy });
      if (thy !== ty) {
        points.push({ x: tx, y: ty });
      }
    } else {
      const { x: midX, key } = corridorBetween(sl, tl);
      let goRight = midX >= sx;
      const foSide2 = fanoutSide.get(src);
      if (foSide2) {
        goRight = foSide2 === 'right';
      }
      const exitX = goRight ? sr + laneMargin / 2 : slf - laneMargin / 2;
      const outKey = `boundary:${sl}:${goRight ? 'right' : 'left'}:y=${sy.toFixed(2)}`;
      const hOut = chooseHTrackOffset(outKey, Math.min(sx, exitX), Math.max(sx, exitX));
      const shy = sy + hOut;
      if (shy !== sy) {
        points.push({ x: sx, y: shy });
      }
      let bX1 = exitX;
      const vOff = allocateCorridorVTrack(key, midX, Math.min(shy, ty), Math.max(shy, ty));
      const cx = midX + vOff;
      const hKeySy = `${key}:y=${shy.toFixed(2)}`;
      const hOff1 = chooseHTrackOffset(hKeySy, Math.min(exitX, cx), Math.max(exitX, cx));
      const hy1 = shy + hOff1;
      if (hy1 !== shy) {
        const bKeyS = `bvert:${sl}:${goRight ? 'right' : 'left'}`;
        const bOffS = chooseBoundaryVTrack(bKeyS, Math.min(shy, hy1), Math.max(shy, hy1));
        bX1 = exitX + bOffS;
      }
      points.push({ x: bX1, y: shy });
      if (hy1 !== shy) {
        points.push({ x: bX1, y: hy1 });
      }
      points.push({ x: cx, y: hy1 });
      points.push({ x: cx, y: ty });
      const enterX = cx <= tx ? tlf - laneMargin / 2 : tr + laneMargin / 2;
      const hKeyTy = `${key}:y=${ty.toFixed(2)}`;
      const hOff2 = chooseHTrackOffset(hKeyTy, Math.min(enterX, cx), Math.max(enterX, cx));
      const hy2 = ty + hOff2;
      let bX2 = enterX;
      if (hy2 !== ty) {
        const bKeyT = `bvert:${tl}:${cx <= tx ? 'left' : 'right'}`;
        const bOffT = chooseBoundaryVTrack(bKeyT, Math.min(hy2, ty), Math.max(hy2, ty));
        bX2 = enterX + bOffT;
        points.push({ x: cx, y: hy2 });
      }
      points.push({ x: bX2, y: hy2 });
      const inNodeKey = `in-node:${dst}:${cx <= tx ? 'left' : 'right'}`;
      const hInNode = chooseHTrackOffset(inNodeKey, Math.min(bX2, tx), Math.max(bX2, tx));
      const ty2 = ty + hInNode;
      if (hy2 !== ty2) {
        points.push({ x: bX2, y: ty2 });
      }
      points.push({ x: tx, y: ty2 });
      if (ty2 !== ty) {
        points.push({ x: tx, y: ty });
      }
    }

    const cleaned: { x: number; y: number }[] = [];
    for (const p of points) {
      const last = cleaned[cleaned.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) {
        cleaned.push(p);
      }
    }
    (out.edgePoints as any)[rid] = cleaned;
  }

  return out;
}
