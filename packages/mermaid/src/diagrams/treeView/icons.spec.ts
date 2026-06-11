import { describe, expect, it } from 'vitest';
import { getDefaultIcon, treeViewIcons } from './icons.js';

describe('icons', () => {
  describe('treeViewIcons pack', () => {
    it('uses the mermaid-treeview prefix', () => {
      expect(treeViewIcons.prefix).toBe('mermaid-treeview');
    });

    it('contains exactly the built-in file and folder icons', () => {
      expect(Object.keys(treeViewIcons.icons).sort()).toEqual(['file', 'folder']);
    });

    it('every icon has a non-empty body that inherits color via currentColor', () => {
      for (const [name, icon] of Object.entries(treeViewIcons.icons)) {
        expect(icon.body.length, `icon "${name}" should have a non-empty body`).toBeGreaterThan(0);
        expect(icon.body, `icon "${name}" should use currentColor`).toContain('currentColor');
      }
    });
  });

  describe('getDefaultIcon', () => {
    it('returns folder for directories', () => {
      expect(getDefaultIcon('directory')).toBe('folder');
    });

    it('returns file for files', () => {
      expect(getDefaultIcon('file')).toBe('file');
    });
  });
});
