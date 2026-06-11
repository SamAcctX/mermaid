import type { IconifyJSON } from '@iconify/types';
import type { NodeType } from './types.js';

/**
 * Built-in icon pack for treeView nodes.
 *
 * Contains only the two default icons (file and folder), drawn as original
 * shapes for this project. Any other icon must come from a user-registered
 * iconify pack (see `registerIconPacks`) and is referenced from the diagram
 * text as `icon(pack:name)`, or as `icon(name)` together with the
 * `defaultIconPack` config option.
 *
 * Icons use `currentColor` so they can be themed via CSS `color`.
 */
export const treeViewIcons: IconifyJSON = {
  prefix: 'mermaid-treeview',
  height: 24,
  width: 24,
  icons: {
    folder: {
      body: '<path fill="currentColor" d="M10.59 4.59A2 2 0 0 0 9.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.17z"/>',
    },
    file: {
      body: '<path fill="currentColor" fill-rule="evenodd" d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.83a2 2 0 0 0-.59-1.42l-4.82-4.82A2 2 0 0 0 13.17 2H6Zm7.5 1.9l4.6 4.6h-3.6a1 1 0 0 1-1-1V3.9Z" clip-rule="evenodd"/>',
    },
  },
};

/**
 * Auto-detection maps for file-type icons.
 * Icon names are aligned with the iconify `devicon` pack, so setting
 * `defaultIconPack: 'devicon'` resolves them directly — but any registered
 * pack using the same names works.
 */

// Known filenames → icon name (checked before the extension)
const FILENAME_ICONS: Record<string, string> = {
  Dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.dockerignore': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'tsconfig.json': 'typescript',
  '.eslintrc': 'eslint',
  '.eslintrc.js': 'eslint',
  '.eslintrc.json': 'eslint',
  'eslint.config.js': 'eslint',
  'eslint.config.mjs': 'eslint',
  '.babelrc': 'babel',
  'webpack.config.js': 'webpack',
  'vite.config.js': 'vitejs',
  'vite.config.ts': 'vitejs',
};

// Extension → icon name
const EXTENSION_ICONS: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'react',
  '.tsx': 'react',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cplusplus',
  '.cc': 'cplusplus',
  '.hpp': 'cplusplus',
  '.c': 'c',
  '.h': 'c',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html5',
  '.htm': 'html5',
  '.css': 'css3',
  '.scss': 'sass',
  '.sass': 'sass',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.vue': 'vuejs',
  '.svelte': 'svelte',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.dart': 'dart',
  '.lua': 'lua',
  '.pl': 'perl',
  '.hs': 'haskell',
  '.scala': 'scala',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.r': 'r',
  '.graphql': 'graphql',
  '.gql': 'graphql',
};

interface IconDetectionConfig {
  /** Exact-filename → icon additions/overrides, merged over the built-in map */
  filenameIcons?: Record<string, string>;
  /** Extension → icon additions/overrides (keys with or without leading dot), merged over the built-in map */
  extensionIcons?: Record<string, string>;
}

/**
 * Detect a file-type icon name from a filename.
 * Filename matches (user-configured, then built-in) win over extension
 * matches (user-configured, then built-in); extensions match
 * case-insensitively. Returns `undefined` when nothing matches.
 */
export function detectIcon(name: string, config?: IconDetectionConfig): string | undefined {
  const filenameIcon = config?.filenameIcons?.[name] ?? FILENAME_ICONS[name];
  if (filenameIcon) {
    return filenameIcon;
  }
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = name.substring(dotIdx).toLowerCase();
    const extensionIcons = config?.extensionIcons;
    return extensionIcons?.[ext] ?? extensionIcons?.[ext.slice(1)] ?? EXTENSION_ICONS[ext];
  }
  return undefined;
}

/** Qualify an unprefixed icon reference: built-ins win, then the defaultIconPack */
function qualifyIcon(icon: string, defaultIconPack: string): string {
  if (icon.includes(':')) {
    return icon;
  }
  if (icon in treeViewIcons.icons || !defaultIconPack) {
    return `${treeViewIcons.prefix}:${icon}`;
  }
  return `${defaultIconPack}:${icon}`;
}

/**
 * Resolve the (fully-qualified) iconify reference to render for a node.
 *
 * An explicit `icon()` annotation always wins (with `none` hiding the icon);
 * otherwise, when `showIcons` is enabled, the icon is auto-detected from the
 * filename (unprefixed detected names require `defaultIconPack`), falling
 * back to the built-in file/folder icon. Returns `undefined` when no icon
 * should be rendered.
 */
export function getNodeIcon(
  node: { icon?: string; name: string; nodeType: NodeType },
  config: { showIcons: boolean; defaultIconPack: string } & IconDetectionConfig
): string | undefined {
  if (node.icon === 'none') {
    return undefined;
  }
  if (node.icon) {
    return qualifyIcon(node.icon, config.defaultIconPack);
  }
  if (!config.showIcons) {
    return undefined;
  }
  if (node.nodeType === 'file') {
    const detected = detectIcon(node.name, config);
    if (detected === 'none') {
      return undefined;
    }
    if (detected) {
      if (detected.includes(':')) {
        return detected;
      }
      if (detected in treeViewIcons.icons) {
        return `${treeViewIcons.prefix}:${detected}`;
      }
      if (config.defaultIconPack) {
        return `${config.defaultIconPack}:${detected}`;
      }
      // unprefixed detection result without a pack to resolve it in —
      // fall through to the built-in default
    }
  }
  return `${treeViewIcons.prefix}:${node.nodeType === 'directory' ? 'folder' : 'file'}`;
}
