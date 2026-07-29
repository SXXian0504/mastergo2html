---
name: mastergo2html
description: Convert MasterGo frames or 00-input exports into HTML/CSS/JS by using the local mastergo2html CLI. Use when the user asks Codex to generate HTML from a MasterGo frame/page, use the current MasterGo selection, convert a 00-input.zip export, process an exported 00-input directory, or inspect/check the local MasterGo2HTML CLI path.
---

# Mastergo2html

## Default Workflow

Use the local repository CLI as the only generation interface. The CLI is not assumed to be installed globally; run it from the project root with `npm run --silent cli -- ...`.

For normal Codex-driven MasterGo D2C, prefer the official MasterGo MCP input workflow:

```text
Codex CLI -> official MasterGo MCP -> current selection/node
  -> build 00-input with raw.json, asset-manifest.json, frame-screenshot.png, assets/**
  -> CLI D2C generate workflow
```

1. Run `npm run --silent cli:doctor -- --json` from the project root. If it reports missing LLM config, tell the user to configure the model environment used by the project.
2. Decide the source:
   - If the user asks to use the current MasterGo selection or a MasterGo node id, use the MasterGo MCP input workflow below.
   - If the user provides a `*-00-input.zip` file or an extracted `00-input/` directory, use the static input workflow below.
   - Use the legacy MasterGo plugin export workflow only as a fallback or quality comparison path.
3. Report the final JSON fields: `jobId`, `htmlPath`, `outputDir`, and `zipPath`.
4. If generation fails, report the CLI error and `jobId` if present. The job record is written under `.mastergo2html/jobs/<jobId>/job.json`.

## MasterGo MCP Input Workflow

Use this path for normal generation from a currently connected MasterGo official MCP server. It avoids asking the user to open the legacy MasterGo plugin UI.

Before running the generation command, make sure:

1. MasterGo is open and connected to Codex through the official MasterGo MCP.
2. The official MCP local endpoint is reachable. The current default endpoint is `http://localhost:50678`.
3. The target Frame is selected in MasterGo, unless the user provides an exact `--node-id`.
4. If the official MCP endpoint requires a key, configure it globally for Codex or pass it with `--mcp-access-key`.

Run:

```bash
npm run --silent cli -- generate --source mastergo-mcp --mcp-url http://localhost:50678 --json
```

Equivalent explicit command:

```bash
npm run --silent cli -- generate-from-mastergo-mcp --mcp-url http://localhost:50678 --json
```

When the user provides or asks to use an exact MasterGo node id:

```bash
npm run --silent cli -- generate --source mastergo-mcp --mcp-url http://localhost:50678 --node-id "<node-id>" --json
```

Use `--node-id` when available; it is more reliable than name matching. If no selector is provided, the MCP path uses the current MasterGo selection.

The MCP input workflow first writes a generated `00-input` directory under `.mastergo2html/mastergo-mcp/<timestamp>/00-input`, then runs the existing CLI analysis and HTML generation phases. The generated input should contain `raw.json`, `asset-manifest.json`, `export-options.json`, `frame-screenshot.png`, and optional `assets/**`.

If the MCP server uses non-default tool names, inspect tools first:

```bash
npm run --silent cli -- mcp:list-tools --mcp-url http://localhost:50678 --json
```

Then pass explicit tool names as needed:

```bash
npm run --silent cli -- generate --source mastergo-mcp \
  --mcp-url http://localhost:50678 \
  --code-tool "<selection-tool>" \
  --image-tool "<selection-image-tool>" \
  --original-image-tool "<image-ref-export-tool>" \
  --node-slice-tool "<node-export-tool>" \
  --json
```

Optional flags:

```bash
--mcp-access-key <key>
--no-original-images
--no-rendered-slices
--output <00-input-dir>
```

If `mcp:list-tools` or `generate --source mastergo-mcp` fails because the spawned `@mastergo/vibe-mcp` process exits, tell the user to verify the Codex global MasterGo MCP configuration and access key. The Codex app may already have a working managed MCP connection, while this repository CLI still needs the same endpoint/key to spawn its own MCP client process.

## Static Input Workflow

Use this path when the user already has a static input package. Prefer a `*-00-input.zip` file. Also accept an already extracted `00-input/` directory.

Optionally validate the export before generation:

```bash
npm run --silent cli -- validate-input --input <00-input.zip-or-directory> --json
```

Generate with:

```bash
npm run --silent cli -- generate --input <00-input.zip-or-directory> --json
```

## Legacy MasterGo Plugin Export Workflow

Use this path only as a fallback or for quality comparison with the old plugin-side export logic. It requires the user to open the local MasterGo plugin window because the plugin polls the local bridge for export requests.

```text
Codex CLI -> local bridge -> MasterGo plugin -> mg.document.currentPage.selection
  -> scanSelection -> serializeRoots -> exportAssets -> exportFrameScreenshot
  -> 00-input -> CLI D2C generate
```

Before running the legacy command, make sure:

1. MasterGo is open.
2. The local MasterGo plugin window is open.
3. The target frame is selected in MasterGo, unless the user provides `--frame` or `--node-id`.

Run:

```bash
npm run --silent cli -- generate-from-mastergo --json
```

When the user names a frame:

```bash
npm run --silent cli -- generate-from-mastergo --frame "<frame-name>" --json
```

When the user provides an exact MasterGo node id:

```bash
npm run --silent cli -- generate-from-mastergo --node-id "<node-id>" --json
```

For manual bridge debugging only:

```bash
npm run mcp:dev
```

If automatic bridge startup fails, tell the user to run `npm run mcp:dev` manually to inspect startup errors. If `generate-from-mastergo` times out, tell the user to keep the MasterGo plugin window open and select exactly one full page Frame for HTML generation.

## Task Management

Use these commands when needed:

```bash
npm run --silent cli -- list --json
npm run --silent cli -- status --latest --json
npm run --silent cli -- status <jobId> --json
npm run --silent cli -- cancel <jobId> --json
npm run --silent cli -- retry <jobId> --json
npm run --silent cli -- serve <jobId> --json
```

When the user wants to view the result, prefer the localhost preview server instead of opening `index.html` directly. Run `npm run cli -- serve <jobId>` in a foreground terminal and report the printed URL.

## Input Contract

The CLI D2C workflow consumes a `00-input` package. The input directory should contain:

```text
00-input/raw.json
00-input/asset-manifest.json
00-input/export-options.json
00-input/frame-screenshot.png
00-input/assets/**       # optional static assets
```

`asset-manifest.json` is the source of truth for resource paths. HTML generation must only reference resource paths that exist in the normalized asset index or manifest.
