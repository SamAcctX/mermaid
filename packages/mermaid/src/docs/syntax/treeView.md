# TreeView Diagram (v11.14.0+)

## Introduction

A TreeView diagram is used to represent hierarchical data in the form of a directory-like structure, with file/folder icons, connector lines, and optional annotations.

## Syntax

The structure of the tree depends only on indentation. Labels can be **bare** (unquoted) or **quoted** (for names containing spaces).

- Directories are indicated by a trailing `/` on the label — they render in bold text.
- Icons are hidden by default — enable the built-in file/folder icons with the `showIcons` config option, or set one per node with `icon()`.
- Quoted labels (`"my file"`) support spaces in names.

```
treeView-beta
    my-project/
        src/
            index.js
        package.json
        README.md
```

Quoted labels (backward compatible):

```
treeView-beta
    "my project"
        "folder with spaces"
            "file.js"
```

## Box-Drawing Input

As an alternative to indentation, you can use box-drawing characters to define the tree structure. The parser auto-detects the format — no extra keyword or config is needed. This is how most file tree diagrams are drawn already, so you can turn those into Mermaid diagrams with very little effort.

Both standard (`├──`, `└──`, `│`) and heavy (`┣━━`, `┗━━`, `┃`) Unicode variants are supported.

```mermaid-example
treeView-beta
├── src/
│   ├── index.ts
│   └── utils.ts
├── package.json
└── README.md
```

All annotations work the same way — just append them after the label:

```mermaid-example
treeView-beta
├── src/
│   ├── App.tsx :::highlight icon(logos:react) ## main component
│   └── index.ts ## entry point
├── .env ## environment variables
├── Dockerfile
└── package.json
```

Depth is inferred from the column position of the branch character, so deeper nesting works naturally:

```mermaid-example
treeView-beta
├── packages/
│   ├── mermaid/
│   │   ├── src/
│   │   │   ├── parser.ts
│   │   │   └── renderer.ts
│   │   └── package.json
│   └── parser/
│       └── src/
└── README.md
```

> **Note:** If a parse error occurs, line numbers in the error message refer to your original input. Tab characters are automatically expanded to spaces.

## Annotations

### Highlighting with :::class

Annotate a node with `:::className` to apply a CSS class. A built-in `highlight` class is provided:

```mermaid-example
treeView-beta
    src/
        App.tsx :::highlight
        index.js
    package.json
```

### Inline descriptions with `##`

Add a visible description after `##` — rendered next to the label in italic:

```mermaid-example
treeView-beta
    src/
        index.js ## app entry point
        config.ts ## runtime configuration
    package.json ## project manifest
```

### Icons

Icons are hidden by default. Set the `showIcons` config option to `true` to show the built-in icons — `file` for files and `folder` for directories:

```mermaid-example
---
config:
  treeView:
    showIcons: true
---
treeView-beta
    src/
        index.js
    package.json
```

#### Automatic file-type icons

Set `defaultIconPack` to the name of a registered [icon pack](../config/icons.md) to auto-detect file-type icons from filenames and extensions — `App.tsx` gets the `react` icon, `main.py` gets `python`, `Dockerfile` gets `docker`, and so on. The detected icon names are aligned with the [devicon](https://icon-sets.iconify.design/devicon/) pack. Directories and unrecognized files keep the built-in `folder`/`file` icons:

```mermaid-example
---
config:
  treeView:
    showIcons: true
    defaultIconPack: devicon
---
treeView-beta
    src/
        App.tsx
        main.py
        index.html
        notes.txt
    Dockerfile
    package.json
```

The detection maps can be extended or overridden with the `filenameIcons` and `extensionIcons` config options. Values are resolved like `icon()` references — `pack:name` is used as-is, unprefixed names resolve via `defaultIconPack`, and `none` disables the icon for matching files:

```mermaid-example
---
config:
  treeView:
    showIcons: true
    defaultIconPack: devicon
    filenameIcons:
      Makefile: cmake
    extensionIcons:
      .tf: terraform
      .txt: none
---
treeView-beta
    infra/
        main.tf
        Makefile
    notes.txt
    README.md
```

#### Icon overrides with icon()

Set a node's icon explicitly with `icon(name)`, where `name` is any icon from a registered [icon pack](../config/icons.md), referenced as `pack:name`. Explicit icons always render, even when `showIcons` is off:

```mermaid-example
treeView-beta
    src/
        App.tsx icon(logos:react)
        index.js
    package.json
```

When `defaultIconPack` is set, unprefixed names resolve in that pack — `icon(react)` becomes shorthand for `icon(devicon:react)`. The built-in `file` and `folder` icons can always be referenced without a prefix, e.g. `icon(folder)`.

```note
Icon packs are not bundled with Mermaid — they must be registered with `registerIconPacks` by the site embedding the diagram. See [registering icon packs](../config/icons.md). An unregistered icon renders as a question mark.
```

#### Hiding icons

When `showIcons` is enabled, use `icon()` or `icon(none)` to hide the icon of a single node:

```mermaid-example
---
config:
  treeView:
    showIcons: true
---
treeView-beta
    src/
        index.js icon(none)
    package.json
```

### Combined annotations

Annotations can be combined in any order:

```mermaid-example
treeView-beta
    my-project/
        src/
            App.tsx :::highlight icon(logos:react) ## main component
            index.js ## entry point
        .env ## environment variables
        Dockerfile
        package.json
```

## Comments

Use `%%` for invisible comments (standard Mermaid convention):

```
treeView-beta
    %% Generated files — do not edit
    src/
        generated/
        index.js
```

## Examples

Basic with quoted labels:

```mermaid-example
treeView-beta
    "packages"
        "mermaid"
            "src"
        "parser"
```

Unicode and emoji in labels:

Labels are rendered exactly as written — unicode characters and consecutive spaces are preserved. Since the built-in icons are hidden by default, emoji make handy inline icons:

```mermaid-example
treeView-beta
    🚀 rocket-app/
        📦 packages/
            🎨 ui/
            🛠️ utils/
        🧪 tests/
        📝 README.md
        ⚙️ config.yaml
```

With custom config:

```mermaid-example
---
config:
    treeView:
        rowIndent: 80
        lineThickness: 3
    themeVariables:
        treeView:
            labelFontSize: '20px'
            labelColor: '#FF0000'
            lineColor: '#00FF00'
---
treeView-beta
    "packages"
        "mermaid"
            "src"
        "parser"
```

## Config Variables

| Property        | Description                                                                             | Default Value |
| --------------- | --------------------------------------------------------------------------------------- | ------------- |
| rowIndent       | Indentation for each row                                                                | 10            |
| paddingX        | Horizontal padding of row                                                               | 5             |
| paddingY        | Vertical padding of row                                                                 | 5             |
| lineThickness   | Thickness of the line                                                                   | 1             |
| showIcons       | Whether to show the default file/folder icons (explicit `icon()` always renders)        | false         |
| defaultIconPack | Registered iconify pack used for auto-detected icons and unprefixed `icon()` references | ''            |
| filenameIcons   | Filename → icon additions/overrides for auto-detection                                  | {}            |
| extensionIcons  | Extension → icon additions/overrides for auto-detection                                 | {}            |

### Theme Variables

| Property         | Description                                               | Default Value        |
| ---------------- | --------------------------------------------------------- | -------------------- |
| labelFontSize    | Font size of the label                                    | '16px'               |
| labelColor       | Color of the label                                        | 'black'              |
| lineColor        | Color of the line                                         | 'black'              |
| iconColor        | Color of icons (applies to icons that use `currentColor`) | '#546e7a'            |
| descriptionColor | Color of `##` description text                            | '#6a9955'            |
| highlightBg      | Highlight background fill                                 | rgba(255,193,7,0.15) |
| highlightStroke  | Highlight border stroke                                   | #ffc107              |
