# Agent Protocol

## Single Frame: Agent v2

Run from the repository root:

```bash
npm run --silent cli -- agent-prepare --input <00-input> --json
npm run --silent cli -- agent-begin <jobId> --json
npm run --silent cli -- agent-status <jobId> --json
npm run --silent cli -- agent-inspect <jobId> --node <sourceNodeId> --json
npm run --silent cli -- agent-inspect <jobId> --asset <assetId> --json
npm run --silent cli -- agent-finalize <jobId> --json
```

Use `--job-root` consistently when preparation used a non-default root.

The v2 state machine is:

```text
preparing -> awaiting-agent -> validating -> done
                                     \----> first-pass-invalid
```

Core performs only deterministic work: input validation, normalization, layout-sketch derivation, HTML prototype rendering, asset copying, static/runtime validation, screenshots, publication, and packaging. It does not call an SDK/API, load model configuration, download fonts, or trigger a second Agent pass.

Preparation creates:

```text
01-normalized/**
02-layout/layout-sketch.json
agent/manifest.json
agent/context-index.json
agent/agent-generation-playbook.md
agent/constraint-pack.md
agent/generation-brief.md
agent/prototype-manifest.json
agent/prototype-validation.json
agent/prototype-source/{index.html,styles.css,script.js}
agent/draft/{index.html,styles.css,script.js,assets/**}
```

Preparation validates the deterministic draft before handoff and writes `prototype-validation.json`. A baseline error stops preparation instead of asking the Agent to repair Core omissions.

Read `generation-brief.md`, `agent-generation-playbook.md`, `constraint-pack.md`, `layout-sketch.json`, `prototype-manifest.json`, `prototype-validation.json`, `frame-screenshot.png`, and `source-texts.json`. The draft is the implementation starting point; the playbook defines the component, asset, interaction, and assembly review method; the constraint pack is the only normative page constraint source; indexed facts are on-demand decision evidence.

Call `agent-begin` immediately before editing; it is idempotent and preserves the first start time. Internally complete the role reviews and conflict decisions, then apply them directly to the existing draft. Do not output intermediate role plans, Assembly Markdown, or reasoning. Only edit the three draft code files. Preserve source, text, style, and asset bindings. Never modify fact files, `prototype-source/`, or `draft/assets/`.

Call `agent-finalize` once. It copies the draft unchanged to `05-first-pass`, validates it, captures review-only screenshots/diffs when Chrome is available, and always writes `final/first-pass.zip`. It never calls `applySafeStaticFixes()` and never enters a repair loop. A valid result is atomically copied to `05-output` and packaged as `final/output.zip`; an invalid result becomes `first-pass-invalid` and preserves any previous valid output.

Timing fields are:

```json
{
  "prepareMs": 0,
  "handoffWaitMs": 0,
  "agentMs": 0,
  "finalizeMs": 0,
  "activeTotalMs": 0,
  "jobWallMs": 0
}
```

`handoffWaitMs` is excluded from `activeTotalMs`. Missing Chrome makes screenshot/runtime checks `skipped`, not blocking.

`agent-accept-plan` is deprecated for v2 and returns `{ "deprecated": true, "noOp": true }`.

## Multiple Frames: Agent v1

`agent-prepare-pages` remains v1 during the initial rollout:

```bash
npm run --silent cli -- agent-prepare-pages --input <page-bundle> --json
npm run --silent cli -- agent-batch-status <batchId> --json
npm run --silent cli -- agent-accept-plan <jobId> --json
npm run --silent cli -- agent-finalize <jobId> --json
```

Process pages sequentially through `nextPage`. Each v1 page still uses `implementation-plan.json`, `awaiting-codex`, and `needs-repair`; its established validation and repair behavior is unchanged. Do not apply the v2 single-pass contract to a v1 batch job.
