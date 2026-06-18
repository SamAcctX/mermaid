# Argos visual regression

Per-test screenshots are captured during Cypress runs but **not** uploaded in-run. A dedicated CI job composites them into folder-wise sheets and uploads once to Argos.

## Pipeline

1. **Capture** — `cy.argosScreenshot` writes PNGs to `cypress/screenshots/.../argos/` (local only; no `registerArgosTask` / no in-run upload).
2. **Batch** — `pnpm run argos:batch` groups screenshots by diagram folder, stable-sorts, chunks into fixed-tile sheets, and writes composites + JSON manifests to `cypress/argos-sheets/`.
3. **Upload** — the `argos-batch` CI job runs `argos upload cypress/argos-sheets` to the **mermaid-batched** Argos project. Auth is automatic via GitHub OIDC (`id-token: write`; tokenless fallback on fork PRs). No `ARGOS_TOKEN` secret. Set `ARGOS_SUBSET=true` for scoped runs.

**Argos setup:** enable GitHub OIDC on the mermaid-batched project (Project Settings → Authentication). Do not expose `ARGOS_TOKEN` to this job — it would bypass OIDC.

## Local workflow

```bash
# Capture (requires dev server on :9000)
RUN_VISUAL_TEST=true CYPRESS_useArgos=true \
  pnpm exec cypress run --spec 'cypress/integration/rendering/treemap/**'

# Composite sheets
pnpm run argos:batch
```

## Configuration

| Env var                 | Default                | Description                   |
| ----------------------- | ---------------------- | ----------------------------- |
| `ARGOS_SCREENSHOT_DIR`  | `cypress/screenshots`  | Input directory               |
| `ARGOS_SHEETS_DIR`      | `cypress/argos-sheets` | Output directory              |
| `ARGOS_TILES_PER_SHEET` | `12`                   | Max tiles per composite sheet |
| `ARGOS_SHEET_COLS`      | `3`                    | Grid columns per sheet        |

CI upload targets the **mermaid-batched** Argos project with GitHub OIDC/tokenless auth (no repo secret).

Sheets are grouped by diagram folder (the path prefix before the `*.spec.*` directory segment Cypress inserts). Each sheet has a sibling `.json` manifest listing tile names, positions, and source paths for traceability.
