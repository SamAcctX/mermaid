// cspell:ignore Battista Eades Eiglsperger Hegemann Kandinsky segs Siebenhaller Tamassia Tollis Fößmeier
import { log } from '../../../../logger.js';

const SWIMLANE_DIR_LOG_PREFIX = 'SWIMLANE_DIR';

/**
 * Iter 17 — port-swap a 4-point H-V-H / V-H-V edge to a 3-point L-shape
 * when the current src port is "straight-through" (parallel to the
 * incoming edge) but a perpendicular src face permits a one-bend reach
 * to the existing dst port.
 *
 * Motivating case (user report 2026-04-16, 8-query-process-2.mmd):
 *   L_A2_E_0 currently:
 *     (A2.east=355.2, 0) → (gutter=402.3, 0)
 *       → (402.3, 213.4) → (E.west=844.1, 213.4)
 *   i.e. exits A2 on the east face (parallel to incoming A→A2), bends
 *   south, bends east — 2 interior bends. The south face of A2 points
 *   directly toward E's lane, so exiting south gives a 1-bend L-shape:
 *     (A2.south=cx±δ, 69.3) → (cx±δ, 213.4) → (E.west=844.1, 213.4)
 *   Saves one bend.
 *
 * Paper backing:
 *   - Tamassia's bend-minimization flow (1987, and
 *     Di Battista–Eades–Tamassia–Tollis §5): port/face assignment is a
 *     free variable and the optimum switches faces whenever it saves a
 *     bend.
 *   - Kandinsky port distribution (Fößmeier–Kaufmann 1995;
 *     Siebenhaller dissertation §2.3–§2.5): decision-diamond outgoing
 *     edges favor distinct perpendicular faces.
 *   - Siebenhaller §3.3 "Port Assignment" + §4.1 "Bend optimization":
 *     local port-swap accepted iff (a) bends strictly decrease, (b) no
 *     new crossings, (c) Kandinsky face-capacity preserved.
 *   - Hegemann–Wolff §4.2 joint-feasibility (paper src `b65b3d45`):
 *     the formal crossings + capacity guard set.
 *
 * Shape handled (src, dst NOT collinear):
 *   H-V-H:  p0 → p1 (horiz) → p2 (vert) → p3 (horiz);
 *           src face E/W (parallel to seg01); swap to N/S.
 *   V-H-V:  p0 → p1 (vert)  → p2 (horiz) → p3 (vert);
 *           src face N/S (parallel to seg01); swap to E/W.
 *
 * Rewrite (H-V-H):
 *   new_src_port = (src.cx + δ, dst-below ? src.bottom : src.top)
 *   new_polyline = [ new_src_port, (src.cx + δ, p3.y), p3 ]
 * (V-H-V symmetric across axes.)
 *
 * Safety (the six guards from the iter-17 plan):
 *   1. Strict bend-count decrease   — enforced by the 4-point → 3-point
 *                                     rewrite.
 *   2. No new edge-edge crossings    — segmentsCrossOrth vs every other
 *                                     non-self segment.
 *   3. No new edge-node collisions   — segmentHitsNode (both new segs,
 *                                     excluding src for seg-1 and dst
 *                                     for seg-2).
 *   4. Kandinsky face capacity       — port-offset delta chosen from
 *                                     0, ±PORT_SHIFT, ±2·PORT_SHIFT;
 *                                     each candidate must lie strictly
 *                                     within the src face span; the
 *                                     collinear-axis overlap check
 *                                     (shared axis + overlapping range)
 *                                     rejects δ values that collide
 *                                     with an existing sibling port.
 *   5. No label-rect overlap on new  — re-done by anchorLabelsToPolyline
 *      segments                        which runs after this pass.
 *   6. Monotonic on fixture suite    — enforced externally by the DDLT
 *                                     contract (no spec's totalBends or
 *                                     crossings may increase).
 *
 * Distinct from `coRouteSiblingsOnSharedFace` (iter 12) which handles
 * the COLLINEAR case (4-point → 2-point straight). This pass handles
 * the non-collinear case (4-point → 3-point L). The two are disjoint
 * by the collinearX === collinearY guard: coRoute runs first and
 * converts collinear edges to 2-point straights which this pass then
 * skips by shape filter.
 *
 * Distinct from Eiglsperger bend-stretching (cited in iter 16
 * collapseShortTerminalStub): that pass requires the first and last
 * direction to be preserved; this pass explicitly CHANGES the first
 * direction — the whole point.
 */
export function portSwapToLShape(edges: any[], nodes: any[]): void {
  const EPS = 1e-6;
  // δ_s — the Kandinsky port-spacing constant (Fößmeier–Kaufmann 1995;
  // Siebenhaller dissertation §6.1.2.2). When this pass places a second
  // edge on a face already occupied by a sibling centered at delta=0,
  // the canonical pairing is (0, ±δ_s) — full δ_s separation between
  // port centers, not δ_s/2. `coRouteSiblingsOnSharedFace` uses δ_s/2
  // because that pass shifts BOTH members of a collinear pair
  // symmetrically (to ±δ_s/2, separation δ_s); this pass shifts only
  // the single edge being swapped, so it must move the full δ_s to
  // preserve the same canonical spacing.
  const MIN_PORT_SPACING = 8;
  const PORT_SHIFT = MIN_PORT_SPACING;

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

  const nodeInfoById = new Map<string, NodeInfo>();
  const realNodeRects: { id: string; rect: RectLite }[] = [];
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
    const id = String((n as { id?: string }).id ?? '');
    const rect: RectLite = {
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    };
    nodeInfoById.set(id, { id, cx, cy, rect });
    realNodeRects.push({ id, rect });
  }

  const segmentHitsNode = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    excludeIds: string[]
  ): boolean => {
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

  // Axis-aligned segment-crossing detector (perpendicular crossings only,
  // T-intersections count), same semantics as scoreLayout.segmentsCross
  // and as the helper embedded in `coRouteSiblingsOnSharedFace`.
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
    const ix = vX;
    const iy = hY;
    const TOL = 1e-6;
    const matchesHorizEndpoint =
      (Math.abs(ix - horiz.a.x) < TOL && Math.abs(iy - horiz.a.y) < TOL) ||
      (Math.abs(ix - horiz.b.x) < TOL && Math.abs(iy - horiz.b.y) < TOL);
    const matchesVertEndpoint =
      (Math.abs(ix - vert.a.x) < TOL && Math.abs(iy - vert.a.y) < TOL) ||
      (Math.abs(ix - vert.b.x) < TOL && Math.abs(iy - vert.b.y) < TOL);
    if (matchesHorizEndpoint && matchesVertEndpoint) {
      return false;
    }
    return true;
  };

  // Collinear-axis overlap: two segments on the same axis at the same
  // coordinate with overlapping spans. Not flagged by segmentsCrossOrth
  // (perpendicular-only) but IS an edge overlap for scoreLayout and for
  // Kandinsky face-capacity (two ports at the same offset on the same
  // face).
  const segmentsOverlapAxis = (
    a1: { x: number; y: number },
    b1: { x: number; y: number },
    a2: { x: number; y: number },
    b2: { x: number; y: number }
  ): boolean => {
    const s1H = Math.abs(a1.y - b1.y) < EPS;
    const s1V = Math.abs(a1.x - b1.x) < EPS;
    const s2H = Math.abs(a2.y - b2.y) < EPS;
    const s2V = Math.abs(a2.x - b2.x) < EPS;
    if (s1V && s2V && Math.abs(a1.x - a2.x) < EPS) {
      const m1 = Math.min(a1.y, b1.y);
      const M1 = Math.max(a1.y, b1.y);
      const m2 = Math.min(a2.y, b2.y);
      const M2 = Math.max(a2.y, b2.y);
      return M1 > m2 + EPS && M2 > m1 + EPS;
    }
    if (s1H && s2H && Math.abs(a1.y - a2.y) < EPS) {
      const m1 = Math.min(a1.x, b1.x);
      const M1 = Math.max(a1.x, b1.x);
      const m2 = Math.min(a2.x, b2.x);
      const M2 = Math.max(a2.x, b2.x);
      return M1 > m2 + EPS && M2 > m1 + EPS;
    }
    return false;
  };

  for (const edge of edges) {
    if ((edge as { isLayoutOnly?: boolean }).isLayoutOnly) {
      continue;
    }
    const pts = (edge as { points?: { x: number; y: number }[] }).points;
    if (!pts || pts.length < 4) {
      continue;
    }

    // Dedupe consecutive identical points (raykov / endpoint-clip can
    // produce duplicates). We operate on the DEDUPED polyline but write
    // back without duplicates too — the rendering-handoff pass later
    // re-duplicates endpoints for the intersect-rect guard.
    const deduped: { x: number; y: number }[] = [];
    for (const p of pts) {
      const last = deduped.length > 0 ? deduped[deduped.length - 1] : undefined;
      if (!last || Math.abs(p.x - last.x) > EPS || Math.abs(p.y - last.y) > EPS) {
        deduped.push(p);
      }
    }
    if (deduped.length !== 4) {
      continue;
    }

    const [p0, p1, p2, p3] = deduped;
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

    const srcId = (edge as { start?: string }).start;
    const dstId = (edge as { end?: string }).end;
    const edgeId = String((edge as { id?: string }).id ?? '');
    if (!srcId || !dstId) {
      continue;
    }
    const srcInfo = nodeInfoById.get(srcId);
    const dstInfo = nodeInfoById.get(dstId);
    if (!srcInfo || !dstInfo) {
      continue;
    }

    // Skip collinear src/dst — coRouteSiblingsOnSharedFace handles those.
    const collinearX = Math.abs(srcInfo.cx - dstInfo.cx) < EPS;
    const collinearY = Math.abs(srcInfo.cy - dstInfo.cy) < EPS;
    if (collinearX || collinearY) {
      continue;
    }

    // Build candidate new polyline.
    // H-V-H: swap src E/W face → N/S face. Preserve dst port (p3).
    //   new p0 = (src.cx + δ, dst-below ? src.bottom : src.top)
    //   new p1 = (src.cx + δ, p3.y)
    //   new p2 = p3
    // V-H-V symmetric.
    let newPts: { x: number; y: number }[] | undefined;
    const srcRect = srcInfo.rect;

    const tryDeltas = [0, PORT_SHIFT, -PORT_SHIFT, 2 * PORT_SHIFT, -2 * PORT_SHIFT];

    for (const delta of tryDeltas) {
      let np0: { x: number; y: number };
      let np1: { x: number; y: number };
      let np2: { x: number; y: number };

      if (isHVH) {
        const dstBelow = dstInfo.cy > srcInfo.cy;
        const newSrcY = dstBelow ? srcRect.bottom : srcRect.top;
        const newSrcX = srcInfo.cx + delta;
        // Must lie strictly within src face span (exclusive of corners).
        if (newSrcX <= srcRect.left + EPS || newSrcX >= srcRect.right - EPS) {
          continue;
        }
        np0 = { x: newSrcX, y: newSrcY };
        np1 = { x: newSrcX, y: p3.y };
        np2 = { x: p3.x, y: p3.y };
      } else {
        // isVHV
        const dstEast = dstInfo.cx > srcInfo.cx;
        const newSrcX = dstEast ? srcRect.right : srcRect.left;
        const newSrcY = srcInfo.cy + delta;
        if (newSrcY <= srcRect.top + EPS || newSrcY >= srcRect.bottom - EPS) {
          continue;
        }
        np0 = { x: newSrcX, y: newSrcY };
        np1 = { x: p3.x, y: newSrcY };
        np2 = { x: p3.x, y: p3.y };
      }

      // Degenerate: if np1 === np2, the "L" collapses to a straight line.
      // Accept it (even better than a 1-bend L), but keep it as 2 pts.
      const firstSegDegenerate = Math.abs(np0.x - np1.x) < EPS && Math.abs(np0.y - np1.y) < EPS;
      const secondSegDegenerate = Math.abs(np1.x - np2.x) < EPS && Math.abs(np1.y - np2.y) < EPS;
      if (firstSegDegenerate && secondSegDegenerate) {
        continue;
      }

      // Guard 3: no edge-node collisions. Seg 1 may touch src; seg 2 may
      // touch dst. Excluding those ids from the hit check.
      if (!firstSegDegenerate && segmentHitsNode(np0, np1, [srcId])) {
        continue;
      }
      if (!secondSegDegenerate && segmentHitsNode(np1, np2, [dstId])) {
        continue;
      }

      // Guard 5: label overlap is checked by anchorLabelsToPolyline which
      // runs AFTER this pass and re-anchors each label onto its owning
      // edge's polyline (with along-segment parametric retry from iter
      // 14). At this pipeline stage labels still sit at stale Sugiyama
      // positions so a label-rect check here would reject against
      // positions that will imminently be moved. If anchorLabelsToPolyline
      // cannot find any legal anchor on the rewritten polyline,
      // validateLayout's label-on-edge-segment invariant will flag it at
      // DDLT level 1. Deliberately not checked here.

      // Guards 2 + 4: check every other edge's every segment for a
      // perpendicular crossing or a collinear-axis overlap with EITHER
      // of the new segments.
      let conflict = false;
      for (const other of edges) {
        if (other === edge) {
          continue;
        }
        if ((other as { isLayoutOnly?: boolean }).isLayoutOnly) {
          continue;
        }
        const opts = (other as { points?: { x: number; y: number }[] }).points;
        if (!opts || opts.length < 2) {
          continue;
        }
        for (let i = 0; i < opts.length - 1; i++) {
          const oa = opts[i];
          const ob = opts[i + 1];
          if (Math.abs(oa.x - ob.x) < EPS && Math.abs(oa.y - ob.y) < EPS) {
            continue; // zero-length segment of the other edge
          }
          if (!firstSegDegenerate) {
            if (segmentsCrossOrth(np0, np1, oa, ob)) {
              conflict = true;
              break;
            }
            if (segmentsOverlapAxis(np0, np1, oa, ob)) {
              conflict = true;
              break;
            }
          }
          if (!secondSegDegenerate) {
            if (segmentsCrossOrth(np1, np2, oa, ob)) {
              conflict = true;
              break;
            }
            if (segmentsOverlapAxis(np1, np2, oa, ob)) {
              conflict = true;
              break;
            }
          }
        }
        if (conflict) {
          break;
        }
      }
      if (conflict) {
        continue;
      }

      // All guards pass. Build the final polyline.
      if (firstSegDegenerate) {
        newPts = [np1, np2];
      } else if (secondSegDegenerate) {
        newPts = [np0, np1];
      } else {
        newPts = [np0, np1, np2];
      }
      log.debug(
        SWIMLANE_DIR_LOG_PREFIX,
        `portSwapToLShape: swapped ${edgeId} src port → ${isHVH ? 'N/S' : 'E/W'} face (delta=${delta}); bends ${deduped.length - 2} → ${newPts.length - 2}`
      );
      break;
    }

    if (newPts) {
      (edge as { points?: { x: number; y: number }[] }).points = newPts;
    }
  }
}
