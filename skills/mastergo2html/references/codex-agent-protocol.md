# Codex Agent Protocol

## Contents

- Commands
- State machine
- Planning contract
- Shared constraint contract
- Context policy
- Direct-file generation
- Repair and publication
- Page batches

## Commands

Run from the repository root:

```bash
npm run --silent cli -- agent-prepare --input <00-input> --json
npm run --silent cli -- agent-prepare --source mastergo-plugin --export-timeout-ms 600000 --json
npm run --silent cli -- agent-prepare-pages --input <page-bundle> --json
npm run --silent cli -- agent-prepare-pages --source mastergo-plugin --export-timeout-ms 600000 --json
npm run --silent cli -- agent-status <jobId> --json
npm run --silent cli -- agent-inspect <jobId> --module <moduleId> --json
npm run --silent cli -- agent-inspect <jobId> --node <sourceNodeId> --json
npm run --silent cli -- agent-inspect <jobId> --asset <assetId> --json
npm run --silent cli -- agent-inspect <jobId> --issues --json
npm run --silent cli -- agent-accept-plan <jobId> --json
npm run --silent cli -- agent-finalize <jobId> --json
npm run --silent cli -- agent-batch-status <batchId> --json
```

Use `--job-root` or `--batch-root` consistently when preparation used a non-default root.

## State machine

```text
planning / awaiting-codex
  -> generation / awaiting-codex
  -> repair / needs-repair -> generation validation
  -> done / done
```

The CLI performs deterministic input preparation, normalization, schema validation, runtime validation, atomic publication, and packaging. The current Codex task performs planning, HTML/CSS/JS authoring, and targeted repairs.

## Planning contract

Files under `<job>/agent/`:

```text
manifest.json
context-index.json
module-index.json
constraint-pack.md
constraint-manifest.json
implementation-plan.template.json
implementation-plan.json
draft/index.html
draft/styles.css
draft/script.js
validation.json
```

Create exactly one `implementation-plan.json`. Start from the template and complete every module and every prefilled `constraintDecisions` entry. Use only source node IDs and asset IDs exposed by the indexes. Supply nonempty page-level responsive decisions, module implementation notes, interaction booleans, and a complete implementation order.

`agent-accept-plan` validates the canonical plan and derives legacy Markdown compatibility views deterministically. Do not author or re-read those compatibility views as independent reasoning inputs.

## Shared constraint contract

Read `constraint-pack.md` once as an `always` context file. It is a compact projection of the structured registry used by both Agent and legacy workflow prompts. Do not open the six legacy prompt builders to reconstruct rules.

Keep `constraintPackVersion` and `constraintPackHash` unchanged in the plan. For every prefilled constraint ID, record a concrete decision and only the source node IDs needed as evidence. The CLI rejects missing decisions, unknown evidence, version mismatch, and pack drift.

Final validation reports `constraintCoverage`: applicable, acknowledged, machine-enforced, review-required, uncovered IDs, and overall status. A reported machine-enforced count means the corresponding deterministic validator/finalizer ran; review-required items still need visual judgment.

## Context policy

Read `manifest.json` and `context-index.json` first. Read every `priority: always` file at most once unless its recorded SHA-256 changes. Treat `priority: on-demand` files as indexed evidence, not mandatory prompt context.

Use `module-index.json` for the page overview. Call `agent-inspect` when one module, source node, asset, or validation report requires more detail. Do not serialize the complete normalized tree into messages, plans, or batch manifests.

The input hash is immutable. If `00-input` changes after preparation, stop and create a new job; the CLI intentionally rejects fact drift.

## Direct-file generation

Write these files directly:

```text
agent/draft/index.html
agent/draft/styles.css
agent/draft/script.js
```

Do not emit `{ "indexHtml": ..., "stylesCss": ..., "scriptJs": ... }`, fenced JSON, or any other large code envelope. The finalizer reads the three files independently, so JSON parsing is not part of code transport. Small control JSON remains schema-validated.

Reference local assets through paths allowed by the generated context and existing validators. Do not write directly into `05-output`; publication occurs only after validation.

## Repair and publication

`agent-finalize` copies the draft into a temporary output, applies safe static fixes, runs static/smoke/responsive validation, and publishes atomically only when validation passes. A failed attempt records `agent/validation.json`, returns `needs-repair`, deletes the temporary output, and preserves any previous valid `05-output`.

Inspect issues, edit the existing direct files, and finalize again. Do not regenerate unrelated modules or repeat unchanged context.

Successful validation records:

```json
{
  "transport": {
    "mode": "direct-files",
    "jsonEnvelopeParsed": false
  }
}
```

## Page batches

`agent-prepare-pages` creates `.mastergo2html/agent-batches/<batchId>/batch.json` and one independent job per Frame. The batch stores job/context paths, not embedded page contexts.

Process the batch sequentially by `nextPage`:

1. Finish or repair its referenced job.
2. Run `agent-batch-status <batchId>`.
3. Open the next page context only after the previous page is done.

This keeps peak context bounded to one page and prevents repeated all-page serialization. A page failure does not erase completed page outputs. Once all pages are done, the batch exposes `mergePrepareCommand` for the route-aware React handoff.
