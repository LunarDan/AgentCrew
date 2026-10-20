## 1. Content Model

- [x] 1.1 Extend `src/shared/types.ts` with enhanced PPT slide/block types while keeping legacy `title` / `bullets` / `layout` fields valid.
- [x] 1.2 Add a PPT normalization helper that converts legacy slides and enhanced slides into one canonical render/export shape.
- [x] 1.3 Update `src/server/artifact-content.ts` to accept enhanced PPT input, validate supported block types, and reject unbounded binary payloads.
- [x] 1.4 Add focused tests for legacy PPT normalization, enhanced block normalization, and invalid payload rejection.

## 2. Preview UI

- [x] 2.1 Update `SlideDeckView` / `SlideView` to render canonical blocks for headings, paragraphs, bullets, metrics, quotes, timelines, columns, callouts, dividers, and spacers.
- [x] 2.2 Preserve the existing legacy PPT preview appearance through the normalization layer.
- [x] 2.3 Update the PPT JSON edit view examples or placeholder content so users can understand the richer DSL.
- [x] 2.4 Verify long slide text does not overflow fixed slide bounds in desktop-sized preview and fullscreen preview. (2026-10-20: content is clipped to the fixed 768×432 stage in both modes and an on-stage「本页内容超出画布，导出会被截断」badge appears; regression covered by `e2e/artifacts.spec.ts` 「超长幻灯片在预览里显示溢出提示」, including the badge clearing when paging back.)

## 3. Editable PPTX Export

- [x] 3.1 Refactor `src/server/ppt-export.ts` to export canonical block slides instead of only legacy bullet slides.
- [x] 3.2 Map each supported semantic block to editable PowerPoint text/shapes via `pptxgenjs`.
- [x] 3.3 Keep the default export URL behavior as editable `.pptx` for backward compatibility.
- [x] 3.4 Add or update export tests to assert a non-empty PPTX is produced for legacy slides and enhanced block slides.

## 4. Visual-Priority Export

- [x] 4.1 Add an export mode parameter to the artifact export route, with `editable` as the default and `visual` as the explicit visual-priority mode.
- [x] 4.2 Add a renderer spike for HTML/CSS slide-to-image export and document Electron/standalone packaging implications before enabling it by default.
- [x] 4.3 Implement visual-priority PPTX export behind the explicit `visual` mode if the renderer spike is acceptable. (Spike was not acceptable for first pass; route returns unavailable.)
- [x] 4.4 Return a clear error for visual export when the renderer is unavailable, while keeping editable export functional.

## 5. Tool Guidance And Documentation

- [x] 5.1 Update `write_artifact` tool guidance/examples so agents can produce enhanced PPT decks without inventing unsupported fields.
- [x] 5.2 Sync `specs/04-artifacts.md` with the enhanced PPT DSL, export modes, compatibility guarantees, and asset constraints.
- [x] 5.3 Update OpenSpec/main specs after implementation and run OpenSpec validation if available.

## 6. Verification

- [x] 6.1 Run targeted tests for PPT normalization and PPT export.
- [x] 6.2 Run `pnpm exec eslint` on touched files.
- [x] 6.3 Run `pnpm typecheck`.
- [x] 6.4 Manually inspect at least one enhanced PPT artifact in preview and one downloaded editable PPTX. (2026-10-20: covered by the Playwright run of `e2e/artifacts.spec.ts` — preview renders both pages, the .pptx download is non-empty, and the overflow badge case is asserted. No real-LLM deck was inspected by hand.)
