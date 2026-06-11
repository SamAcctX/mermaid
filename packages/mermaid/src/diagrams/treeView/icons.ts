import type { IconifyJSON } from '@iconify/types';
import type { NodeType } from './types.js';

/**
 * Built-in icon pack for treeView nodes.
 *
 * Contains only the two default icons (file and folder), drawn as original
 * shapes for this project. Any other icon must come from a user-registered
 * iconify pack (see `registerIconPacks`) and is referenced from the diagram
 * text as `icon(pack:name)`.
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
 * Default icon name for a node when no `icon()` annotation is given.
 */
export function getDefaultIcon(nodeType: NodeType): string {
  return nodeType === 'directory' ? 'folder' : 'file';
}
