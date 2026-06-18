/**
 * Batches per-test Cypress screenshots into composite "sheets" for Argos,
 * grouping by diagram folder so a new test in one diagram never alters another
 * diagram's sheets. Pure planning is separated from sharp-backed compositing so
 * the grouping/ordering rules can be unit-tested without images.
 *
 * CLI usage:
 *   pnpm run argos:batch
 *   ARGOS_SCREENSHOT_DIR=cypress/screenshots ARGOS_SHEETS_DIR=cypress/argos-sheets
 *     ARGOS_TILES_PER_SHEET=12 ARGOS_SHEET_COLS=3 pnpm run argos:batch
 */

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Matches a Cypress spec-file path segment: foo.spec.js / foo.spec.ts / .cjs / .mts
const SPEC_SEGMENT_RE = /\.spec\.[cm]?[jt]s$/;

export interface Tile {
  index: number;
  row: number;
  col: number;
  name: string;
  source: string;
}

export interface Sheet {
  group: string;
  index: number;
  output: string;
  cols: number;
  tiles: Tile[];
}

export interface SheetManifest {
  sheet: string;
  group: string;
  grid: { cols: number; rows: number; cellWidth: number; cellHeight: number };
  tiles: Tile[];
}

export interface PlanSheetsOptions {
  tilesPerSheet?: number;
  cols?: number;
}

export interface ComposeSheetOptions {
  inputDir: string;
  background?: { r: number; g: number; b: number; alpha: number };
}

export interface WriteSheetsOptions {
  inputDir: string;
  outDir: string;
}

/** Maps a screenshot path to its diagram folder (prefix before the `*.spec.*` segment). */
export function deriveGroupKey(relPath: string): string {
  const parts = relPath.split('/');
  const specIdx = parts.findIndex((p) => SPEC_SEGMENT_RE.test(p));
  if (specIdx > 0) {
    return parts.slice(0, specIdx).join('/');
  }
  if (specIdx === 0) {
    return parts[0].replace(SPEC_SEGMENT_RE, '');
  }
  return parts.slice(0, -1).join('/') || 'root';
}

/** Groups, stable-sorts, and chunks screenshots into fixed-size grid sheets. */
export function planSheets(relPaths: string[], options: PlanSheetsOptions = {}): Sheet[] {
  const tilesPerSheet = options.tilesPerSheet ?? 12;
  const cols = options.cols ?? 3;

  const groups = new Map<string, string[]>();
  for (const p of relPaths) {
    const key = deriveGroupKey(p);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(p);
    } else {
      groups.set(key, [p]);
    }
  }

  const sheets: Sheet[] = [];
  for (const key of [...groups.keys()].sort()) {
    const tiles = [...(groups.get(key) ?? [])].sort();
    const basename = key.split('/').pop() ?? 'sheet';
    for (let start = 0; start < tiles.length; start += tilesPerSheet) {
      const chunk = tiles.slice(start, start + tilesPerSheet);
      const index = start / tilesPerSheet;
      const output = `${key}/${basename}-${String(index + 1).padStart(3, '0')}.png`;
      sheets.push({
        group: key,
        index,
        output,
        cols,
        tiles: chunk.map((source, i) => ({
          index: i,
          row: Math.floor(i / cols),
          col: i % cols,
          name:
            source
              .split('/')
              .pop()
              ?.replace(/\.png$/, '') ?? '',
          source,
        })),
      });
    }
  }
  return sheets;
}

/** Recursively collects PNG paths under `dir`, relative with forward slashes, sorted. */
export async function collectScreenshots(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.png'))
    .map((e) =>
      relative(dir, join(e.parentPath ?? e.path, e.name))
        .split(sep)
        .join('/')
    )
    .sort();
}

/** Composites one sheet into a deterministic PNG plus a tile manifest. */
export async function composeSheet(
  plan: Sheet,
  options: ComposeSheetOptions
): Promise<{ buffer: Buffer; manifest: SheetManifest }> {
  const { inputDir } = options;
  const background = options.background ?? { r: 255, g: 255, b: 255, alpha: 1 };
  const { cols } = plan;

  const dims = await Promise.all(
    plan.tiles.map(async (t) => {
      const meta = await sharp(join(inputDir, t.source)).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    })
  );
  const cellWidth = Math.max(...dims.map((d) => d.width));
  const cellHeight = Math.max(...dims.map((d) => d.height));
  const rows = Math.max(...plan.tiles.map((t) => t.row)) + 1;

  const composites = plan.tiles.map((t) => ({
    input: join(inputDir, t.source),
    left: t.col * cellWidth,
    top: t.row * cellHeight,
  }));

  const buffer = await sharp({
    create: { width: cellWidth * cols, height: cellHeight * rows, channels: 4, background },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  const manifest: SheetManifest = {
    sheet: plan.output,
    group: plan.group,
    grid: { cols, rows, cellWidth, cellHeight },
    tiles: plan.tiles.map((t) => ({
      index: t.index,
      row: t.row,
      col: t.col,
      name: t.name,
      source: t.source,
    })),
  };

  return { buffer, manifest };
}

/** Writes composite PNGs and sibling `.json` manifests under outDir. */
export async function writeSheets(plans: Sheet[], options: WriteSheetsOptions): Promise<void> {
  for (const plan of plans) {
    const { buffer, manifest } = await composeSheet(plan, { inputDir: options.inputDir });
    const sheetPath = join(options.outDir, plan.output);
    await mkdir(dirname(sheetPath), { recursive: true });
    await writeFile(sheetPath, buffer);
    await writeFile(sheetPath.replace(/\.png$/, '.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}

async function main(): Promise<void> {
  const inputDir = process.env.ARGOS_SCREENSHOT_DIR ?? 'cypress/screenshots';
  const outDir = process.env.ARGOS_SHEETS_DIR ?? 'cypress/argos-sheets';
  const tilesPerSheet = Number(process.env.ARGOS_TILES_PER_SHEET ?? 12);
  const cols = Number(process.env.ARGOS_SHEET_COLS ?? 3);

  const relPaths = await collectScreenshots(inputDir);
  const plans = planSheets(relPaths, { tilesPerSheet, cols });
  await writeSheets(plans, { inputDir, outDir });
  process.stdout.write(
    `[argos-batch] ${relPaths.length} screenshots → ${plans.length} sheets in ${outDir}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
