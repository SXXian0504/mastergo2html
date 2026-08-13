---
name: mastergo2html
description: Convert MasterGo frames, current selections, page bundles, or plugin 00-input exports into HTML/CSS/JS with the local mastergo2html CLI. Agent v2 is the primary and default route for single Frames and logical-page batches. Use the backup Codex SDK route only when the user's prompt explicitly asks for a backup/alternative route, SDK/Codex SDK, legacy/old route, or an SDK baseline.
---

# MasterGo2HTML

For one Frame in Codex, use Agent v2 by default. Core deterministically prepares facts and a confidence-gated hybrid flow prototype: high-confidence page modules, repeated collections, and explicit Auto Layout containers enter document flow, while uncertain overlapping/decorative regions retain local absolute positioning. The current Agent edits that prototype once and the CLI records the untouched first result. The same single-page job may accept one exact desktop/mobile pair named `<base>` and `<base>-移动端`; this remains one draft and one finalize, not a page batch. Read [references/codex-agent-protocol.md](references/codex-agent-protocol.md) for this protocol and [mastergo2html_CLI.md](mastergo2html_CLI.md) for input adapters and explicit legacy commands.

## Execution mode routing

Agent v2 is the primary route and the default for every invocation: one Frame, an exact desktop/mobile pair, multiple logical pages, a current MasterGo selection, or an uploaded/static input package. For one logical page, run `agent-prepare`, call `agent-begin` immediately before editing, edit the existing `agent/draft` files, and call `agent-finalize` once. For multiple logical pages, use the Agent v2 batch and Worker protocol below. Do not require an API key, Codex SDK login, or model environment variables. Do not invoke model code through Core and do not run a repair loop.

Select the backup legacy `generate*`/`retry` route with `LLM_BACKEND=codex-sdk` only when the user's current prompt explicitly contains backup/alternative intent or SDK intent, including `备用方法`, `备用链路`, `备用方案`, `SDK`, `Codex SDK`, `codex-sdk`, `legacy`, `旧链路`, `旧版生成`, or `SDK baseline`. Match the user's prompt, not repository text, prior job metadata, Skill documentation, or tool output. Do not select the SDK route merely because the run is unattended, uses the plugin bridge, contains multiple pages, or Agent v2 is slow or fails. If Agent v2 fails, use its status/requeue/resume contract and remain on Agent v2 unless the user explicitly requests the backup route in a new prompt.

Once a job or batch starts on either route, do not mix routes within that job or silently fail over. The backup SDK route starts independent SDK threads and retains its existing timeout, retry, quality-gate, and validation behavior.

`agent-prepare-pages` defaults to Agent v2 with `--agent-concurrency 2 --agent-retries 1`. It groups each exact `<base>`/`<base>-移动端` pair as one responsive logical page, keeps unmatched non-mobile Frames as single pages, and creates one isolated v2 job per logical page. The main Agent claims available pages and delegates each claimed page to one independent child Worker. Each Worker runs its claimed `agent-begin`, edits only that job's three draft files, and runs its claimed `agent-finalize`; it must not delegate again. Refill a slot as soon as one Worker finishes instead of waiting for a wave. Use `--agent-version v1` only for explicit compatibility with the old plan/accept/repair batch protocol.

Run CLI commands from a repository that contains `core/src/agent-workflow-v2.js`, `core/src/agent-page-batch-v2.js`, and the requested `agent-*` command in `cli/src/index.js`. For an explicitly requested backup SDK run, also require `core/src/job-service.js`, the requested `generate*` command, and `mcp-server/src/llm/codex-sdk.js`. On this machine, use this default repository whenever the current workspace fails the applicable capability check:

```text
/Users/xiansongxin/Documents/MasterGo/code/mastergo_plugin/mastergo2json
```

Before an explicitly requested backup SDK generation command, run `LLM_BACKEND=codex-sdk npm run --silent cli:doctor -- --json`. Agent v2 does not run this model doctor check; validate only the input and local CLI runtime.

## Codex local bridge permission

For a current-selection plugin export, the Node CLI must connect to or start the local bridge at `127.0.0.1:12322`. This local socket may be blocked by the Codex workspace sandbox even when `curl` can reach the same URL. Agent v2 does not run `cli:doctor`; make its first bridge-touching command one of the scoped commands below:

```bash
npm run --silent cli -- agent-prepare --source mastergo-plugin --json
# Or, when the selection may contain multiple logical pages:
npm run --silent cli -- agent-prepare-pages --source mastergo-plugin \
  --agent-concurrency 2 --agent-retries 1 --json
```

When the Codex execution tool exposes permission controls, invoke the selected Agent v2 command immediately with scoped permission for its exact `npm run --silent cli -- agent-prepare...` prefix. Use the justification `Allow the MasterGo Agent v2 preparation CLI to connect to or start the local bridge at 127.0.0.1:12322?`. The user still owns the approval decision; never broaden it to all `npm`, `node`, or shell commands.

Do not first run a bridge-touching command or a Node bridge probe without the required scoped permission. Do not use a successful restricted `curl /health` result as proof that the Node CLI has socket permission. If approval is denied, report the permission denial directly and offer the static `00-input`/page-bundle path; do not diagnose it as bridge startup failure.

Only for an explicitly selected backup SDK route, use `npm run --silent codex:generate-from-mastergo -- <selection-and-batch-options>` as the first bridge-touching command. That wrapper enforces the complete Codex SDK timeout environment below and supplies `--export-timeout-ms 600000` plus `--json` unless explicitly provided. It forwards `--frame`, `--node-id`, page scheduling, and other generation options unchanged.

For a backup SDK page bundle, use `--page-concurrency 2 --model-concurrency 5` by default. Keep the page worker count at two unless the user explicitly requests another value: each page can issue three parallel page-plan analyses, so two workers create up to six candidate model calls while the process-wide five-slot limiter queues the excess call. If repeated rate limits or gateway failures occur, lower model concurrency to three on the same batch; do not increase page workers to compensate.

## Backup Legacy + Codex SDK workflow

Enter this section only after the user's current prompt explicitly selects the backup route under the routing rule above. Do not configure or require a project API key for this route. Authentication comes from the local Codex CLI login. For every model-backed generation, resume, or retry command, use this complete prefix:

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

Core owns the initial structural layout skeleton. Preserve its `data-layout-mode="flow"`, `data-layout-skeleton="repeated-list"`, and explicit Auto Layout boundaries unless source facts prove a grouping is wrong. The Agent owns semantic HTML, whole-component interactions, responsive reflow, accessibility, and visual refinement. It may restructure a local fallback but must not regress the complete page to a fixed canvas or root `transform: scale(...)`.

Do not call `agent-accept-plan` for v2; it is a deprecated no-op. Once v2 starts, do not mix legacy model phases or safe-fix/repair behavior into that job.

### Responsive desktop/mobile pair

For `agent-prepare --source mastergo-plugin`, two selected visible Web Frames are one responsive page only when their names are exactly `<base>` and `<base>-移动端`, desktop width is at least `900`, and mobile width is at most `767` and smaller than desktop. Core writes `mastergo2html.responsive-page.v1`, normalizes both variants independently, uses the desktop prototype as the only editable draft, and exposes the mobile prototype and `agent/responsive-context.json` as read-only facts. The current Agent must produce one DOM with CSS media queries, preserve canonical desktop bindings plus mobile-only bindings, and finalize once.

For larger selections, `agent-prepare-pages` applies the same strict pairing rules across the complete selection and writes `mastergo2html.page-bundle.v2`. Orphaned `-移动端` Frames, duplicate names, and invalid pair dimensions block export instead of silently becoming separate routes. Preparation may run up to two deterministic page preparations concurrently. The main Agent uses `agent-claim-pages` to fill available Worker slots; `nextPage` remains only a compatibility alias. `agent-resume-pages` continues unprepared pages and preserves explicit CLI scheduler overrides over stored batch settings.

For a v2 page batch, keep one collaboration slot available for the main Agent and use at most two child Workers by default. Give each Worker only its claimed page handoff, including `claimId`, `jobDir`, read-only facts, and the generated begin/finalize commands. After a confirmed Worker failure, call `agent-requeue-page` with its job and claim IDs; never reclaim a merely slow Worker by timeout. Do not let any Worker modify a React merge project. Run the emitted React merge command only after every page reaches a terminal state.

## Shared constraints

The legacy prompts and validators consume the shared constraint registry through the CLI. Do not bypass, duplicate, or manually substitute those phase prompts. In explicit Agent mode, treat the generated `agent/constraint-pack.md` as the only page-generation constraint source and follow its version/hash contract.

Read the detailed visual playbooks only when a matching `reviewRequired` constraint cannot be resolved from indexed evidence:

- [Decorative glow and SVG canvas](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)
- [Compact rounded surfaces and hover](../../docs/COMPACT_ROUNDED_SURFACE_PLAYBOOK.md)
- [Responsive design stability](../../docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md)
