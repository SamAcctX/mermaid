import { beforeEach, describe, expect, it } from 'vitest';
import { profiler } from './profiler.js';

describe('profiler', () => {
  beforeEach(() => {
    profiler.clear();
    profiler.disable();
    profiler.autoPrint = false;
    profiler.runLabel = undefined;
  });

  it('is a no-op when disabled', async () => {
    const result = await profiler.span('x', () => 42);
    expect(result).toBe(42);
    expect(profiler.records).toHaveLength(0);
    expect(profiler.report()).toBeUndefined();
  });

  it('records a labeled, nested phase tree when enabled', async () => {
    profiler.enable();
    profiler.runLabel = 'dagre';
    profiler.start('render');
    await profiler.span('parse', async () => undefined);
    await profiler.span('draw', async () => {
      await profiler.span('layout', async () => undefined);
    });
    const root = profiler.stop();

    expect(root?.name).toBe('render');
    expect(profiler.records).toHaveLength(1);
    const rec = profiler.records[0];
    expect(rec.label).toBe('dagre');
    expect(rec.tree.children.map((c) => c.name)).toEqual(['parse', 'draw']);
    const draw = rec.tree.children.find((c) => c.name === 'draw');
    expect(draw?.children.map((c) => c.name)).toEqual(['layout']);
    expect(rec.tree.duration).toBeGreaterThanOrEqual(0);
  });

  it('rethrows from a span but still closes it', async () => {
    profiler.enable();
    profiler.start('render');
    await expect(
      profiler.span('boom', () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    const root = profiler.stop();
    expect(root?.children[0]?.name).toBe('boom');
  });

  it('consumes runLabel after a single render, then falls back to the root name', async () => {
    profiler.enable();
    profiler.runLabel = 'elk';
    profiler.start('render');
    profiler.stop();
    expect(profiler.records[0].label).toBe('elk');

    profiler.start('render');
    profiler.stop();
    expect(profiler.records[1].label).toBe('render');
  });

  it('clear() empties collected records', () => {
    profiler.enable();
    profiler.start('render');
    profiler.stop();
    expect(profiler.records).toHaveLength(1);
    profiler.clear();
    expect(profiler.records).toHaveLength(0);
  });
});
