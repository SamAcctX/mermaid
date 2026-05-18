import { describe, expect, it, vi } from 'vitest';
import { draw, expandImpliedSubsets } from './vennRenderer.js';
import type { Diagram } from '../../Diagram.js';
import type { VennData } from './vennTypes.js';
import * as configModule from '../../config.js';

const createDiagram = (overrides: Partial<Record<string, unknown>> = {}) => {
  const defaultDb = {
    getConfig: () => ({
      padding: 15,
      useDebugLayout: false,
    }),
    getDiagramTitle: () => undefined,
    getSubsetData: () => [
      { sets: ['A'], size: 10, label: 'A' },
      { sets: ['B'], size: 10, label: 'B' },
      { sets: ['A', 'B'], size: 2.5, label: 'AB' },
    ],
    getTextData: () => [],
    getStyleData: () => [],
  };

  return {
    db: { ...defaultDb, ...overrides },
  } as unknown as Diagram;
};

describe('vennRenderer', () => {
  it('renders a title when provided', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram({
      getDiagramTitle: () => 'My Venn Title',
    });

    await draw('', 'venn', '1.0', diagram);

    const title = document.querySelector('#venn > text');
    expect(title?.textContent).toBe('My Venn Title');
  });

  it('renders text nodes with custom color via style data', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram({
      getTextData: () => [
        { sets: ['A'], id: 'alpha', label: undefined },
        { sets: ['A', 'B'], id: 'shared', label: undefined },
      ],
      getStyleData: () => [{ targets: ['alpha'], styles: { color: '#ff0000' } }],
    });

    await draw('', 'venn', '1.0', diagram);

    const nodes = [...document.querySelectorAll<HTMLDivElement>('.venn-text-node')];
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const colored = nodes.find((node) => node.textContent === 'alpha');
    expect(colored?.style.color).toBe('rgb(255, 0, 0)');
  });

  it('applies theme colors to circles', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram();

    await draw('', 'venn', '1.0', diagram);

    const circles = document.querySelectorAll('.venn-circle');
    expect(circles.length).toBeGreaterThanOrEqual(2);
    // First circle should have venn-set-0 class
    expect(circles[0]?.classList.contains('venn-set-0')).toBe(true);
    // Second circle should have venn-set-1 class
    expect(circles[1]?.classList.contains('venn-set-1')).toBe(true);
  });

  it('user override colors take priority over theme via style data', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram({
      getSubsetData: () => [
        { sets: ['A'], size: 10, label: 'A' },
        { sets: ['B'], size: 10, label: 'B' },
        { sets: ['A', 'B'], size: 2.5, label: 'AB' },
      ],
      getStyleData: () => [{ targets: ['A', 'B'], styles: { color: '#00ff00', fill: 'gold' } }],
    });

    await draw('', 'venn', '1.0', diagram);

    const intersectionTexts = document.querySelectorAll('.venn-intersection text');
    // Find the text element for AB intersection
    let abText: Element | null = null;
    intersectionTexts.forEach((el) => {
      if (el.textContent === 'AB') {
        abText = el;
      }
    });
    if (abText) {
      expect((abText as SVGTextElement).style.fill).toBe('#00ff00');
    }

    const intersectionPaths = document.querySelectorAll('.venn-intersection path');
    let abPath: Element | null = null;
    intersectionPaths.forEach((el) => {
      if ((el as SVGPathElement).style.fillOpacity === '1') {
        abPath = el;
      }
    });
    if (abPath) {
      expect((abPath as SVGPathElement).style.fill).toBe('gold');
    }
  });

  it('computes contrasting text color for dark backgrounds', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    // Mock getConfig to return dark theme colors
    const spy = vi.spyOn(configModule, 'getConfig');
    const originalConfig = configModule.getConfig();
    spy.mockReturnValue({
      ...originalConfig,
      themeVariables: {
        ...originalConfig.themeVariables,
        venn1: '#1a1a2e',
        venn2: '#16213e',
        venn3: '#0f3460',
        venn4: '#533483',
        venn5: '#2b2d42',
        venn6: '#1b1b2f',
        venn7: '#162447',
        venn8: '#1f4068',
        vennTitleTextColor: '#ffffff',
        vennSetTextColor: '#cccccc',
        primaryColor: '#1a1a2e',
        titleColor: '#ffffff',
        textColor: '#cccccc',
        primaryTextColor: '#cccccc',
      },
    } as ReturnType<typeof configModule.getConfig>);

    const diagram = createDiagram();
    await draw('', 'venn', '1.0', diagram);

    const circles = document.querySelectorAll('.venn-circle');
    expect(circles.length).toBeGreaterThanOrEqual(2);
    // For dark backgrounds, text should be lightened
    const textEl = circles[0]?.querySelector('text');
    expect(textEl?.style.fill).toBeTruthy();
    // The fill should NOT be the same as the dark background color
    expect(textEl?.style.fill).not.toBe('#1a1a2e');

    spy.mockRestore();
  });

  it('renders debug layout helpers when enabled', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram({
      getConfig: () => ({
        padding: 15,
        useDebugLayout: true,
        textMinFontSize: 12,
        textMaxFontSize: 28,
      }),
      getTextData: () => [{ sets: ['A'], id: 'alpha', label: undefined }],
    });

    await draw('', 'venn', '1.0', diagram);

    const debugCircle = document.querySelector('.venn-text-debug-circle');
    expect(debugCircle).not.toBeNull();
  });

  it('renders an overlapping layout for a bare 3-way union (issue #7656)', async () => {
    document.body.innerHTML = '<svg id="venn"></svg>';
    const diagram = createDiagram({
      getSubsetData: () => [
        { sets: ['A'], size: 10, label: undefined },
        { sets: ['B'], size: 10, label: undefined },
        { sets: ['C'], size: 10, label: undefined },
        { sets: ['A', 'B', 'C'], size: 1, label: 'Innovation' },
      ],
    });

    await draw('', 'venn', '1.0', diagram);

    // The label being present is necessary but not sufficient: venn.js emits a
    // `.venn-intersection text` element for any declared labeled union, even
    // when the circles do not actually overlap.
    const intersectionLabels = [...document.querySelectorAll('.venn-intersection text')].map(
      (el) => el.textContent
    );
    expect(intersectionLabels).toContain('Innovation');

    // What the fix actually guarantees is that the layout produces overlapping
    // circles, which is visible in two complementary ways in the DOM:
    //   1. venn.js renders the three implied pairwise intersections, in addition
    //      to the user-declared 3-way intersection.
    //   2. The 3-way intersection's SVG path is a real region, not the
    //      degenerate `"M 0 0"` placeholder venn.js emits when an area has no
    //      visible geometry on screen.
    const intersections = [...document.querySelectorAll('.venn-intersection')];
    const setsByPath = new Map<string, string | null>();
    for (const node of intersections) {
      const data = (node as unknown as { __data__?: { sets?: string[] } }).__data__;
      const sets = data?.sets ?? [];
      if (sets.length >= 2) {
        const key = [...sets].sort().join('|');
        setsByPath.set(key, node.querySelector('path')?.getAttribute('d') ?? null);
      }
    }
    expect([...setsByPath.keys()].sort()).toEqual(['A|B', 'A|B|C', 'A|C', 'B|C']);
    const threeWayPath = setsByPath.get('A|B|C');
    expect(threeWayPath).toBeTruthy();
    expect(threeWayPath).not.toBe('M 0 0');
    expect((threeWayPath ?? '').length).toBeGreaterThan(20);
  });
});

describe('expandImpliedSubsets', () => {
  it('returns input unchanged when only singleton and pairwise subsets are present', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['A', 'B'], size: 2.5, label: 'AB' },
    ];
    expect(expandImpliedSubsets(input)).toBe(input);
  });

  it('returns input unchanged when 3-way union has all pairwise unions declared', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['C'], size: 10, label: undefined },
      { sets: ['A', 'B'], size: 2.5, label: undefined },
      { sets: ['A', 'C'], size: 2.5, label: undefined },
      { sets: ['B', 'C'], size: 2.5, label: undefined },
      { sets: ['A', 'B', 'C'], size: 1, label: 'ABC' },
    ];
    const result = expandImpliedSubsets(input);
    expect(result).toHaveLength(input.length);
  });

  it('synthesizes missing pairwise subsets for a bare 3-way union', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['C'], size: 10, label: undefined },
      { sets: ['A', 'B', 'C'], size: 1, label: 'Innovation' },
    ];
    const result = expandImpliedSubsets(input);
    const pairKeys = result
      .filter((entry) => entry.sets.length === 2)
      .map((entry) => entry.sets.join('|'))
      .sort();
    expect(pairKeys).toEqual(['A|B', 'A|C', 'B|C']);
  });

  it('preserves user-declared pairwise subsets and only fills in missing ones', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['C'], size: 10, label: undefined },
      { sets: ['A', 'B'], size: 5, label: 'AB' },
      { sets: ['A', 'B', 'C'], size: 1, label: 'ABC' },
    ];
    const result = expandImpliedSubsets(input);

    const ab = result.find((entry) => entry.sets.join('|') === 'A|B');
    expect(ab).toEqual({ sets: ['A', 'B'], size: 5, label: 'AB' });

    const synthesized = result
      .filter((entry) => entry.label === undefined && entry.sets.length === 2)
      .map((entry) => entry.sets.join('|'))
      .sort();
    expect(synthesized).toEqual(['A|C', 'B|C']);
  });

  it('synthesizes C(N,2) pairs for a bare 4-way union', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['C'], size: 10, label: undefined },
      { sets: ['D'], size: 10, label: undefined },
      { sets: ['A', 'B', 'C', 'D'], size: 1, label: 'AllFour' },
    ];
    const result = expandImpliedSubsets(input);
    const pairKeys = result
      .filter((entry) => entry.sets.length === 2)
      .map((entry) => entry.sets.join('|'))
      .sort();
    expect(pairKeys).toEqual(['A|B', 'A|C', 'A|D', 'B|C', 'B|D', 'C|D']);
  });

  it('synthesized pairs have a default size and undefined label', () => {
    const input: VennData[] = [
      { sets: ['A'], size: 10, label: undefined },
      { sets: ['B'], size: 10, label: undefined },
      { sets: ['C'], size: 10, label: undefined },
      { sets: ['A', 'B', 'C'], size: 1, label: undefined },
    ];
    const result = expandImpliedSubsets(input);
    const synthesized = result.filter((entry) => entry.sets.length === 2);
    for (const entry of synthesized) {
      expect(entry.label).toBeUndefined();
      expect(entry.size).toBeGreaterThan(0);
    }
  });
});
