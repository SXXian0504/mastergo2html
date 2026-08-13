# Agent Protocol

## Single Frame: Agent v2

“Single Frame” is the compatibility baseline. One Agent v2 job may also contain an exact desktop/mobile responsive pair named `<base>` and `<base>-移动端`. That extension still has one editable desktop-derived draft, one current-Agent edit, and one finalize. Mobile facts live under `variants/mobile`, the reference prototype is read-only, and `responsive-context.json` defines canonical aliases and mobile-only requirements.

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
preparing -> awaiting-agent -> agent-running -> validating -> done
                                                        \----> first-pass-invalid
```

Core performs only deterministic work: input validation, normalization, layout-sketch derivation, hybrid flow HTML prototype rendering, asset copying, static/runtime validation, screenshots, publication, and packaging. It does not call an SDK/API, load model configuration, download fonts, or trigger a second Agent pass.

The prototype uses confidence-gated structure. Core places high-confidence page modules in document flow, groups equal-size/equal-gap repeated roots as Grid/Flex collections, maps explicit MasterGo Auto Layout containers to Flex, and retains local absolute positioning for uncertain overlapping or decorative regions. `prototype-manifest.json.flowSkeleton` records every flow decision and fallback.

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

Call `agent-begin` immediately before editing; it is idempotent and preserves the first start time. Internally complete the role reviews and conflict decisions, then apply them directly to the existing draft. Preserve Core's flow modules, repeated-list collections, and explicit Auto Layout boundaries unless source facts require a different grouping. Add semantic HTML, whole-component interactions, responsive reflow, accessibility, and visual refinement; do not regress the complete page to a fixed canvas or root scaling. Do not output intermediate role plans, Assembly Markdown, or reasoning. Only edit the three draft code files. Preserve source, text, style, and asset bindings. Never modify fact files, `prototype-source/`, or `draft/assets/`.

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

## Multiple Frames: Agent v2 logical-page batch

`agent-prepare-pages` defaults to v2:

```bash
npm run --silent cli -- agent-prepare-pages --input <page-bundle> --agent-concurrency 2 --agent-retries 1 --json
npm run --silent cli -- agent-batch-status <batchId> --json
npm run --silent cli -- agent-claim-pages <batchId> --limit 2 --json
npm run --silent cli -- agent-begin <jobId> --claim-id <claimId> --job-root <jobRoot> --json
npm run --silent cli -- agent-finalize <jobId> --claim-id <claimId> --job-root <jobRoot> --json
npm run --silent cli -- agent-requeue-page <batchId> --job-id <jobId> --claim-id <claimId> --reason <reason> --json
npm run --silent cli -- agent-resume-pages <batchId> --json
```

The batch consumes `mastergo2html.page-bundle.v2`, whose pages are either `single-page` or `responsive-page`. A responsive logical page contains one existing `mastergo2html.responsive-page.v1` directory and therefore still produces one draft, one DOM, and one finalize. Page-bundle v1 remains accepted and maps every entry to a single-page v2 job.

New batches default to two concurrent Agent Workers and one retry. `--agent-concurrency` accepts `1..3`; `--agent-retries` accepts `0..2`. Resume resolution is explicit CLI value, then stored batch setting, then the command default. Legacy v2 batches without scheduler settings resume with concurrency one so an upgrade cannot silently parallelize an in-flight batch. Deterministic page preparation is capped at two concurrent preparations and persists every assigned `jobId` immediately.

The main Agent owns scheduling:

1. Call `agent-claim-pages` with the number of free Worker slots. It atomically claims at most the stored concurrency limit and returns isolated handoffs in `claimedPages[]`; `nextPage` remains a compatibility alias only.
2. Delegate each handoff to a separate child Worker. A Worker receives only one page context, must not spawn or delegate to another Agent, and may edit only `agent/draft/index.html`, `styles.css`, and `script.js` in that job.
3. The Worker runs the returned begin command immediately before editing and the returned finalize command once. Both carry the claim ID. Responsive desktop/mobile pairs remain one Worker, one DOM, and one finalize.
4. When any Worker finishes, refresh `agent-batch-status` and immediately claim a replacement for the free slot. Do not wait for all Workers in a wave.
5. Requeue only after the main Agent confirms the Worker terminated. There is no timeout lease because valid edits may run for more than 80 minutes. A failure before begin releases the claim without spending a retry; a failure after begin restores only the three draft files from `prototype-source` and spends one retry. Exceeding the limit makes that page `error`.
6. Never let a Worker modify the React merge project. Run `mergePrepareCommand` serially only after every page is terminal and the batch is eligible to merge.

`readyPages[]` contains unclaimed work. `activePages[]` contains claimed, `agent-running`, and `validating` work. Summary fields distinguish `claimed`, `agentRunning`, `validating`, `done`, `firstPassInvalid`, and `error`. `done`, `first-pass-invalid`, and `error` are terminal page states. A first-pass validation failure is not retried; other pages continue and the batch ends as `partial-failure`. Finalize may resume idempotently from `validating` without repeating the Agent edit.

Use `agent-prepare-pages --agent-version v1` for explicit compatibility with the old `implementation-plan.json`, `agent-accept-plan`, `awaiting-codex`, and `needs-repair` protocol. Existing v1 batch files remain readable and are never migrated in place.
