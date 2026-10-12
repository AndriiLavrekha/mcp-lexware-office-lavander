---
project: mcp-lexware-office
updated: 2026-10-12
---

# Tasks

Security hardening of multi-account support (review of b061d3c). Branch: `fix/multi-account-hardening`.

- [x] 0. Normalize repo to LF (`.gitattributes`, renormalize) — separate commit
- [x] 1. Fix escaped backtick ending prelude template in `src/executor.ts` (build break)
- [x] 2. Update stale tests (error messages, tool-registration regex)
- [x] 3. Global `LEXWARE_OFFICE_READ_ONLY=true` always wins over per-account flags
- [x] 4. 2+ accounts: writes require explicit account; unknown `DEFAULT_ACCOUNT` fails at startup
- [x] 5. `spec.info.writesEnabled` derived from registry (any account writable) + per-account metadata
- [x] 6. Config file / ACCOUNTS_JSON errors fail hard with generic message (no JSON snippet)
- [x] 7. With 2+ accounts, global ALLOW_WRITES no longer enables accounts implicitly
- [x] 8. `contentPath` restricted to realpath inside `LEXWARE_OFFICE_UPLOAD_DIR`, extension allowlist, config file denied
- [x] 9. Per-account / global `baseUrl` must be https
- [x] 10. Reject reserved/prototype account ids; null-prototype maps in sandbox
- [x] 11. Duplicate normalized account ids fail at startup
- [x] 12. Dockerfile: non-root user, frozen lockfile, pinned pnpm, node:22-alpine builder
- [x] 13. Tests for all of the above; README + docs/guide.md updated
- [x] 14. typecheck + full test run green (85/85); Docker build + stdio E2E verified
- [x] 15. Independent review agent; all findings fixed (92/92 tests)
- [x] 16. Merge to main (fast-forward)
- [ ] 16b. Push main to origin (blocked: GitHub token invalid; user runs gh auth login, then git push origin main)
- [ ] 17. User: test MCP with multiple real Lexware accounts
