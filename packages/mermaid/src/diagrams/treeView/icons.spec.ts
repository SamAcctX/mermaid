import { describe, expect, it } from 'vitest';
import { detectIcon, getNodeIcon, treeViewIcons } from './icons.js';

const config = (
  overrides: Partial<{
    showIcons: boolean;
    defaultIconPack: string;
    filenameIcons: Record<string, string>;
    extensionIcons: Record<string, string>;
  }> = {}
) => ({
  showIcons: false,
  defaultIconPack: '',
  filenameIcons: {},
  extensionIcons: {},
  ...overrides,
});

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

  describe('detectIcon', () => {
    it('detects devicon-aligned icons from extensions', () => {
      expect(detectIcon('utils.ts')).toBe('typescript');
      expect(detectIcon('App.tsx')).toBe('react');
      expect(detectIcon('main.py')).toBe('python');
      expect(detectIcon('index.html')).toBe('html5');
      expect(detectIcon('styles.css')).toBe('css3');
      expect(detectIcon('main.cpp')).toBe('cplusplus');
      expect(detectIcon('App.vue')).toBe('vuejs');
      expect(detectIcon('server.js')).toBe('javascript');
    });

    it('exact filename match beats the extension match', () => {
      // tsconfig.json: filename → typescript, extension → json
      expect(detectIcon('tsconfig.json')).toBe('typescript');
      expect(detectIcon('package.json')).toBe('npm');
      expect(detectIcon('docker-compose.yml')).toBe('docker');
      expect(detectIcon('Dockerfile')).toBe('docker');
      expect(detectIcon('.gitignore')).toBe('git');
      expect(detectIcon('yarn.lock')).toBe('yarn');
    });

    it('extension matching is case-insensitive', () => {
      expect(detectIcon('APP.TS')).toBe('typescript');
      expect(detectIcon('Main.PY')).toBe('python');
    });

    it('uses the last extension for multi-dot names', () => {
      expect(detectIcon('component.spec.ts')).toBe('typescript');
      expect(detectIcon('archive.tar.gz')).toBeUndefined();
    });

    it('returns undefined when nothing matches', () => {
      expect(detectIcon('data.xyz')).toBeUndefined();
      expect(detectIcon('noext')).toBeUndefined();
      expect(detectIcon('.bashrc')).toBeUndefined();
    });

    describe('config overrides', () => {
      it('user extension entries beat the built-in extension mapping', () => {
        expect(detectIcon('utils.ts', config({ extensionIcons: { '.ts': 'logos:deno' } }))).toBe(
          'logos:deno'
        );
      });

      it('extension keys work with or without the leading dot', () => {
        expect(detectIcon('main.zig', config({ extensionIcons: { '.zig': 'zig' } }))).toBe('zig');
        expect(detectIcon('main.zig', config({ extensionIcons: { zig: 'zig' } }))).toBe('zig');
      });

      it('user filename entries beat the built-in filename mapping', () => {
        expect(
          detectIcon('package.json', config({ filenameIcons: { 'package.json': 'nodejs' } }))
        ).toBe('nodejs');
        expect(detectIcon('Makefile', config({ filenameIcons: { Makefile: 'cmake' } }))).toBe(
          'cmake'
        );
      });

      it('built-in filename matches still beat user extension entries', () => {
        expect(
          detectIcon('tsconfig.json', config({ extensionIcons: { '.json': 'logos:json' } }))
        ).toBe('typescript');
      });
    });
  });

  describe('getNodeIcon', () => {
    const file = (name: string, icon?: string) => ({ name, icon, nodeType: 'file' as const });
    const dir = (name: string, icon?: string) => ({ name, icon, nodeType: 'directory' as const });

    it('returns undefined for none regardless of config', () => {
      expect(getNodeIcon(file('a.ts', 'none'), config())).toBeUndefined();
      expect(
        getNodeIcon(dir('src', 'none'), config({ showIcons: true, defaultIconPack: 'devicon' }))
      ).toBeUndefined();
    });

    it('returns prefixed explicit icons as-is, regardless of showIcons', () => {
      expect(getNodeIcon(file('a.ts', 'logos:react'), config())).toBe('logos:react');
      expect(getNodeIcon(file('a.ts', 'logos:react'), config({ showIcons: true }))).toBe(
        'logos:react'
      );
    });

    it('qualifies built-in names with the built-in pack, even when defaultIconPack is set', () => {
      expect(getNodeIcon(file('a.ts', 'file'), config({ defaultIconPack: 'devicon' }))).toBe(
        'mermaid-treeview:file'
      );
      expect(getNodeIcon(file('a.ts', 'folder'), config())).toBe('mermaid-treeview:folder');
    });

    it('qualifies unprefixed explicit icons with the defaultIconPack', () => {
      expect(getNodeIcon(file('a.ts', 'react'), config({ defaultIconPack: 'devicon' }))).toBe(
        'devicon:react'
      );
    });

    it('qualifies unprefixed explicit icons with the built-in pack when no defaultIconPack is set', () => {
      // resolves to the unknown-icon fallback at fetch time
      expect(getNodeIcon(file('a.ts', 'react'), config())).toBe('mermaid-treeview:react');
    });

    it('returns undefined without an explicit icon when showIcons is off', () => {
      expect(getNodeIcon(file('utils.ts'), config())).toBeUndefined();
      expect(getNodeIcon(dir('src'), config({ defaultIconPack: 'devicon' }))).toBeUndefined();
    });

    it('auto-detects file icons when showIcons is on and defaultIconPack is set', () => {
      expect(
        getNodeIcon(file('utils.ts'), config({ showIcons: true, defaultIconPack: 'devicon' }))
      ).toBe('devicon:typescript');
      expect(
        getNodeIcon(file('Dockerfile'), config({ showIcons: true, defaultIconPack: 'devicon' }))
      ).toBe('devicon:docker');
    });

    it('falls back to the built-in file icon when detection misses', () => {
      expect(
        getNodeIcon(file('data.xyz'), config({ showIcons: true, defaultIconPack: 'devicon' }))
      ).toBe('mermaid-treeview:file');
    });

    it('does not auto-detect without a defaultIconPack', () => {
      expect(getNodeIcon(file('utils.ts'), config({ showIcons: true }))).toBe(
        'mermaid-treeview:file'
      );
    });

    it('directories always get the built-in folder icon when showIcons is on', () => {
      expect(getNodeIcon(dir('src'), config({ showIcons: true }))).toBe('mermaid-treeview:folder');
      expect(getNodeIcon(dir('src'), config({ showIcons: true, defaultIconPack: 'devicon' }))).toBe(
        'mermaid-treeview:folder'
      );
    });

    describe('detection map overrides', () => {
      it('hides the icon for files mapped to none', () => {
        expect(
          getNodeIcon(
            file('notes.txt'),
            config({
              showIcons: true,
              defaultIconPack: 'devicon',
              extensionIcons: { '.txt': 'none' },
            })
          )
        ).toBeUndefined();
      });

      it('uses prefixed override values even without a defaultIconPack', () => {
        expect(
          getNodeIcon(
            file('utils.ts'),
            config({ showIcons: true, extensionIcons: { '.ts': 'logos:deno' } })
          )
        ).toBe('logos:deno');
      });

      it('qualifies unprefixed override values with the defaultIconPack', () => {
        expect(
          getNodeIcon(
            file('main.zig'),
            config({ showIcons: true, defaultIconPack: 'devicon', extensionIcons: { zig: 'zig' } })
          )
        ).toBe('devicon:zig');
      });

      it('falls back to the built-in file icon for unprefixed override values without a defaultIconPack', () => {
        expect(
          getNodeIcon(file('main.zig'), config({ showIcons: true, extensionIcons: { zig: 'zig' } }))
        ).toBe('mermaid-treeview:file');
      });

      it('allows override values to reference the built-in icons', () => {
        expect(
          getNodeIcon(
            file('notes.txt'),
            config({
              showIcons: true,
              defaultIconPack: 'devicon',
              filenameIcons: { 'notes.txt': 'folder' },
            })
          )
        ).toBe('mermaid-treeview:folder');
      });
    });
  });
});
