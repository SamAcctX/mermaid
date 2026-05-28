// cspell:ignore Hegemann Kandinsky Siebenhaller
import type { Edge, Node } from '../../../types.js';
import { orthogonalSegmentsCross } from './geometry.js';

const EPS = 1e-6;
const MIN_PORT_SPACING = 8;
const PORT_SHIFT = MIN_PORT_SPACING / 2;
const LABEL_CLEARANCE_BUFFER = 3;

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

interface LabelDim {
  w: number;
  h: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Iter 12 — co-route sibling straight-line rescue.
 *
 * Fires only on the narrow "4-point U-detour around a collinear blocker
 * where the obvious straight line is geometrically clear" shape. For each
 * eligible edge, shifts the source and destination attach points by
 * MIN_PORT_SPACING/2 along the shared face and replaces the polyline
 * with a 2-point straight line. The shift direction is chosen by trying
 * both +delta and -delta and picking whichever doesn't introduce a new
 * edge crossing or leave the node's face span.
 *
 * Paper backing: Hegemann & Wolff "On the smoothing of orthogonal
 * connector layouts" (NotebookLM src b65b3d45) §4.2 / Fig. 11 —
 * joint-feasibility via port distribution rather than face exclusion.
 * Mermaid-specific narrowing: we only rescue the exact 4-point shape to
 * minimize blast radius.
 */
export function straightenCollinearSiblingDetours(edges: Edge[], nodes: Node[]): void {
  const nodeInfoById = new Map<string, NodeInfo>();
  const realNodeRects: { id: string; rect: RectLite }[] = [];
  // Side table of label-node dimensions so we can grow the rescue delta
  // far enough to clear a label sitting on the sibling line.
  const labelDimById = new Map<string, LabelDim>();
  for (const n of nodes) {
    const id = n.id;
    if (n.isGroup) {
      continue;
    }
    if (n.isEdgeLabel) {
      labelDimById.set(id, {
        w: n.width ?? 0,
        h: n.height ?? 0,
      });
      continue;
    }
    const cx = n.x ?? 0;
    const cy = n.y ?? 0;
    const w = n.width ?? 0;
    const h = n.height ?? 0;
    if (w <= 0 || h <= 0) {
      continue;
    }
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    nodeInfoById.set(id, { id, cx, cy, rect });
    realNodeRects.push({ id, rect });
  }

  // For a given (this-edge, axis) pair, find the largest label half-extent
  // among any edge sharing the same node pair (anti-parallel siblings) plus
  // this edge's own label. Used to grow the rescue shift past the label so
  // anchorLabelsToPolyline can place the label clear of the sibling.
  const labelClearanceFor = (
    thisEdge: Edge,
    thisSrcId: string,
    thisDstId: string,
    axis: 'x' | 'y'
  ): number => {
    const targetPair = pairKey(thisSrcId, thisDstId);
    let maxHalf = 0;
    const consider = (labelId: string | undefined) => {
      if (!labelId) {
        return;
      }
      const dim = labelDimById.get(labelId);
      if (!dim) {
        return;
      }
      const half = axis === 'x' ? dim.w / 2 : dim.h / 2;
      if (half > maxHalf) {
        maxHalf = half;
      }
    };
    consider(thisEdge.labelNodeId);
    for (const other of edges) {
      if (other === thisEdge) {
        continue;
      }
      if (other.isLayoutOnly) {
        continue;
      }
      const oSrc = other.start;
      const oDst = other.end;
      if (!oSrc || !oDst) {
        continue;
      }
      if (pairKey(oSrc, oDst) !== targetPair) {
        continue;
      }
      consider(other.labelNodeId);
    }
    return maxHalf > 0 ? maxHalf + LABEL_CLEARANCE_BUFFER : 0;
  };

  const segmentHitsNode = (a: PointLite, b: PointLite, excludeIds: string[]): boolean => {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    for (const n of realNodeRects) {
      if (excludeIds.includes(n.id)) {
        continue;
      }
      if (
        maxX > n.rect.left + 1 &&
        minX < n.rect.right - 1 &&
        maxY > n.rect.top + 1 &&
        minY < n.rect.bottom - 1
      ) {
        return true;
      }
    }
    return false;
  };

  for (const edge of edges) {
    if (edge.isLayoutOnly) {
      continue;
    }
    const pts = edge.points;
    if (!pts || pts.length !== 4) {
      continue;
    }
    const [p0, p1, p2, p3] = pts;
    const seg01H = Math.abs(p0.y - p1.y) < EPS && Math.abs(p0.x - p1.x) > EPS;
    const seg12V = Math.abs(p1.x - p2.x) < EPS && Math.abs(p1.y - p2.y) > EPS;
    const seg23H = Math.abs(p2.y - p3.y) < EPS && Math.abs(p2.x - p3.x) > EPS;
    const seg01V = Math.abs(p0.x - p1.x) < EPS && Math.abs(p0.y - p1.y) > EPS;
    const seg12H = Math.abs(p1.y - p2.y) < EPS && Math.abs(p1.x - p2.x) > EPS;
    const seg23V = Math.abs(p2.x - p3.x) < EPS && Math.abs(p2.y - p3.y) > EPS;
    const isHVH = seg01H && seg12V && seg23H;
    const isVHV = seg01V && seg12H && seg23V;
    if (!isHVH && !isVHV) {
      continue;
    }

    const srcId = edge.start;
    const dstId = edge.end;
    if (!srcId || !dstId) {
      continue;
    }
    const srcInfo = nodeInfoById.get(srcId);
    const dstInfo = nodeInfoById.get(dstId);
    if (!srcInfo || !dstInfo) {
      continue;
    }

    const collinearX = Math.abs(srcInfo.cx - dstInfo.cx) < EPS;
    const collinearY = Math.abs(srcInfo.cy - dstInfo.cy) < EPS;
    if (collinearX === collinearY) {
      continue;
    }

    let targetSrc: PointLite;
    let targetDst: PointLite;
    if (collinearX) {
      const dstBelow = dstInfo.cy > srcInfo.cy;
      targetSrc = { x: srcInfo.cx, y: dstBelow ? srcInfo.rect.bottom : srcInfo.rect.top };
      targetDst = { x: dstInfo.cx, y: dstBelow ? dstInfo.rect.top : dstInfo.rect.bottom };
    } else {
      const dstEast = dstInfo.cx > srcInfo.cx;
      targetSrc = { x: dstEast ? srcInfo.rect.right : srcInfo.rect.left, y: srcInfo.cy };
      targetDst = { x: dstEast ? dstInfo.rect.left : dstInfo.rect.right, y: dstInfo.cy };
    }

    if (segmentHitsNode(targetSrc, targetDst, [srcId, dstId])) {
      continue;
    }

    // The rescue moves the line perpendicular to its own direction: a
    // horizontal rescued line shifts in y (so the label HEIGHT determines
    // clearance), a vertical one shifts in x (label WIDTH). collinearX
    // means the rescued line is vertical (nodes share a column).
    //
    // When the edge (or an anti-parallel sibling) carries a label, the
    // small PORT_SHIFT would leave the rescued straight inside the label's
    // bbox — the label would visually overlap this line. We grow the
    // shift to clear the label rect. If the wider shift won't fit on the
    // node face, the bounds check below rejects it and we fall through
    // without rescuing, which keeps the original 4-point detour — also
    // correct, since the detour routes far away from the label.
    const shiftAxis: 'x' | 'y' = collinearX ? 'x' : 'y';
    const labelShift = labelClearanceFor(edge, srcId, dstId, shiftAxis);
    const effectiveShift = labelShift > PORT_SHIFT ? labelShift : PORT_SHIFT;
    const deltas = [0, effectiveShift, -effectiveShift];
    for (const delta of deltas) {
      const shiftedSrc = { ...targetSrc };
      const shiftedDst = { ...targetDst };
      if (collinearX) {
        shiftedSrc.x += delta;
        shiftedDst.x += delta;
        if (shiftedSrc.x <= srcInfo.rect.left || shiftedSrc.x >= srcInfo.rect.right) {
          continue;
        }
        if (shiftedDst.x <= dstInfo.rect.left || shiftedDst.x >= dstInfo.rect.right) {
          continue;
        }
      } else {
        shiftedSrc.y += delta;
        shiftedDst.y += delta;
        if (shiftedSrc.y <= srcInfo.rect.top || shiftedSrc.y >= srcInfo.rect.bottom) {
          continue;
        }
        if (shiftedDst.y <= dstInfo.rect.top || shiftedDst.y >= dstInfo.rect.bottom) {
          continue;
        }
      }

      if (segmentHitsNode(shiftedSrc, shiftedDst, [srcId, dstId])) {
        continue;
      }

      const shiftedIsVertical = Math.abs(shiftedSrc.x - shiftedDst.x) < EPS;
      const shiftedMinX = Math.min(shiftedSrc.x, shiftedDst.x);
      const shiftedMaxX = Math.max(shiftedSrc.x, shiftedDst.x);
      const shiftedMinY = Math.min(shiftedSrc.y, shiftedDst.y);
      const shiftedMaxY = Math.max(shiftedSrc.y, shiftedDst.y);
      let introducesCrossing = false;
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if (other.isLayoutOnly) {
          continue;
        }
        const opts = other.points;
        if (!opts || opts.length < 2) {
          continue;
        }
        for (let i = 0; i < opts.length - 1; i++) {
          if (orthogonalSegmentsCross(shiftedSrc, shiftedDst, opts[i], opts[i + 1], EPS)) {
            introducesCrossing = true;
            break;
          }
          const oa = opts[i];
          const ob = opts[i + 1];
          const otherIsVertical = Math.abs(oa.x - ob.x) < EPS;
          const otherIsHorizontal = Math.abs(oa.y - ob.y) < EPS;
          if (shiftedIsVertical && otherIsVertical && Math.abs(oa.x - shiftedSrc.x) < EPS) {
            const oMinY = Math.min(oa.y, ob.y);
            const oMaxY = Math.max(oa.y, ob.y);
            if (oMaxY > shiftedMinY + EPS && oMinY < shiftedMaxY - EPS) {
              introducesCrossing = true;
              break;
            }
          } else if (
            !shiftedIsVertical &&
            otherIsHorizontal &&
            Math.abs(oa.y - shiftedSrc.y) < EPS
          ) {
            const oMinX = Math.min(oa.x, ob.x);
            const oMaxX = Math.max(oa.x, ob.x);
            if (oMaxX > shiftedMinX + EPS && oMinX < shiftedMaxX - EPS) {
              introducesCrossing = true;
              break;
            }
          }
        }
        if (introducesCrossing) {
          break;
        }
      }
      if (introducesCrossing) {
        continue;
      }

      edge.points = [shiftedSrc, shiftedDst];
      break;
    }
  }
}
