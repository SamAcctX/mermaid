import type { LayoutData } from '../../../types.js';
import { log } from '../../../../logger.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';

export function applyLrDirectionTransform(layout: LayoutData): boolean {
  const nodes = layout.nodes ?? [];
  const edges = layout.edges ?? [];
  const contentNodes = nodes.filter((n) => !n.isGroup);

  let minX = Infinity;
  let minY = Infinity;
  for (const n of contentNodes) {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    if (x0 < minX) {
      minX = x0;
    }
    if (y0 < minY) {
      minY = y0;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return false;
  }

  const titleBandOffset = 36;

  let totalWidth = 0;
  let totalHeight = 0;
  for (const n of contentNodes) {
    totalWidth += n.width ?? 0;
    totalHeight += n.height ?? 0;
  }
  const avgWidth = contentNodes.length > 0 ? totalWidth / contentNodes.length : 50;
  const avgHeight = contentNodes.length > 0 ? totalHeight / contentNodes.length : 50;
  const horizontalScaleFactor = avgHeight > 0 ? Math.max(1, avgWidth / avgHeight) : 1;

  log.debug(
    `${SWIMLANE_DIR_LOG_PREFIX} LR spacing adjustment: avgWidth=${avgWidth.toFixed(2)}, avgHeight=${avgHeight.toFixed(2)}, scaleFactor=${horizontalScaleFactor.toFixed(2)}`
  );

  for (const n of contentNodes) {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const newX = (y0 - minY) * horizontalScaleFactor + titleBandOffset;
    const newY = x0 - minX;

    if (n.id === 'J' || n.id?.toString().includes('edge-label')) {
      log.debug(
        `[SWIMLANE_DEBUG] LR transform for ${n.id}: TB(x=${x0.toFixed(1)}, y=${y0.toFixed(1)}, w=${n.width?.toFixed(1)}, h=${n.height?.toFixed(1)}) -> LR(x=${newX.toFixed(1)}, y=${newY.toFixed(1)})`
      );
    }

    n.x = newX;
    n.y = newY;
  }

  for (const e of edges) {
    if (!e.points) {
      continue;
    }
    const edgeId = (e as any).id ?? '';
    const isDebugEdge = edgeId.includes('I_K');
    if (isDebugEdge) {
      log.debug(
        `[SWIMLANE_DEBUG] LR edge transform for ${edgeId}: minX=${minX.toFixed(1)}, minY=${minY.toFixed(1)}, scaleFactor=${horizontalScaleFactor.toFixed(2)}`
      );
    }
    for (const p of e.points) {
      const x0 = p.x;
      const y0 = p.y;
      const newX = (y0 - minY) * horizontalScaleFactor + titleBandOffset;
      const newY = x0 - minX;
      if (isDebugEdge) {
        log.debug(
          `[SWIMLANE_DEBUG]   point (${x0.toFixed(1)}, ${y0.toFixed(1)}) -> (${newX.toFixed(1)}, ${newY.toFixed(1)})`
        );
      }
      p.x = newX;
      p.y = newY;
    }
  }

  const laneNodes = nodes.filter((n) => n.isGroup);
  if (laneNodes.length === 0) {
    return true;
  }

  const childrenByLane = new Map<string, any[]>();
  let globalMinXChild = Infinity;
  let globalMaxXChild = -Infinity;

  for (const n of nodes as any[]) {
    if (n.isGroup) {
      continue;
    }
    const parentId = n.parentId as string | undefined;
    if (!parentId) {
      continue;
    }
    const bucket = childrenByLane.get(parentId) ?? [];
    bucket.push(n);
    childrenByLane.set(parentId, bucket);

    const cx = n.x ?? 0;
    const cw = n.width ?? 0;
    const left = cx - cw / 2;
    const right = cx + cw / 2;
    if (left < globalMinXChild) {
      globalMinXChild = left;
    }
    if (right > globalMaxXChild) {
      globalMaxXChild = right;
    }
  }

  if (globalMinXChild === Infinity || globalMaxXChild === -Infinity) {
    return true;
  }

  let maxPad = 0;
  for (const lane of laneNodes as any[]) {
    const pad = (lane.padding as number | undefined) ?? 0;
    if (pad > maxPad) {
      maxPad = pad;
    }
  }
  const minHeaderMargin = 36;
  const fullContentWidth = Math.max(0, globalMaxXChild - globalMinXChild);
  const horizontalMargin = Math.max(maxPad, 10);
  const titleBandWidth = minHeaderMargin;
  const bodyWidth = fullContentWidth + 2 * horizontalMargin;
  const laneWidth = titleBandWidth + bodyWidth;
  const bodyCenter = (globalMinXChild + globalMaxXChild) / 2;
  const bodyLeft = bodyCenter - bodyWidth / 2;
  const laneLeft = bodyLeft - titleBandWidth;
  const centerX = laneLeft + laneWidth / 2;
  const verticalMargin = Math.max(maxPad, minHeaderMargin);

  const laneBounds: {
    lane: any;
    contentTop: number;
    contentBottom: number;
    centerY: number;
  }[] = [];

  for (const lane of laneNodes as any[]) {
    const children = childrenByLane.get(lane.id) ?? [];
    if (children.length === 0) {
      continue;
    }

    let laneMinY = Infinity;
    let laneMaxY = -Infinity;
    for (const child of children) {
      const cy = child.y ?? 0;
      const ch = child.height ?? 0;
      const top = cy - ch / 2;
      const bottom = cy + ch / 2;
      if (top < laneMinY) {
        laneMinY = top;
      }
      if (bottom > laneMaxY) {
        laneMaxY = bottom;
      }
    }

    if (laneMinY === Infinity || laneMaxY === -Infinity) {
      continue;
    }

    laneBounds.push({
      lane,
      contentTop: laneMinY,
      contentBottom: laneMaxY,
      centerY: (laneMinY + laneMaxY) / 2,
    });
  }

  laneBounds.sort((a, b) => a.centerY - b.centerY);

  for (let i = 0; i < laneBounds.length; i++) {
    const curr = laneBounds[i];
    let laneTop: number;
    let laneBottom: number;

    if (i === 0) {
      laneTop = curr.contentTop - verticalMargin;
    } else {
      const prev = laneBounds[i - 1];
      laneTop = (prev.contentBottom + curr.contentTop) / 2;
    }

    if (i === laneBounds.length - 1) {
      laneBottom = curr.contentBottom + verticalMargin;
    } else {
      const next = laneBounds[i + 1];
      laneBottom = (curr.contentBottom + next.contentTop) / 2;
    }

    const laneHeight = Math.max(0, laneBottom - laneTop);
    const centerY = (laneTop + laneBottom) / 2;

    curr.lane.x = centerX;
    curr.lane.y = centerY;
    curr.lane.width = laneWidth;
    curr.lane.height = laneHeight;
    curr.lane.swimlaneContentTop = curr.contentTop;
  }

  log.debug(SWIMLANE_DIR_LOG_PREFIX, 'Adjusted LR lane bounds after direction transform', {
    laneCount: laneNodes.length,
    globalMinXChild,
    globalMaxXChild,
    fullContentWidth,
    laneWidth,
    centerX,
    maxPad,
    minHeaderMargin,
    verticalMargin,
  });

  return true;
}
