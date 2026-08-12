---
name: mastergo2html
description: Convert MasterGo frames, current selections, page bundles, or plugin 00-input exports into HTML/CSS/JS with the local mastergo2html CLI. In Codex, default single-Frame work to Agent v2: Core creates a deterministic HTML prototype and the current Agent edits it once. Keep legacy Codex SDK generation for explicit legacy, unattended plugin, SDK baseline, and current multi-page workflows.
---

# MasterGo2HTML

For one Frame in Codex, use Agent v2 by default. Core deterministically prepares facts and a source-coordinate HTML prototype; the current Agent edits that prototype once and the CLI records the untouched first result. Read [references/codex-agent-protocol.md](references/codex-agent-protocol.md) for this protocol and [mastergo2html_CLI.md](mastergo2html_CLI.md) for input adapters and explicit legacy commands.

## Execution mode routing

When this Skill is invoked from Codex for one Frame, run `agent-prepare`, call `agent-begin` immediately before editing, edit the existing `agent/draft` files, and call `agent-finalize` once. Do not require an API key, Codex SDK login, or model environment variables. Do not invoke model code through Core and do not run a repair loop.

Use legacy `generate*`/`retry` with `LLM_BACKEND=codex-sdk` only when the user explicitly requests legacy, an unattended plugin generation, or an SDK baseline. The legacy route starts an independent SDK thread and retains its existing timeout, retry, and validation behavior.

`agent-prepare-pages` remains Agent v1 in the first rollout. Follow its existing plan/accept/finalize protocol and process one page at a time. Do not upgrade page batches to the v2 single-pass contract.

Run CLI commands from a repository that contains `core/src/job-service.js`, the requested `generate*` command in `cli/src/index.js`, and the Codex SDK adapter at `mcp-server/src/llm/codex-sdk.js`. On this machine, use this default repository whenever the current workspace fails that capability check:

```text
/Users/xiansongxin/Documents/MasterGo/code/mastergo_plugin/mastergo2json
```

Before an explicit legacy generation command, run `LLM_BACKEND=codex-sdk npm run --silent cli:doctor -- --json`. Agent v2 does not run this model doctor check; validate only the input and local CLI runtime.

## Codex local bridge permission

For a current-selection plugin export, the Node CLI must connect to or start the local bridge at `127.0.0.1:12322`. This local socket may be blocked by the Codex workspace sandbox even when `curl` can reach the same URL. After `cli:doctor`, make the first bridge-touching command the scoped wrapper below:

```bash
npm run --silent codex:generate-from-mastergo -- <selection-and-batch-options>
```

When the Codex execution tool exposes permission controls, invoke this command immediately with `sandbox_permissions: "require_escalated"`. Use the justification `Allow the MasterGo generation CLI to connect to or start the local bridge at 127.0.0.1:12322?` and request the reusable prefix rule `["npm", "run", "--silent", "codex:generate-from-mastergo"]`. The user still owns the approval decision; never broaden it to all `npm`, `node`, or shell commands.

Do not first run this wrapper, the raw `generate-from-mastergo` command, or a Node bridge probe inside the sandbox. Do not use a successful sandboxed `curl /health` result as proof that the Node CLI has socket permission. If approval is denied, report the sandbox permission denial directly and offer the static `00-input`/page-bundle path; do not diagnose it as bridge startup failure.

The wrapper enforces the complete Codex SDK timeout environment below and supplies `--export-timeout-ms 600000` plus `--json` unless explicitly provided. It forwards `--frame`, `--node-id`, page scheduling, and other generation options unchanged.

For page bundles, use `--page-concurrency 2 --model-concurrency 5` by default. Keep the page worker count at two unless the user explicitly requests another value: each page can issue three parallel page-plan analyses, so two workers create up to six candidate model calls while the process-wide five-slot limiter queues the excess call. If repeated rate limits or gateway failures occur, lower model concurrency to three on the same batch; do not increase page workers to compensate.

## Explicit Legacy + Codex SDK workflow

Do not configure or require a project API key for this route. Authentication comes from the local Codex CLI login. For every model-backed generation, resume, or retry command, use this complete prefix:

```bash
LLM_BACKEND=codex-sdk \
LLM_CONNECT_TIMEOUT_MS=900000 \
LLM_IDLE_TIMEOUT_MS=900000 \
LAYOUT_ANALYSIS_TIMEOUT_MS=2400000 \
PAGE_PLAN_TIMEOUT_MS=2400000 \
PLAN_AND_GENERATE_TIMEOUT_MS=2400000 \
npm run --silent cli -- <generate-resume-or-retry-command>
```

1. Resolve and validate the input using the appropriate adapter in [mastergo2html_CLI.md](mastergo2html_CLI.md).
2. For a current selection run the escalated `codex:generate-from-mastergo` wrapper; for a static package run `generate --input`; for an existing page bundle run `generate-pages --input`.
3. Let the CLI execute the complete legacy phase contract. Do not replace its layout, component, asset, interaction, or combined plan-and-generate phase with current-task reasoning.
4. On transient failure, retry the same `jobId` from its recorded phase. For page batches, use `resume-pages` and preserve completed page outputs.
5. At a page-batch `quality-gate`, compare the representative HTML outputs with their Frame screenshots before using `--approve-quality`; use `--retry-quality` when generation quality is insufficient.
6. Inspect and report every final `05-output/static-validation.json`, plus `jobId`, `batchId` when applicable, output paths, validation findings, and blocked pages.
7. In the final handoff, report the preview URL, HTML file, ZIP archive, validation report, and `jobId`, then add a separate clickable `打开 output 文件夹` link whose target is the absolute `outputDir` (normally the job's `05-output` directory). Link to the directory itself, not to `index.html`.

Keep the foreground tool timeout above the 40-minute phase timeout; prefer 60 minutes. Do not treat a local foreground timeout as proof that the underlying job stopped: inspect `status` and resume or retry the same persisted job.

## Default single-Frame Agent v2

Follow [references/codex-agent-protocol.md](references/codex-agent-protocol.md). Preparation must pass `agent/prototype-validation.json` before handing off the draft. The current Agent reads `agent/agent-generation-playbook.md` for the component, asset, interaction, and assembly review method; reads `agent/constraint-pack.md` as the only normative page constraint source; starts from the generated HTML prototype; applies the resulting decisions directly to the three draft files; and finalizes exactly once. Do not generate intermediate role plans or Assembly Markdown. Report the prototype, `05-first-pass`, first-pass ZIP, validation, screenshots/diff status, timing fields, and successful output when present.

Do not call `agent-accept-plan` for v2; it is a deprecated no-op. Once v2 starts, do not mix legacy model phases or safe-fix/repair behavior into that job.

## Shared constraints

The legacy prompts and validators consume the shared constraint registry through the CLI. Do not bypass, duplicate, or manually substitute those phase prompts. In explicit Agent mode, treat the generated `agent/constraint-pack.md` as the only page-generation constraint source and follow its version/hash contract.

Read the detailed visual playbooks only when a matching `reviewRequired` constraint cannot be resolved from indexed evidence:

- [Decorative glow and SVG canvas](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)
- [Compact rounded surfaces and hover](../../docs/COMPACT_ROUNDED_SURFACE_PLAYBOOK.md)
- [Responsive design stability](../../docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md)
