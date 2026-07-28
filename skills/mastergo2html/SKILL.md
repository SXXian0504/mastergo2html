---
name: mastergo2html
description: Convert MasterGo plugin 00-input exports into HTML/CSS/JS by using the local mastergo2html CLI. Use when the user asks Codex to generate HTML from a MasterGo frame/page, convert a 00-input.zip export, process an exported 00-input directory, or inspect/check the local MasterGo2HTML CLI path.
---

# Mastergo2html

## Workflow

Use the local CLI as the only generation interface. Do not call the legacy local HTTP bridge for Codex-driven generation.

1. Run `npm run --silent cli:doctor -- --json` from the project root. If it reports missing LLM config, tell the user to configure the model environment used by the project.
2. Locate the user's MasterGo plugin export. Prefer a `*-00-input.zip` file. Also accept an already extracted `00-input/` directory.
3. Optionally validate the export before generation:

```bash
npm run --silent cli -- validate-input --input <00-input.zip-or-directory> --json
```

4. Generate with:

```bash
npm run --silent cli -- generate --input <00-input.zip-or-directory> --json
```

5. Read the final JSON object and report `htmlPath`, `outputDir`, and `zipPath`.
6. If generation fails, report the CLI error and `jobId` if present. The job record is written under `.mastergo2html/jobs/<jobId>/job.json`.

Use these task-management commands when needed:

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

The first CLI version supports only plugin-exported static input packages. The ZIP should contain `00-input/raw.json`, `00-input/asset-manifest.json`, `00-input/export-options.json`, `00-input/frame-screenshot.png`, and optional `00-input/assets/**`.

Do not attempt to resolve natural-language frame names yet. If the user asks for a page name such as "首页-pc" without providing a 00-input export, ask them to export static resources from the MasterGo plugin first.
