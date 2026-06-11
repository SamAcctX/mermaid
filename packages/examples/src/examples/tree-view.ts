import type { DiagramMetadata } from '../types.js';

export default {
  id: 'treeView',
  name: 'TreeView',
  description: 'Visualize hierarchical data as a tree structure',
  examples: [
    {
      title: 'Project File Structure',
      isDefault: true,
      code: `treeView-beta
            my-project/
                src/
                    components/
                        Button.tsx
                        Header.tsx
                    App.tsx
                    index.js
                .gitignore
                package.json
                README.md`,
    },
    {
      title: 'Shared Drive with Quoted Names',
      isDefault: false,
      code: `treeView-beta
            "Team Drive"
                "Quarterly Reports"
                    "Q1 Review.pdf"
                    "Q2 Review.pdf"
                "Brand Assets"
                    "logo.svg"
                    "style guide.md"
                "Meeting Notes"`,
    },
    {
      title: 'Annotations',
      isDefault: false,
      code: `---
config:
  treeView:
    showIcons: true
---
treeView-beta
            src/
                App.tsx :::highlight icon(logos:react) ## main component
                index.js ## entry point
                styles.css icon(none)
            data/
                model.bin icon(logos:mysql)
            .env ## environment variables
            Dockerfile
            package.json`,
    },
    {
      title: 'Automatic File-Type Icons',
      isDefault: false,
      code: `---
config:
  treeView:
    showIcons: true
    defaultIconPack: devicon
---
treeView-beta
            my-project/
                src/
                    App.tsx
                    main.py
                    index.html
                Dockerfile
                package.json
                README.md`,
    },
    {
      title: 'Custom Icon Mappings',
      isDefault: false,
      code: `---
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
            README.md`,
    },
    {
      title: 'Unicode Icons in Filenames',
      isDefault: false,
      code: `treeView-beta
            🚀 rocket-app/
                📦 packages/
                    🎨 ui/
                    🛠️ utils/
                🧪 tests/
                📝 README.md
                ⚙️ config.yaml`,
    },
  ],
} satisfies DiagramMetadata;
