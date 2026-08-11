---
name: mastergo2html
description: Convert MasterGo frames, current selections, page bundles, or plugin 00-input exports into HTML/CSS/JS with the local mastergo2html CLI. Use for MasterGo design-to-HTML generation, current-selection conversion, output inspection, static validation reporting, or the first stage of the MasterGo2Code pipeline. Default to the legacy CLI-orchestrated workflow with the Codex SDK as its text-generation backend; use the current Codex task as the direct file-generating agent only when explicitly requested.
---

# MasterGo2HTML

Use the legacy CLI-orchestrated workflow with `LLM_BACKEND=codex-sdk` by default. The CLI owns the complete analysis, planning, HTML generation, validation, retry, and page-batch lifecycle; the Codex SDK is only its text-generation backend. Read [mastergo2html_CLI.md](mastergo2html_CLI.md) for input adapters, commands, timeout policy, quality gates, and troubleshooting. Read [references/codex-agent-protocol.md](references/codex-agent-protocol.md) only when the user explicitly requests the direct Codex Agent workflow.

## Execution mode routing

When this Skill is invoked from Codex, including through `$mastergo2html`, a Skill chip, or a natural-language request in a Codex task, run the legacy `generate*`/`retry` CLI workflow and explicitly set `LLM_BACKEND=codex-sdk`. The input source does not change the execution mode: current selections, static `00-input` packages, Magic DSL packages, and page bundles all continue through the same CLI-controlled model phases.

The default Codex SDK route starts an independent SDK thread and uses the local Codex CLI login. It does not reuse the current Codex desktop task's context, and it must remain a text-only backend: the repository CLI supplies prompts and consumes returned artifacts while retaining control of the workflow.

Use the direct Codex Agent `agent-*` workflow only when the user explicitly requests Agent mode, current-task direct generation, or direct editing of the draft files. Do not switch to Agent mode merely because a legacy generation command is slow, returns a transient error, or needs visual improvement; retry the existing legacy job or batch instead.

Run CLI commands from a repository that contains `core/src/job-service.js`, the requested `generate*` command in `cli/src/index.js`, and the Codex SDK adapter at `mcp-server/src/llm/codex-sdk.js`. On this machine, use this default repository whenever the current workspace fails that capability check:

```text
/Users/xiansongxin/Documents/MasterGo/code/mastergo_plugin/mastergo2json
```

Before the first generation command, run `LLM_BACKEND=codex-sdk npm run --silent cli:doctor -- --json`. If the SDK, Codex executable, login, or supported Node.js runtime is unavailable, report that concrete prerequisite failure. Do not silently switch to an API-key backend or Agent mode.

## Default Legacy + Codex SDK workflow

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
2. For one current Frame run `generate-from-mastergo`; for a static package run `generate --input`; for a page bundle run `generate-pages --input`. Keep `--export-timeout-ms 600000` on plugin export commands.
3. Let the CLI execute the complete legacy phase contract. Do not replace its layout, component, asset, interaction, or combined plan-and-generate phase with current-task reasoning.
4. On transient failure, retry the same `jobId` from its recorded phase. For page batches, use `resume-pages` and preserve completed page outputs.
5. At a page-batch `quality-gate`, compare the representative HTML outputs with their Frame screenshots before using `--approve-quality`; use `--retry-quality` when generation quality is insufficient.
6. Inspect and report every final `05-output/static-validation.json`, plus `jobId`, `batchId` when applicable, output paths, validation findings, and blocked pages.

Keep the foreground tool timeout above the 40-minute phase timeout; prefer 60 minutes. Do not treat a local foreground timeout as proof that the underlying job stopped: inspect `status` and resume or retry the same persisted job.

## Explicit Codex Agent alternative

Only when the user explicitly requests Agent mode, follow [references/codex-agent-protocol.md](references/codex-agent-protocol.md). In that mode the current Codex task performs planning, direct HTML/CSS/JS file authoring, and targeted repair while the CLI performs deterministic preparation and validation.

Do not run `agent-prepare`, `agent-prepare-pages`, `agent-accept-plan`, or `agent-finalize` in the default route. Conversely, once explicit Agent mode starts, do not mix legacy model phases into that job.

## Shared constraints

The legacy prompts and validators consume the shared constraint registry through the CLI. Do not bypass, duplicate, or manually substitute those phase prompts. In explicit Agent mode, treat the generated `agent/constraint-pack.md` as the only page-generation constraint source and follow its version/hash contract.

Read the detailed visual playbooks only when a matching `reviewRequired` constraint cannot be resolved from indexed evidence:

- [Decorative glow and SVG canvas](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)
- [Compact rounded surfaces and hover](../../docs/COMPACT_ROUNDED_SURFACE_PLAYBOOK.md)
- [Responsive design stability](../../docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md)
