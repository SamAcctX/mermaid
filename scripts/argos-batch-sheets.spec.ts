import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  deriveGroupKey,
  planSheets,
  collectScreenshots,
  composeSheet,
} from './argos-batch-sheets.ts';

const FC = 'rendering/flowchart';
const CLS = 'rendering/class';

describe('deriveGroupKey', () => {
  it('returns the folder before the *.spec.js directory segment', () => {
    expect(deriveGroupKey('rendering/flowchart/flowchart-v2.spec.js/Some Test.png')).toBe(FC);
  });
  it('handles .spec.ts specs', () => {
    expect(deriveGroupKey('rendering/treemap/treemap.spec.ts/A.png')).toBe('rendering/treemap');
  });
  it('groups every spec file in a folder under the same key', () => {
    expect(deriveGroupKey('rendering/flowchart/flowchart.spec.js/x.png')).toBe(FC);
    expect(deriveGroupKey('rendering/flowchart/flowchart-elk.spec.js/y.png')).toBe(FC);
  });
});

describe('planSheets', () => {
  const paths = [
    `${FC}/flowchart-v2.spec.js/b.png`,
    `${FC}/flowchart.spec.js/a.png`,
    `${CLS}/classDiagram-v3.spec.js/c.png`,
  ];

  it('isolates diagrams into separate groups and sheets', () => {
    const sheets = planSheets(paths, { tilesPerSheet: 12, cols: 3 });
    const groups = sheets.map((s) => s.group);
    expect(groups).toContain(FC);
    expect(groups).toContain(CLS);
    // No sheet mixes two diagrams.
    for (const s of sheets) {
      expect(s.tiles.every((t) => deriveGroupKey(t.source) === s.group)).toBe(true);
    }
  });

  it('is deterministic regardless of input order', () => {
    const a = planSheets(paths, { tilesPerSheet: 12, cols: 3 });
    const b = planSheets([...paths].reverse(), { tilesPerSheet: 12, cols: 3 });
    expect(a).toStrictEqual(b);
  });

  it('chunks a folder into fixed-size sheets', () => {
    const many = Array.from(
      { length: 13 },
      (_, i) => `${FC}/flowchart.spec.js/t${String(i).padStart(2, '0')}.png`
    );
    const sheets = planSheets(many, { tilesPerSheet: 12, cols: 3 });
    expect(sheets).toHaveLength(2);
    expect(sheets[0].tiles).toHaveLength(12);
    expect(sheets[1].tiles).toHaveLength(1);
    expect(sheets[0].output).toBe(`${FC}/flowchart-001.png`);
    expect(sheets[1].output).toBe(`${FC}/flowchart-002.png`);
  });

  it('assigns row/col by column count', () => {
    const four = ['a', 'b', 'c', 'd'].map((n) => `${FC}/flowchart.spec.js/${n}.png`);
    const [sheet] = planSheets(four, { tilesPerSheet: 12, cols: 3 });
    expect(sheet.tiles.map((t) => [t.row, t.col])).toStrictEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
    ]);
  });

  it('adding a test to one diagram leaves other diagrams’ sheets byte-identical', () => {
    const before = planSheets(paths, { tilesPerSheet: 12, cols: 3 });
    const after = planSheets([...paths, `${FC}/flowchart.spec.js/aa.png`], {
      tilesPerSheet: 12,
      cols: 3,
    });
    const clsBefore = before.filter((s) => s.group === CLS);
    const clsAfter = after.filter((s) => s.group === CLS);
    expect(clsAfter).toStrictEqual(clsBefore);
  });
});

describe('compositor', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argos-batch-'));
    const specDir = join(dir, 'rendering/flowchart/flowchart.spec.js');
    await mkdir(specDir, { recursive: true });
    // Three differently-sized solid PNGs.
    const tiles = [
      { name: 'a.png', w: 20, h: 10, c: { r: 255, g: 0, b: 0, alpha: 1 } },
      { name: 'b.png', w: 10, h: 30, c: { r: 0, g: 255, b: 0, alpha: 1 } },
      { name: 'c.png', w: 40, h: 15, c: { r: 0, g: 0, b: 255, alpha: 1 } },
    ];
    for (const t of tiles) {
      const buf = await sharp({
        create: { width: t.w, height: t.h, channels: 4, background: t.c },
      })
        .png()
        .toBuffer();
      await writeFile(join(specDir, t.name), buf);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collectScreenshots returns sorted relative png paths', async () => {
    const paths = await collectScreenshots(dir);
    expect(paths).toStrictEqual([
      'rendering/flowchart/flowchart.spec.js/a.png',
      'rendering/flowchart/flowchart.spec.js/b.png',
      'rendering/flowchart/flowchart.spec.js/c.png',
    ]);
  });

  it('composes a fixed-cell grid sized to the largest tile', async () => {
    const paths = await collectScreenshots(dir);
    const [plan] = planSheets(paths, { tilesPerSheet: 12, cols: 3 });
    const { buffer, manifest } = await composeSheet(plan, { inputDir: dir });
    const meta = await sharp(buffer).metadata();
    // cellWidth = max(20,10,40)=40, cellHeight=max(10,30,15)=30, cols=3, rows=1
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(30);
    expect(manifest.grid).toStrictEqual({ cols: 3, rows: 1, cellWidth: 40, cellHeight: 30 });
    expect(manifest.tiles[0]).toMatchObject({ name: 'a', row: 0, col: 0 });
  });

  it('produces byte-identical output on re-run (determinism)', async () => {
    const paths = await collectScreenshots(dir);
    const [plan] = planSheets(paths, { tilesPerSheet: 12, cols: 3 });
    const first = await composeSheet(plan, { inputDir: dir });
    const second = await composeSheet(plan, { inputDir: dir });
    expect(first.buffer.equals(second.buffer)).toBe(true);
  });
});
