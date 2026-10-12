---
project: mcp-lexware-office
updated: 2026-10-12
---

# Decisions

## 2026-10-12: Initialize Project Progress

Use `project-progress/` as the project-local source of progress state.

## 2026-10-12: contentPath requires LEXWARE_OFFICE_UPLOAD_DIR

Host file reads are disabled unless an upload directory is configured; path must resolve inside it. Reason: sandbox code (possibly prompt-injected) could otherwise read any host file, including the account config with API keys. Breaking for existing contentPath users.

## 2026-10-12: Explicit account for writes when 2+ accounts

Reads may use the default account; any write without an explicit account is rejected. Reason: prevent writes landing in the wrong company's books.

## 2026-10-12: Normalize repository to LF

Separate commit with `.gitattributes`. Reason: b061d3c converted every file to CRLF, breaking diffs vs upstream and a regex-based test.
