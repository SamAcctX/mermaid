// cspell:ignore Hegemann Wybrow
import { log } from '../../../../logger.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';
const EPS = 1e-3;

export function simplifyDetouredEdges(edges: any[], nodes: any[]): void {
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
    w: number;
    h: number;
    rect: RectLite;
  }

  const realNodes: NodeInfo[] = [];
  const nodeInfoById = new Map<string, NodeInfo>();
  for (const n of nodes) {
    if ((n as { isGroup?: boolean }).isGroup) {
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
    const info: NodeInfo = {
      id: String((n as { id?: string }).id ?? ''),
      cx,
      cy,
      w,
      h,
      rect: { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 },
    };
    realNodes.push(info);
    nodeInfoById.set(info.id, info);
  }

  const countBends = (pts: { x: number; y: number }[]): number => {
    let bends = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const abH = Math.abs(a.y - b.y) < EPS;
      const bcH = Math.abs(b.y - c.y) < EPS;
      if (abH !== bcH) {
        bends++;
      }
    }
    return bends;
  };

  type Side = 'top' | 'bottom' | 'left' | 'right';
  const sides: Side[] = ['top', 'bottom', 'left', 'right'];

  const portForSide = (n: NodeInfo, side: Side): { x: number; y: number } => {
    switch (side) {
      case 'top':
        return { x: n.cx, y: n.rect.top };
      case 'bottom':
        return { x: n.cx, y: n.rect.bottom };
      case 'left':
        return { x: n.rect.left, y: n.cy };
      case 'right':
        return { x: n.rect.right, y: n.cy };
    }
  };

  // Anchor offset for port exit. Each port's first/last segment must
  // extend in the port's perpendicular direction by at least this many
  // units before turning, so (a) the port-direction check in
  // validateLayout is satisfied and (b) the segment does not hug the
  // node's boundary. Matches raykov's ANCHOR_OFFSET.
  const ANCHOR = 20;

  // Minimal 1- or 2-bend orthogonal path between two cardinal-side
  // ports. Returns undefined if the two sides are incompatible for a
  // clean path (e.g. port directions contradict the required bend
  // direction) — in which case the caller should try another pair.
  const buildOrthogonalPath = (
    src: { x: number; y: number },
    srcSide: Side,
    dst: { x: number; y: number },
    dstSide: Side
  ): { x: number; y: number }[] | undefined => {
    const srcH = srcSide === 'left' || srcSide === 'right';
    const dstH = dstSide === 'left' || dstSide === 'right';

    // Case A: src horizontal, dst horizontal.
    if (srcH && dstH) {
      // Opposite sides (src right ↔ dst left or vice versa) going
      // toward each other — a valid 1-bend or 0-bend path.
      const opposingDir =
        (srcSide === 'right' && dstSide === 'left' && src.x < dst.x) ||
        (srcSide === 'left' && dstSide === 'right' && src.x > dst.x);
      if (opposingDir) {
        if (Math.abs(src.y - dst.y) < EPS) {
          return [src, dst];
        }
        const midX = (src.x + dst.x) / 2;
        return [src, { x: midX, y: src.y }, { x: midX, y: dst.y }, dst];
      }
      // Same-side pairing (left-left or right-right): route via an
      // intermediate x that lies OUTSIDE both nodes by at least ANCHOR.
      if (srcSide === dstSide) {
        if (Math.abs(src.y - dst.y) < EPS) {
          return undefined;
        }
        const intX =
          srcSide === 'left' ? Math.min(src.x, dst.x) - ANCHOR : Math.max(src.x, dst.x) + ANCHOR;
        return [src, { x: intX, y: src.y }, { x: intX, y: dst.y }, dst];
      }
      return undefined;
    }

    // Case B: src vertical, dst vertical.
    if (!srcH && !dstH) {
      // Same-side pairing (top-top or bottom-bottom): route via an
      // intermediate y that lies OUTSIDE both nodes by at least ANCHOR
      // so port-direction and border-hug checks are satisfied. The
      // intermediate y is min(src.y, dst.y) - ANCHOR for top-top, or
      // max(src.y, dst.y) + ANCHOR for bottom-bottom. Always produces a
      // 2-bend path, never 1.
      if (srcSide === dstSide) {
        if (Math.abs(src.x - dst.x) < EPS) {
          // Same x: a straight vertical line doesn't produce a valid
          // two-same-side exit/entry, reject.
          return undefined;
        }
        const intY =
          srcSide === 'top' ? Math.min(src.y, dst.y) - ANCHOR : Math.max(src.y, dst.y) + ANCHOR;
        return [src, { x: src.x, y: intY }, { x: dst.x, y: intY }, dst];
      }
      // Opposite-side pairing (src top ↔ dst bottom or vice versa).
      // Valid only if the two nodes' port directions point toward each
      // other: src bottom going down while dst top is at a larger y, or
      // src top going up while dst bottom is at a smaller y.
      const sameDir =
        (srcSide === 'bottom' && dstSide === 'top' && src.y < dst.y) ||
        (srcSide === 'top' && dstSide === 'bottom' && src.y > dst.y);
      if (!sameDir) {
        return undefined;
      }
      if (Math.abs(src.x - dst.x) < EPS) {
        return [src, dst];
      }
      const midY = (src.y + dst.y) / 2;
      return [src, { x: src.x, y: midY }, { x: dst.x, y: midY }, dst];
    }

    // Case C: src horizontal, dst vertical — 1 bend L-shape.
    if (srcH && !dstH) {
      const sameDirSrc =
        (srcSide === 'right' && dst.x > src.x) || (srcSide === 'left' && dst.x < src.x);
      const sameDirDst =
        (dstSide === 'top' && src.y < dst.y) || (dstSide === 'bottom' && src.y > dst.y);
      if (!sameDirSrc || !sameDirDst) {
        return undefined;
      }
      return [src, { x: dst.x, y: src.y }, dst];
    }

    // Case D: src vertical, dst horizontal — 1 bend L-shape.
    if (!srcH && dstH) {
      const sameDirSrc =
        (srcSide === 'bottom' && dst.y > src.y) || (srcSide === 'top' && dst.y < src.y);
      const sameDirDst =
        (dstSide === 'left' && src.x < dst.x) || (dstSide === 'right' && src.x > dst.x);
      if (!sameDirSrc || !sameDirDst) {
        return undefined;
      }
      return [src, { x: src.x, y: dst.y }, dst];
    }

    // Unreachable because srcH/dstH combinations are all handled above.
    /* istanbul ignore next */
    return undefined;
  };

  const outsideTracks = {
    top: Math.min(...realNodes.map((node) => node.rect.top)) - ANCHOR,
    bottom: Math.max(...realNodes.map((node) => node.rect.bottom)) + ANCHOR,
    left: Math.min(...realNodes.map((node) => node.rect.left)) - ANCHOR,
    right: Math.max(...realNodes.map((node) => node.rect.right)) + ANCHOR,
  };

  const buildOrthogonalPathCandidates = (
    src: { x: number; y: number },
    srcSide: Side,
    dst: { x: number; y: number },
    dstSide: Side
  ): { x: number; y: number }[][] => {
    const paths: { x: number; y: number }[][] = [];
    const base = buildOrthogonalPath(src, srcSide, dst, dstSide);
    if (base) {
      paths.push(base);
    }

    // Crossing-reduction extension of the same-side detour rule above:
    // when the local "just outside these two ports" track still crosses
    // an existing connector, also try the corresponding global outer
    // channel. This mirrors Wybrow-style post-route nudging/ordering:
    // preserve the port pair and topology class, but move the maximal
    // middle segment into an uncongested alley if safety checks accept it.
    if (srcSide === dstSide) {
      if (srcSide === 'top') {
        paths.push([
          src,
          { x: src.x, y: outsideTracks.top },
          { x: dst.x, y: outsideTracks.top },
          dst,
        ]);
      } else if (srcSide === 'bottom') {
        paths.push([
          src,
          { x: src.x, y: outsideTracks.bottom },
          { x: dst.x, y: outsideTracks.bottom },
          dst,
        ]);
      } else if (srcSide === 'left') {
        paths.push([
          src,
          { x: outsideTracks.left, y: src.y },
          { x: outsideTracks.left, y: dst.y },
          dst,
        ]);
      } else {
        paths.push([
          src,
          { x: outsideTracks.right, y: src.y },
          { x: outsideTracks.right, y: dst.y },
          dst,
        ]);
      }
    }

    return paths;
  };

  const pathHitsNode = (pts: { x: number; y: number }[], excludeIds: string[]): boolean => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const segMinX = Math.min(a.x, b.x);
      const segMaxX = Math.max(a.x, b.x);
      const segMinY = Math.min(a.y, b.y);
      const segMaxY = Math.max(a.y, b.y);
      for (const n of realNodes) {
        if (excludeIds.includes(n.id)) {
          continue;
        }
        // Strict interior test with a 1-unit tolerance.
        if (
          segMaxX > n.rect.left + 1 &&
          segMinX < n.rect.right - 1 &&
          segMaxY > n.rect.top + 1 &&
          segMinY < n.rect.bottom - 1
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const segmentsCrossOrth = (
    a1: { x: number; y: number },
    b1: { x: number; y: number },
    a2: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const s1H = Math.abs(a1.y - b1.y) < EPS;
    const s1V = Math.abs(a1.x - b1.x) < EPS;
    const s2H = Math.abs(a2.y - b2.y) < EPS;
    const s2V = Math.abs(a2.x - b2.x) < EPS;
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
      (Math.abs(vX - horiz.a.x) < EPS && Math.abs(hY - horiz.a.y) < EPS) ||
      (Math.abs(vX - horiz.b.x) < EPS && Math.abs(hY - horiz.b.y) < EPS);
    const matchesVertEndpoint =
      (Math.abs(vX - vert.a.x) < EPS && Math.abs(hY - vert.a.y) < EPS) ||
      (Math.abs(vX - vert.b.x) < EPS && Math.abs(hY - vert.b.y) < EPS);
    return !(matchesHorizEndpoint && matchesVertEndpoint);
  };

  const overlapLength = (a1: number, a2: number, b1: number, b2: number): number =>
    Math.max(
      0,
      Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
    );

  const pathConflictCount = (
    path: { x: number; y: number }[],
    currentEdge: any,
    includeIncidentEdges = false
  ): number => {
    const MIN_SHARED = 8;
    let conflicts = 0;
    const currentStart = (currentEdge as { start?: string }).start;
    const currentEnd = (currentEdge as { end?: string }).end;
    for (const other of edges) {
      if (other === currentEdge || (other as { isLayoutOnly?: boolean }).isLayoutOnly) {
        continue;
      }
      const otherStart = (other as { start?: string }).start;
      const otherEnd = (other as { end?: string }).end;
      if (
        !includeIncidentEdges &&
        currentStart &&
        currentEnd &&
        (otherStart === currentStart ||
          otherStart === currentEnd ||
          otherEnd === currentStart ||
          otherEnd === currentEnd)
      ) {
        continue;
      }
      const otherPts = (other as { points?: { x: number; y: number }[] }).points;
      if (!otherPts || otherPts.length < 2) {
        continue;
      }
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const aH = Math.abs(a.y - b.y) < EPS;
        const aV = Math.abs(a.x - b.x) < EPS;
        for (let j = 0; j < otherPts.length - 1; j++) {
          const c = otherPts[j];
          const d = otherPts[j + 1];
          if (segmentsCrossOrth(a, b, c, d)) {
            conflicts++;
            continue;
          }
          const cH = Math.abs(c.y - d.y) < EPS;
          const cV = Math.abs(c.x - d.x) < EPS;
          if (aH && cH && Math.abs(a.y - c.y) < EPS) {
            if (overlapLength(a.x, b.x, c.x, d.x) >= MIN_SHARED) {
              conflicts++;
            }
          } else if (aV && cV && Math.abs(a.x - c.x) < EPS) {
            if (overlapLength(a.y, b.y, c.y, d.y) >= MIN_SHARED) {
              conflicts++;
            }
          }
        }
      }
    }
    return conflicts;
  };

  const BEND_THRESHOLD = 4;

  // Collect which node faces are already claimed by other edges so the
  // rewrite loop below can reject a candidate port pair whose face is
  // contested. This realizes Hegemann-Wolff's bend-or-end global
  // feasibility rule (src d30cdbe1): two edges claiming the same node
  // face must be feasibility-checked as a set, never accepted as a
  // sequential patch.
  //
  // Iter 9 defect: raykov routed L_D_E_0 around H with 4 bends and
  // L_E_F_0 cleanly at E.top in parallel; this pass then rewrote
  // L_D_E_0 to the 2-bend (D.top, E.top) L-shape because it only
  // checked against real-node obstacles and was blind to the E.top
  // claim L_E_F_0 had already made.
  //
  // Note the face-detection uses `nearestSideOfRect` which picks
  // whichever of the 4 rect edges the point is closest to. The
  // polyline endpoints at this point in the pipeline are ALREADY
  // transformed to TB coordinates but the final endpoint-clip pass
  // (which snaps each endpoint onto the actual rect boundary) runs
  // LATER, so the raw attach points may sit a few units inside the
  // node rect. Nearest-side works regardless of whether the point is
  // on, just outside, or a few units inside the rect.
  const nearestSideOfRect = (pt: { x: number; y: number }, info: NodeInfo): Side => {
    const dTop = Math.abs(pt.y - info.rect.top);
    const dBottom = Math.abs(pt.y - info.rect.bottom);
    const dLeft = Math.abs(pt.x - info.rect.left);
    const dRight = Math.abs(pt.x - info.rect.right);
    let best: Side = 'top';
    let bestDist = dTop;
    if (dBottom < bestDist) {
      best = 'bottom';
      bestDist = dBottom;
    }
    if (dLeft < bestDist) {
      best = 'left';
      bestDist = dLeft;
    }
    if (dRight < bestDist) {
      best = 'right';
      bestDist = dRight;
    }
    return best;
  };

  interface FaceClaim {
    side: Side;
    edgeId: string;
  }
  const faceClaims = new Map<string, FaceClaim[]>();
  const addFaceClaim = (nodeId: string, side: Side, edgeId: string) => {
    if (!faceClaims.has(nodeId)) {
      faceClaims.set(nodeId, []);
    }
    faceClaims.get(nodeId)!.push({ side, edgeId });
  };
  for (const e of edges) {
    if ((e as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (e as { points?: { x: number; y: number }[] }).points ?? [];
    if (pts.length < 1) {
      continue;
    }
    const eId = (e as { id?: string }).id ?? '';
    const startId = (e as { start?: string }).start;
    const endId = (e as { end?: string }).end;
    if (startId) {
      const info = nodeInfoById.get(startId);
      if (info) {
        addFaceClaim(startId, nearestSideOfRect(pts[0], info), eId);
      }
    }
    if (endId) {
      const info = nodeInfoById.get(endId);
      if (info) {
        addFaceClaim(endId, nearestSideOfRect(pts[pts.length - 1], info), eId);
      }
    }
  }

  const faceIsClaimed = (nodeId: string, side: Side, ignoreEdgeId: string): boolean => {
    const claims = faceClaims.get(nodeId);
    if (!claims) {
      return false;
    }
    for (const c of claims) {
      if (c.edgeId === ignoreEdgeId) {
        continue;
      }
      if (c.side === side) {
        return true;
      }
    }
    return false;
  };

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points as { x: number; y: number }[] | undefined;
    if (!pts || pts.length < 2) {
      continue;
    }
    const currentBends = countBends(pts);
    if (currentBends < BEND_THRESHOLD) {
      continue;
    }
    const srcId = edge.start as string | undefined;
    const dstId = edge.end as string | undefined;
    if (!srcId || !dstId) {
      continue;
    }
    const srcInfo = nodeInfoById.get(srcId);
    const dstInfo = nodeInfoById.get(dstId);
    if (!srcInfo || !dstInfo) {
      continue;
    }
    const edgeId = (edge as { id?: string }).id ?? '';
    const currentCrossingConflicts = pathConflictCount(pts, edge, true);

    let bestPath: { x: number; y: number }[] | undefined;
    let bestCrossingConflicts = currentCrossingConflicts;
    let bestBends = currentBends;

    if (currentBends < BEND_THRESHOLD && currentCrossingConflicts === 0) {
      continue;
    }

    for (const srcSide of sides) {
      if (faceIsClaimed(srcId, srcSide, edgeId)) {
        continue;
      }
      const srcPort = portForSide(srcInfo, srcSide);
      for (const dstSide of sides) {
        if (faceIsClaimed(dstId, dstSide, edgeId)) {
          continue;
        }
        const dstPort = portForSide(dstInfo, dstSide);
        for (const path of buildOrthogonalPathCandidates(srcPort, srcSide, dstPort, dstSide)) {
          if (pathHitsNode(path, [srcId, dstId])) {
            continue;
          }

          const pathBends = countBends(path);
          if (currentCrossingConflicts > 0) {
            const pathCrossingConflicts = pathConflictCount(path, edge, true);
            if (
              pathCrossingConflicts > bestCrossingConflicts ||
              (pathCrossingConflicts === bestCrossingConflicts && pathBends >= bestBends)
            ) {
              continue;
            }
            bestCrossingConflicts = pathCrossingConflicts;
            bestBends = pathBends;
            bestPath = path;
            continue;
          }

          if (pathConflictCount(path, edge) > pathConflictCount(pts, edge)) {
            continue;
          }
          if (pathBends < bestBends) {
            bestBends = pathBends;
            bestPath = path;
          }
        }
      }
    }

    if (bestPath) {
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `simplifyDetouredEdges: rewrote ${edge.id} (${currentBends}→${bestBends} bends)`
      );
      (edge as { points: { x: number; y: number }[] }).points = bestPath;
      // Refresh face claims for this edge so downstream iterations
      // see the new attach sides. The loop mutates edges in place;
      // stale claims would let two edges both commit to the same face.
      const refreshSrc = faceClaims.get(srcId);
      if (refreshSrc) {
        faceClaims.set(
          srcId,
          refreshSrc.filter((c) => c.edgeId !== edgeId)
        );
      }
      const refreshDst = faceClaims.get(dstId);
      if (refreshDst) {
        faceClaims.set(
          dstId,
          refreshDst.filter((c) => c.edgeId !== edgeId)
        );
      }
      addFaceClaim(srcId, nearestSideOfRect(bestPath[0], srcInfo), edgeId);
      addFaceClaim(dstId, nearestSideOfRect(bestPath[bestPath.length - 1], dstInfo), edgeId);
    }
  }
}
