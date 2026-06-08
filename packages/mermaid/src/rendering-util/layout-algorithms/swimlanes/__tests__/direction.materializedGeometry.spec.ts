import { describe, expect, it } from 'vitest';
import {
  collapseRedundantRectangularDoglegs,
  separateSharedRenderedTerminalLanes,
  swapDestinationTerminalTailsToReduceCrossings,
} from '../direction/materializedGeometry.js';
import {
  orthogonalSegmentsForPoints,
  orthogonalSegmentsStrictlyCross,
} from '../direction/geometry.js';

function strictCrossingCount(edges: any[]): number {
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    const firstSegments = orthogonalSegmentsForPoints(edges[i].points);
    for (let j = i + 1; j < edges.length; j++) {
      const secondSegments = orthogonalSegmentsForPoints(edges[j].points);
      for (const firstSegment of firstSegments) {
        for (const secondSegment of secondSegments) {
          if (
            orthogonalSegmentsStrictlyCross(
              firstSegment.a,
              firstSegment.b,
              secondSegment.a,
              secondSegment.b
            )
          ) {
            count++;
          }
        }
      }
    }
  }
  return count;
}

describe('materialized render geometry cleanup', () => {
  it('separates shared visible terminal rails on the same node face', () => {
    const nodeById = new Map<string, any>([
      ['A', { id: 'A', x: -40, y: -30, width: 10, height: 10 }],
      ['B', { id: 'B', x: 0, y: 0, width: 10, height: 80 }],
    ]);
    const edges: any[] = [
      {
        id: 'A_B_1',
        start: 'A',
        end: 'B',
        points: [
          { x: -30, y: 0 },
          { x: -5, y: 0 },
        ],
      },
      {
        id: 'A_B_2',
        start: 'A',
        end: 'B',
        points: [
          { x: -30, y: 0 },
          { x: -5, y: 0 },
        ],
      },
    ];

    separateSharedRenderedTerminalLanes(edges, nodeById);

    const terminalYs = edges.map((edge) => edge.points.at(-1).y).sort((a, b) => a - b);
    expect(terminalYs[0]).not.toBe(terminalYs[1]);
    expect(terminalYs).toContain(0);
  });

  it('separates near-parallel terminal rails on the same node face', () => {
    const nodeById = new Map<string, any>([
      ['A', { id: 'A', x: -40, y: -30, width: 10, height: 10 }],
      ['B', { id: 'B', x: 0, y: 0, width: 10, height: 60 }],
      ['C', { id: 'C', x: -40, y: 30, width: 10, height: 10 }],
    ]);
    const edges: any[] = [
      {
        id: 'A_B',
        start: 'A',
        end: 'B',
        points: [
          { x: -90, y: -4 },
          { x: -5, y: -4 },
        ],
      },
      {
        id: 'B_C',
        start: 'B',
        end: 'C',
        points: [
          { x: -5, y: 4 },
          { x: -90, y: 4 },
        ],
      },
    ];

    separateSharedRenderedTerminalLanes(edges, nodeById);

    const terminalYs = [edges[0].points.at(-1).y, edges[1].points[0].y].sort((a, b) => a - b);
    expect(terminalYs[1] - terminalYs[0]).toBeGreaterThanOrEqual(16);
  });

  it('collapses a provably redundant rectangular dogleg', () => {
    const edges: any[] = [
      {
        id: 'A_B',
        start: 'A',
        end: 'B',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
          { x: 0, y: 20 },
        ],
      },
    ];

    collapseRedundantRectangularDoglegs(edges, new Map());

    expect(edges[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
    ]);
  });

  it('swaps shared destination terminal tails when both swaps remove a crossing', () => {
    const cExitTopPort = { x: 297.553125, y: 1171.1287841796875 };
    const dExitRightPort = { x: 318.890625, y: 1196.6287841796875 };
    const nodeById = new Map<string, any>([
      ['C', { id: 'C', x: 292.21875, y: 287.5, width: 150.05624389648438, height: 91 }],
      ['D', { id: 'D', x: 292.21875, y: 570.5, width: 94.11250305175781, height: 91 }],
      ['exit', { id: 'exit', x: 292.21875, y: 1196.6287841796875, width: 53.34375, height: 51 }],
    ]);
    const edges: any[] = [
      {
        id: 'L_C_exit_0',
        start: 'C',
        end: 'exit',
        points: [
          { x: 367.2468719482422, y: 287.5 },
          { x: 387.2468719482422, y: 287.5 },
          { x: 387.2468719482422, y: 1151.1287841796875 },
          { x: 297.553125, y: 1151.1287841796875 },
          cExitTopPort,
        ],
      },
      {
        id: 'L_D_exit_0',
        start: 'D',
        end: 'exit',
        points: [
          { x: 339.2750015258789, y: 570.5 },
          { x: 359.2750015258789, y: 570.5 },
          { x: 359.2750015258789, y: 1196.6287841796875 },
          dExitRightPort,
        ],
      },
    ];

    expect(strictCrossingCount(edges)).toBe(1);

    swapDestinationTerminalTailsToReduceCrossings(edges, nodeById);

    expect(strictCrossingCount(edges)).toBe(0);
    expect(edges[0].points.at(-1)).toEqual(dExitRightPort);
    expect(edges[1].points.at(-1)).toEqual(cExitTopPort);
  });
});
