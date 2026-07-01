## Summary

<!-- One paragraph describing what this PR does and why. -->

## Type of change

- [ ] feat — new feature
- [ ] fix — bug fix
- [ ] chore — maintenance, deps, tooling
- [ ] docs — documentation only
- [ ] refactor — no behaviour change
- [ ] test — test coverage only

## Checklist

- [ ] `make lint` passes locally
- [ ] `make test` passes locally
- [ ] No secrets, tokens, or credentials in any committed file
- [ ] **New dependency?** — justify below (license, maintenance status, why existing packages can't solve this)
- [ ] **DB migration included?** — confirm it is forward-only and numbered sequentially; a reverted app commit must not imply a reverted migration
- [ ] **Schema change?** — `agentledger/schemas/events/llm_call.schema.json` reviewed with backend, SDK, and frontend teams
- [ ] Relevant documentation updated

## New dependency justification (if applicable)

<!-- Package name · version · license · last commit date · why needed -->

## Migration notes (if applicable)

<!-- Migration filename · is it forward-only? · rollback plan at the application layer -->

## Screenshots / recordings (if UI change)
