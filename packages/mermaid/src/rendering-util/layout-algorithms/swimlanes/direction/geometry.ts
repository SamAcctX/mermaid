const EPS = 1e-3;

interface Point {
  x: number;
  y: number;
}

// Inserts orthogonal L-bends and removes consecutive duplicate points.
export function orthogonalizePolyline(pts: Point[]): Point[] {
  const cleaned: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const curr = pts[i];
    const sameX = Math.abs(prev.x - curr.x) < EPS;
    const sameY = Math.abs(prev.y - curr.y) < EPS;
    if (!sameX && !sameY) {
      const prevPrev = cleaned.length >= 2 ? cleaned[cleaned.length - 2] : undefined;
      const incomingVertical = prevPrev ? Math.abs(prevPrev.x - prev.x) < EPS : false;
      const corner = incomingVertical ? { x: prev.x, y: curr.y } : { x: curr.x, y: prev.y };
      cleaned.push(corner);
    }
    cleaned.push(curr);
  }
  const deduped: Point[] = [];
  for (const p of cleaned) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) {
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
    let changed = false;
    const out: Point[] = [];
    for (let i = 0; i < work.length; i++) {
      const prev = out[out.length - 1];
      const cur = work[i];
      const next = i + 1 < work.length ? work[i + 1] : undefined;
      if (prev && next) {
        if (Math.abs(prev.x - next.x) < EPS && Math.abs(prev.y - next.y) < EPS) {
          i++;
          changed = true;
          continue;
        }

        const sameAxisX = Math.abs(prev.x - cur.x) < EPS && Math.abs(cur.x - next.x) < EPS;
        const sameAxisY = Math.abs(prev.y - cur.y) < EPS && Math.abs(cur.y - next.y) < EPS;
        if (sameAxisX) {
          const lo = Math.min(prev.y, next.y);
          const hi = Math.max(prev.y, next.y);
          if (cur.y > lo + EPS && cur.y < hi - EPS) {
            changed = true;
            continue;
          }
        } else if (sameAxisY) {
          const lo = Math.min(prev.x, next.x);
          const hi = Math.max(prev.x, next.x);
          if (cur.x > lo + EPS && cur.x < hi - EPS) {
            changed = true;
            continue;
          }
        }
      }
      out.push(cur);
    }
    work = out;
    if (!changed) {
      break;
    }
  }
  return work;
}
