# Acceptance checklist

Apply the common/default checklist to every run. Apply the engineering section only when `profile: engineering` was selected.

## Common source coverage

- [ ] Every source page has one explicit final route.
- [ ] Every route renders source content without iframe/HTML-string embedding.
- [ ] Assets, fonts, source behaviors, dynamic sample URLs, and fallback behavior are accounted for.
- [ ] Every MasterGo route has an immutable Frame screenshot recorded by path, dimensions, and hash.

## Default architecture and styles

- [ ] App Router + TypeScript + `src/` + `@/*` alias.
- [ ] Client directives exist only at interaction boundaries.
- [ ] Backend access, if any, goes through BFF/server-only configuration.
- [ ] Generated/page styles are scoped; no cross-route leakage.
- [ ] Source structure, content, navigation, interactions, accessibility, and responsive behavior are preserved.
- [ ] Header/Nav/Footer family audit covers every route and region exactly once.
- [ ] Every identical or safely parameterizable Header/Nav/Footer family with at least two consumers is extracted under `src/components/layouts/` and actually rendered by all listed consumers.
- [ ] Singleton, incompatible, and absent regions include concrete reasons; cosmetic class/source-node differences are not used to avoid reuse.
- [ ] Every shared-shell consumer passes before/after region comparison at all required viewports with matching dimensions and changed-pixel ratio at or below `0.005` (or the stricter repository threshold).
- [ ] `shared-shell-audit.json` passes `validate_project.py --require-shared-shell-audit`.
- [ ] Ordinary page content may remain page-specific; broader shared-component extraction is not required in default mode.
- [ ] Tailwind, Sass, and Ant Design are not required unless the source implementation needs them.

## Default visual reporting

- [ ] No screenshot-driven React correction or recapture loop was performed.
- [ ] If a final route was captured, it was captured at most once at its Frame width after all routes coexist.
- [ ] Any `<page-id>.json` report uses mode `frame-vs-react-final`, the manifest Frame hash, and matching dimensions; pass/fail is informational.
- [ ] Visual differences are reported as known deviations instead of being manually corrected in default mode.
- [ ] No intermediate React screenshots were produced.

## Common quality gates

- [ ] Structural validator passes with `--profile default` or the selected profile.
- [ ] Install/lockfile, lint, typecheck, tests when present, and production build succeed.
- [ ] Default validation runs without general `--require-visual`; full-page Frame pass/fail is blocking only for engineering or explicit visual correction, while shared-shell regression is always blocking.
- [ ] Missing assets, unresolved behavior, and deliberate deviations are reported.
- [ ] No `href="#"` placeholder remains in converted route markup.
- [ ] No paired element with `data-text-source-node-id` is empty; missing HTML text was restored from normalized source text metadata.
- [ ] Route-changing controls are anchors mapped through an explicit route-intent table, and shared click handlers do not intercept resolved anchors.
- [ ] Controls converted from buttons to anchors explicitly preserve box alignment and suppress default link decoration.
- [ ] Route links pass a hit-target review: no transparent absolute sibling covers them, their stacking level is sufficient, and resolved anchors carry no stale pending/disabled markers.
- [ ] The footer is the final visible in-flow region; short pages absorb spare viewport height before, not after, the footer.

## Engineering-only additions

- [ ] A passing one-to-one React screenshot baseline exists before refactors.
- [ ] Every additional engineering shared component has a consumer list and all consumers passed post-extraction Frame comparison.
- [ ] Tailwind handles ordinary layout/spacing/type/color/responsiveness.
- [ ] Complex local selectors/animations are isolated in SCSS Modules or explicitly documented.
- [ ] Suitable behavior-heavy controls use Ant Design, or non-use is documented.
- [ ] Affected routes were compared after component and style ownership changes.
- [ ] Final all-route screenshots pass after the last engineering refactor.
- [ ] `validate_project.py --profile engineering --require-visual` succeeds.
- [ ] ARCHITECTURE, STANDARDS, ROUTES, and DECISIONS document component boundaries, style tracks, dependencies, consumer matrices, deferred batches, and deviations.
