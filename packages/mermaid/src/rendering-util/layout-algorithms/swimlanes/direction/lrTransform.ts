import type { LayoutData } from '../../../types.js';

type LayoutNode = NonNullable<LayoutData['nodes']>[number] & { swimlaneContentTop?: number };
type Direction = 'LR' | 'RL';

function buildNodeMap(nodes: LayoutNode[]): Map<string, LayoutNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function resolveTopLevelGroupId(
  node: LayoutNode,
  nodeById: Map<string, LayoutNode>
): string | null {
  let parentId = node.parentId;
  let topLevelGroupId: string | null = null;
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent?.isGroup) {
      break;
    }
    topLevelGroupId = parent.id;
    parentId = parent.parentId;
  }
  return topLevelGroupId;
}

function groupDepth(group: LayoutNode, nodeById: Map<string, LayoutNode>): number {
  let depth = 0;
  let parentId = group.parentId;
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent?.isGroup) {
      break;
    }
    depth++;
    parentId = parent.parentId;
  }
  return depth;
}

function boundsForChildren(
  children: LayoutNode[]
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const child of children) {
    const cx = child.x;
    const cy = child.y;
    if (typeof cx !== 'number' || typeof cy !== 'number') {
      continue;
    }
    const w = child.width ?? 0;
    const h = child.height ?? 0;
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
  }
  if (minX === Infinity || minY === Infinity) {
    return null;
  }
  return { minX, maxX, minY, maxY };
}

function applyGroupBounds(
  group: LayoutNode,
  bounds: NonNullable<ReturnType<typeof boundsForChildren>>
) {
  const pad = group.padding ?? 20;
  group.x = (bounds.minX + bounds.maxX) / 2;
  group.y = (bounds.minY + bounds.maxY) / 2;
  group.width = Math.max(0, bounds.maxX - bounds.minX) + pad;
  group.height = Math.max(0, bounds.maxY - bounds.minY) + pad;
}

function recomputeNestedGroupBounds(nodes: LayoutNode[]): void {
  const nodeById = buildNodeMap(nodes);
  const groupsByDepth = nodes
    .filter((node) => node.isGroup && node.parentId)
    .sort((a, b) => groupDepth(b, nodeById) - groupDepth(a, nodeById));

  for (const group of groupsByDepth) {
    const children = nodes.filter((node) => node.parentId === group.id);
    const bounds = boundsForChildren(children);
    if (bounds) {
      applyGroupBounds(group, bounds);
    }
  }
}

function mirrorX(layout: LayoutData): void {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
  const edges = layout.edges ?? [];
  const contentNodes = nodes.filter((node) => !node.isGroup);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const node of contentNodes) {
    const x = node.x;
    if (typeof x !== 'number') {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return;
  }
  const mirror = (x: number) => minX + maxX - x;
  for (const node of nodes) {
    if (typeof node.x === 'number') {
      node.x = mirror(node.x);
    }
  }
  for (const edge of edges) {
    for (const point of edge.points ?? []) {
      point.x = mirror(point.x);
    }
  }
}

export function applyBtDirectionTransform(layout: LayoutData): boolean {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
  const edges = layout.edges ?? [];
  const contentNodes = nodes.filter((node) => !node.isGroup);
  if (contentNodes.length === 0) {
    return true;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of contentNodes) {
    const y = node.y;
    if (typeof y !== 'number') {
      continue;
    }
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return false;
  }

  const mirror = (y: number) => minY + maxY - y;
  for (const node of nodes) {
    if (typeof node.y === 'number') {
      node.y = mirror(node.y);
    }
  }
  for (const edge of edges) {
    for (const point of edge.points ?? []) {
      point.y = mirror(point.y);
    }
  }

  return true;
}

export function applyLrDirectionTransform(
  layout: LayoutData,
  direction: Direction = 'LR'
): boolean {
  const nodes = (layout.nodes ?? []) as LayoutNode[];
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

  for (const n of contentNodes) {
    const x0 = n.x ?? 0;
    const y0 = n.y ?? 0;
    const newX = (y0 - minY) * horizontalScaleFactor + titleBandOffset;
    const newY = x0 - minX;

    n.x = newX;
    n.y = newY;
  }

  for (const e of edges) {
    if (!e.points) {
      continue;
    }
    for (const p of e.points) {
      const x0 = p.x;
      const y0 = p.y;
      const newX = (y0 - minY) * horizontalScaleFactor + titleBandOffset;
      const newY = x0 - minX;
      p.x = newX;
      p.y = newY;
    }
  }

  recomputeNestedGroupBounds(nodes);

  const laneNodes = nodes.filter((n) => n.isGroup && !n.parentId);
  if (laneNodes.length === 0) {
    if (direction === 'RL') {
      mirrorX(layout);
    }
    return true;
  }

  const nodeById = buildNodeMap(nodes);
  const childrenByLane = new Map<string, LayoutNode[]>();
  let globalMinXChild = Infinity;
  let globalMaxXChild = -Infinity;

  for (const n of nodes) {
    if (n.isGroup) {
      continue;
    }
    const laneId = resolveTopLevelGroupId(n, nodeById);
    if (!laneId) {
      continue;
    }
    const bucket = childrenByLane.get(laneId) ?? [];
    bucket.push(n);
    childrenByLane.set(laneId, bucket);

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
  for (const lane of laneNodes) {
    const pad = lane.padding ?? 0;
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
    lane: LayoutNode;
    contentTop: number;
    contentBottom: number;
    centerY: number;
  }[] = [];

  for (const lane of laneNodes) {
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

  if (direction === 'RL') {
    mirrorX(layout);
  }

  return true;
}
