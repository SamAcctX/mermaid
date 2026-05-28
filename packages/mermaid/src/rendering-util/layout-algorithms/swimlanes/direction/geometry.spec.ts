import { describe, expect, it } from 'vitest';
import { orthogonalSegmentsCross } from './geometry.js';

const p = (x: number, y: number) => ({ x, y });

describe('swimlane direction geometry', () => {
  describe('orthogonalSegmentsCross', () => {
    it('counts strict perpendicular crossings', () => {
      expect(orthogonalSegmentsCross(p(-10, 0), p(10, 0), p(0, -10), p(0, 10))).toBe(true);
    });

    it('counts T-junctions where only one segment endpoint is involved', () => {
      expect(orthogonalSegmentsCross(p(-10, 0), p(10, 0), p(0, 0), p(0, 10))).toBe(true);
    });

    it('does not count a shared endpoint as a crossing', () => {
      expect(orthogonalSegmentsCross(p(-10, 0), p(0, 0), p(0, 0), p(0, 10))).toBe(false);
    });

    it('does not count collinear overlap or non-orthogonal segments', () => {
      expect(orthogonalSegmentsCross(p(-10, 0), p(10, 0), p(-5, 0), p(5, 0))).toBe(false);
      expect(orthogonalSegmentsCross(p(-10, 0), p(10, 10), p(0, -10), p(0, 10))).toBe(false);
    });

    it('honors the caller epsilon used by port cleanup passes', () => {
      expect(orthogonalSegmentsCross(p(-10, 0), p(10, 0.00001), p(0, -10), p(0, 10), 1e-6)).toBe(
        false
      );
    });
  });
});
