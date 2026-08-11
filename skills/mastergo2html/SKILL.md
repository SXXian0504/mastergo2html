---
name: mastergo2html
description: Convert MasterGo frames, current selections, page bundles, or plugin 00-input exports into HTML/CSS/JS with the local mastergo2html CLI. Use for MasterGo design-to-HTML generation, current-selection conversion, output inspection, static validation reporting, or the first stage of the MasterGo2Code pipeline. When invoked inside Codex, default to the current Codex task as the agent and use the agent-* workflow; use legacy standalone model generation only when the user explicitly requests it.
---

# MasterGo2HTML

Use the current Codex task as the planner and code generator by default. Read [references/codex-agent-protocol.md](references/codex-agent-protocol.md) for the exact file and state contract. Read [mastergo2html_CLI.md](mastergo2html_CLI.md) only for input adapters, legacy standalone generation, or detailed CLI troubleshooting.

## Execution mode routing

When this Skill is invoked from Codex, including through `$mastergo2html`, a Skill chip, or a natural-language request in a Codex task, always use the Codex Agent workflow below. The input source does not change the execution mode: `--source mastergo-plugin` uses the local plugin bridge only to export selection data; it does not authorize the legacy model workflow, a project API key, `codex exec`, or a Codex SDK thread.

Enter legacy standalone mode only when the user explicitly asks for plugin-standalone, legacy automatic generation, or generation without an active Codex task. Do not infer legacy mode from the `mcp-server` directory name, an installed SDK, existing model configuration, or legacy modules imported by the CLI.

Run Agent CLI commands only from a repository that contains both `core/src/agent-workflow.js` and an `agent-prepare` command in `cli/src/index.js`. Merely finding `cli/src/index.js` is insufficient because an older worktree can contain only the legacy CLI. Check these files before the first CLI invocation. On this machine, use this default repository whenever the current workspace fails that capability check:

```text
/Users/xiansongxin/Documents/MasterGo/code/mastergo_plugin/mastergo2json
```

If an Agent command fails before dispatch because an eagerly imported legacy module or `@openai/codex-sdk` is missing, treat that as a stale or incorrectly packaged CLI. Switch to the Agent-capable repository or report the packaging defect. Do not install or configure a model SDK merely to make the Codex Agent path start.

## Default Codex Agent workflow

Do not run `doctor`, configure a project API key, invoke `codex exec`, or start a Codex SDK thread for this path. The current Codex task supplies the reasoning.

1. Prepare one Frame with `agent-prepare`, or a page bundle with `agent-prepare-pages`.
2. Read `agent/manifest.json`, then read each `always` entry in `agent/context-index.json` once. Use `agent-inspect` for only the module, node, asset, or issues needed next.
3. Fill the single canonical `agent/implementation-plan.json` from its template. Do not create parallel role plans or repeat the full normalized tree.
4. Run `agent-accept-plan <jobId>`.
5. Write `agent/draft/index.html`, `styles.css`, and `script.js` directly. Do not return their contents in a JSON envelope or edit `05-output`.
6. Run `agent-finalize <jobId>`. On `needs-repair`, inspect `agent/validation.json`, edit only the draft files implicated by its errors, and finalize again.
7. For a page batch, finish `nextPage` before opening another page's full context; refresh with `agent-batch-status <batchId>`.

After finalization, inspect and report `05-output/static-validation.json`. Preserve the generated output for screenshot review and downstream React conversion.

## Legacy standalone mode

The MasterGo plugin remains usable. Its existing one-click button and HTTP job contracts continue through the shared legacy job service and can generate without an active Codex task. That compatibility path still requires the configured OpenAI-compatible API or Codex SDK backend.

Only when the user explicitly asks for plugin-standalone/legacy automatic generation, follow the model configuration, timeout, and retry policy in [mastergo2html_CLI.md](mastergo2html_CLI.md). Reuse the same `jobId` on retry:

```bash
npm run --silent cli -- retry <jobId> --json
```

## Shared constraints

Treat the generated `agent/constraint-pack.md` as the only page-generation constraint source. Read it once through `context-index.json`, complete every decision in the plan template, and do not restate its rules in the Skill, plan, or conversation. The pack is compiled from the same registry used by legacy prompts and validators; the CLI rejects version or hash drift.

Read the detailed visual playbooks only when a matching `reviewRequired` constraint cannot be resolved from indexed evidence:

- [Decorative glow and SVG canvas](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)
- [Compact rounded surfaces and hover](../../docs/COMPACT_ROUNDED_SURFACE_PLAYBOOK.md)
- [Responsive design stability](../../docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md)
