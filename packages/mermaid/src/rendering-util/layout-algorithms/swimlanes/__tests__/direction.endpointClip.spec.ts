import { describe, expect, it } from 'vitest';
import {
  clipEdgeEndpointsToNodeBoundaries,
  prepareEdgeEndpointsForRenderer,
} from '../direction/endpointClip.js';

describe('direction endpoint clipping', () => {
  it('clips buried endpoints to source and destination node boundaries', () => {
    const nodeById = new Map<string, any>([
      ['A', { id: 'A', x: 0, y: 0, width: 10, height: 10 }],
      ['B', { id: 'B', x: 20, y: 0, width: 10, height: 10 }],
    ]);
    const edges: any[] = [
      {
        id: 'A_B',
        start: 'A',
        end: 'B',
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
      },
    ];

    clipEdgeEndpointsToNodeBoundaries(edges, nodeById);

    expect(edges[0].points).toEqual([
      { x: 5, y: 0 },
      { x: 15, y: 0 },
    ]);
  });

  it('duplicates snapped endpoints so renderer clipping becomes a no-op', () => {
    const nodeById = new Map<string, any>([
      ['A', { id: 'A', x: 0, y: 0, width: 10, height: 10 }],
      ['B', { id: 'B', x: 20, y: 0, width: 10, height: 10 }],
    ]);
    const edges: any[] = [
      {
        id: 'A_B',
        start: 'A',
        end: 'B',
        points: [
          { x: -5, y: 0 },
          { x: 10, y: 0 },
          { x: 15, y: 0 },
        ],
      },
    ];

    prepareEdgeEndpointsForRenderer(edges, nodeById);

    expect(edges[0].points).toEqual([
      { x: -5, y: 0 },
      { x: -5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
      { x: 15, y: 0 },
    ]);
  });
});
