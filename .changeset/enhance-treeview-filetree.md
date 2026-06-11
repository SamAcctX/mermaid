---
'mermaid': minor
'@mermaid-js/parser': minor
---

Enhance treeView-beta with file tree features

Extends the existing treeView-beta diagram with features useful for representing file/directory structures:

- **Bare labels**: Node names no longer require quotes (`src/` instead of `"src/"`)
- **Built-in icons**: Files and directories get a default `file`/`folder` icon when the `showIcons` config option is enabled (off by default)
- **Auto-detected file-type icons**: with `showIcons` and the new `defaultIconPack` config option set, file icons are detected from filenames/extensions using icon names aligned with the iconify `devicon` pack; the detection maps can be extended/overridden via the `filenameIcons` and `extensionIcons` config options
- **Icon overrides**: `icon(pack:name)` syntax to use any icon from a registered iconify pack (via `registerIconPacks`) — explicit icons always render; `icon(none)` hides a node's default icon; with `defaultIconPack` set, `icon(name)` resolves in that pack
- **CSS class annotations**: `:::highlight` syntax for styling individual nodes
- **Descriptions**: `## description text` appended after a node label for additional context
- **Comment support**: `%%` line comments within the tree body
- **Whitespace and unicode fidelity**: labels preserve consecutive spaces and unicode/emoji characters; trailing whitespace on bare labels is trimmed
- **Directory detection**: Trailing `/` on a label auto-sets the node type to directory with folder icon
- **New theme variables**: `iconColor` and `descriptionColor` for styling icons and descriptions
