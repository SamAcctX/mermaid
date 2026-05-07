import type { LayoutData } from '../../../types.js';

interface LabelRect {
  nodeId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LabelEdgeFixCandidate {
  edge: any;
  label: LabelRect;
  startIdx: number;
  endIdx: number;
}

const EPS = 1e-3;

function segmentIntersectsRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  rect: LabelRect,
  epsilon: number
): boolean {
  const segMinX = Math.min(p1.x, p2.x);
  const segMaxX = Math.max(p1.x, p2.x);
  const segMinY = Math.min(p1.y, p2.y);
  const segMaxY = Math.max(p1.y, p2.y);

  const intersectX = segMaxX > rect.left + epsilon && segMinX < rect.right - epsilon;
  const intersectY = segMaxY > rect.top + epsilon && segMinY < rect.bottom - epsilon;

  return intersectX && intersectY;
}

function rerouteSubpathAroundLabel(
  candidate: LabelEdgeFixCandidate,
  epsilon: number,
  margin: number
): boolean {
  const { edge, label, startIdx, endIdx } = candidate;
  const points = edge.points as { x: number; y: number }[];
  if (!points || points.length < 2) {
    return false;
  }

  const start = points[startIdx];
  const end = points[endIdx];

  // If either endpoint is inside the label rectangle, we currently skip fixing
  // this segment to avoid creating degenerate paths. In practice, the
  // intersections we care about are where the path passes *over* another
  // label's box, not where it starts/ends inside.
  const inside = (p: { x: number; y: number }) =>
    p.x > label.left + epsilon &&
    p.x < label.right - epsilon &&
    p.y > label.top + epsilon &&
    p.y < label.bottom - epsilon;

  if (inside(start) || inside(end)) {
    return false;
  }

  // Expand the rerouted region to absorb collinear stub segments on both ends.
  //
  // Orthogonal routing (e.g. the k=1 anchor preservation in raykov.ts) can
  // leave short "stub" segments collinear with the intersecting segment. When
  // stubs are included in the rerouted region, the U-shaped detour produces a
  // V→H→V path (2 bends) instead of H→V→H→V or V→H→V→H (3 bends each).
  //
  // Example: [0](src,222)→[1](src_anchor,222)→[2](dst_anchor,222)→[3](dst,222)
  // Without expansion the reroute replaces [1]→[2] and leaves both collinear
  // stubs, yielding: H→V→H→V = 3 bends. With both-ends expansion the reroute
  // covers [0]→[3] and yields: V→H→V = 2 bends.
  //
  // Use greedy (loop) expansion so that paths with multiple consecutive collinear
  // stubs (e.g. two k=1 anchor stubs on both ends) are all absorbed, not just
  // one step at a time.
  const isHorizontalSeg = Math.abs(start.y - end.y) < EPS;
  const isVerticalSeg = Math.abs(start.x - end.x) < EPS;
  let effectiveStartIdx = startIdx;
  while (effectiveStartIdx > 0) {
    const prev = points[effectiveStartIdx - 1];
    if (isHorizontalSeg && Math.abs(prev.y - start.y) < EPS) {
      effectiveStartIdx--;
    } else if (isVerticalSeg && Math.abs(prev.x - start.x) < EPS) {
      effectiveStartIdx--;
    } else {
      break;
    }
  }
  const effectiveStart = points[effectiveStartIdx];

  let effectiveEndIdx = endIdx;
  while (effectiveEndIdx < points.length - 1) {
    const next = points[effectiveEndIdx + 1];
    if (isHorizontalSeg && Math.abs(next.y - end.y) < EPS) {
      effectiveEndIdx++;
    } else if (isVerticalSeg && Math.abs(next.x - end.x) < EPS) {
      effectiveEndIdx++;
    } else {
      break;
    }
  }

  // Staircase-aware expansion: when the intersecting horizontal segment is
  // flanked by vertical steps going in the SAME direction (monotone staircase),
  // expand the rerouting region to include both vertical steps. This lets the
  // U-shaped detour cover the full staircase, producing a 2-bend path instead
  // of a 3-bend one.
  //
  // Pattern (from-label monotone staircase, all steps going "down"):
  //   [i-1](x0,y0) →[i](x0,y_mid) →[i+1](x1,y_mid) →[i+2](x1,y_end) →[i+3](x2,y_end)
  //   The intersecting segment is [i]→[i+1] (horizontal). Greedy collinear
  //   expansion doesn't help because [i-1]→[i] and [i+1]→[i+2] are vertical
  //   (different y). But if both vertical steps go the same direction the whole
  //   staircase is monotone and can be rerouted as a single U-shape.
  if (isHorizontalSeg && effectiveStartIdx > 0 && effectiveEndIdx < points.length - 1) {
    const prevStep = points[effectiveStartIdx - 1];
    const nextStep = points[effectiveEndIdx + 1];
    const curStart = points[effectiveStartIdx];
    const curEnd = points[effectiveEndIdx];
    const prevIsVerticalStep =
      Math.abs(prevStep.x - curStart.x) < EPS && Math.abs(prevStep.y - curStart.y) > EPS;
    const nextIsVerticalStep =
      Math.abs(nextStep.x - curEnd.x) < EPS && Math.abs(nextStep.y - curEnd.y) > EPS;
    if (prevIsVerticalStep && nextIsVerticalStep) {
      const beforeDir = Math.sign(curStart.y - prevStep.y);
      const afterDir = Math.sign(nextStep.y - curEnd.y);
      if (beforeDir !== 0 && afterDir !== 0 && beforeDir === afterDir) {
        effectiveStartIdx--;
        effectiveEndIdx++;
        // Absorb any additional collinear horizontal suffix after the new end.
        while (effectiveEndIdx < points.length - 1) {
          const next = points[effectiveEndIdx + 1];
          if (Math.abs(next.y - points[effectiveEndIdx].y) < EPS) {
            effectiveEndIdx++;
          } else {
            break;
          }
        }
      }
    }
  }

  const effectiveEnd = points[effectiveEndIdx];

  const subPoints = points.slice(effectiveStartIdx, effectiveEndIdx + 1);
  const avgY =
    subPoints.reduce((sum, p) => sum + p.y, 0) / (subPoints.length > 0 ? subPoints.length : 1);
  const labelMidY = (label.top + label.bottom) / 2;

  // Try routing above or below the label, preferring the side the original
  // subpath is already closer to.
  const preferredAbove = avgY <= labelMidY;
  const sides: ('above' | 'below')[] = preferredAbove ? ['above', 'below'] : ['below', 'above'];

  for (const side of sides) {
    const safeY = side === 'above' ? label.top - margin : label.bottom + margin;

    const newSub: { x: number; y: number }[] = [];
    newSub.push({ x: effectiveStart.x, y: effectiveStart.y });

    if (Math.abs(effectiveStart.y - safeY) > EPS) {
      newSub.push({ x: effectiveStart.x, y: safeY });
    }

    if (Math.abs(effectiveStart.x - effectiveEnd.x) > EPS) {
      newSub.push({ x: effectiveEnd.x, y: safeY });
    }

    if (Math.abs(effectiveEnd.y - safeY) > EPS || newSub.length === 1) {
      newSub.push({ x: effectiveEnd.x, y: effectiveEnd.y });
    } else {
      // If the last generated point already matches the end Y, just overwrite
      // its X so we end exactly at `effectiveEnd`.
      newSub[newSub.length - 1] = { x: effectiveEnd.x, y: effectiveEnd.y };
    }

    // Check that the new subpath does not intersect the label.
    let ok = true;
    for (let i = 0; i < newSub.length - 1; i++) {
      if (segmentIntersectsRect(newSub[i], newSub[i + 1], label, epsilon)) {
        ok = false;
        break;
      }
    }

    if (!ok) {
      continue;
    }

    // Splice the new subpath into the edge, replacing the original
    // [effectiveStartIdx..effectiveEndIdx] range.
    const prefix = points.slice(0, effectiveStartIdx);
    const suffix = points.slice(effectiveEndIdx + 1);

    const merged = [...prefix, ...newSub, ...suffix];

    // Remove duplicate consecutive points.
    const filtered: { x: number; y: number }[] = [];
    for (const p of merged) {
      const last = filtered[filtered.length - 1];
      if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
        filtered.push(p);
      }
    }

    edge.points = filtered;

    return true;
  }

  return false;
}

export function resolveEdgeNodeIntersections(layout: LayoutData): void {
  const nodes = layout.nodes ?? [];
  const edges = (layout.edges ?? []) as any[];

  if (!edges.length || !nodes.length) {
    return;
  }

  // Strategy 1: label positions are not decided yet (they are anchored to
  // the routed polyline after this pass), so edge-label nodes are not
  // obstacles here. Only real non-group nodes participate.
  const nodeRects: LabelRect[] = nodes
    .filter((n: any) => !n.isGroup && !n.isEdgeLabel)
    .map((n: any) => {
      const cx = n.x ?? 0;
      const cy = n.y ?? 0;
      const w = n.width ?? 0;
      const h = n.height ?? 0;
      return {
        nodeId: n.id as string,
        left: cx - w / 2,
        right: cx + w / 2,
        top: cy - h / 2,
        bottom: cy + h / 2,
      };
    });

  const epsilon = 2;
  const margin = 6;
  const maxGlobalIterations = 3;

  for (let globalIter = 0; globalIter < maxGlobalIterations; globalIter++) {
    let fixedAny = false;

    for (const edge of edges) {
      if (edge.isLayoutOnly) {
        continue;
      }

      const edgeStart = edge.start as string | undefined;
      const edgeEnd = edge.end as string | undefined;

      // Up to 4 per-edge fix passes
      for (let iter = 0; iter < 4; iter++) {
        const points = edge.points as { x: number; y: number }[] | undefined;
        if (!points || points.length < 2) {
          break;
        }
        let candidate: LabelEdgeFixCandidate | undefined;

        for (const rect of nodeRects) {
          // Skip the edge's own endpoints (labels are already excluded from nodeRects)
          if (rect.nodeId === edgeStart || rect.nodeId === edgeEnd) {
            continue;
          }

          const intersectingSegIndices: number[] = [];
          for (let i = 0; i < points.length - 1; i++) {
            if (segmentIntersectsRect(points[i], points[i + 1], rect, epsilon)) {
              intersectingSegIndices.push(i);
            }
          }

          if (intersectingSegIndices.length > 0) {
            const startIdx = Math.min(...intersectingSegIndices);
            const endIdx = Math.max(...intersectingSegIndices) + 1;
            candidate = { edge, label: rect, startIdx, endIdx };
            break;
          }
        }

        if (!candidate) {
          break;
        }

        const fixed = rerouteSubpathAroundLabel(candidate, epsilon, margin);
        if (fixed) {
          fixedAny = true;
        } else {
          break;
        }
      }
    }

    if (!fixedAny) {
      break;
    }
  }
}
