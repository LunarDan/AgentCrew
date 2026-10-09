- [x] 1. Add OpenSpec delta specs for Orchestrator task contracts and `write_artifact.outputKey`.
- [x] 2. Update numbered Orchestrator and tools specs with the same contract.
- [x] 3. Extend shared dispatch plan types and `plan_tasks` schema.
- [x] 4. Implement plan compilation and validation for `inputs` and `expectedOutputs`.
- [x] 5. Add `outputKey` support to `write_artifact` and collect output-key artifact mappings.
- [x] 6. Inject handoff contract blocks into child prompts and enforce required inputs/outputs.
- [x] 7. Update the dispatch plan card to display inputs, outputs, and acceptance criteria.
- [x] 8. Add focused regression tests and run validation.

Validation note: focused `dispatch-plan` / `task-result-report` unit tests and the fake-adapter contract tests (`src/server/adapters/mock-adapter.test.ts`) cover plan compilation, completion gates, and the handoff prompt contract. `e2e/dispatch.spec.ts` covers the handoff chain end to end: the plan card renders `out doc:document` / `in t1.doc`, the upstream child writes the artifact with `outputKey`, the downstream child receives the injected `artifactId`, and the run aggregates to 2/2. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e` pass. `pnpm build` is not validated in this change: it flips `better-sqlite3` to the Electron ABI, which depends on the local toolchain / prebuild download.
