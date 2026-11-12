# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-12

### Fixed

- Windows: the "open file" button built its resource address by string
  concatenation, so `C:\Users\me\报告.docx` reached the URL unencoded and the
  panel silently did nothing. The address is now built the way the Harness
  builds it (backslashes normalized, every segment percent-encoded, drive-letter
  colon preserved, workspace-relative paths kept relative).
- Windows: the automatic delivery review took the file name by splitting on `/`,
  so a Windows path produced a prompt containing the whole path. The last
  segment is now taken across both separators.

### Added

- The test suite covers both path styles (POSIX and Windows drive/UNC paths) and
  CI runs on `ubuntu-latest`, `windows-latest` and `macos-latest`.

## [0.1.0] - 2026-11-12

### Added

- `request_review` Host tool: the agent hands over a delivery body, the decision
  points that need a human answer, and optional file paths; the right sidebar
  opens an annotatable sheet and the tool returns one structured JSON result
  (`approved` / `changes_requested` / `dismissed` / `unavailable`).
- Right-sidebar review panel: highlight any passage of the delivered Markdown,
  attach a note to it, and answer each decision point with an option or free
  text. Highlights use the CSS Custom Highlight API and degrade to numbered
  items where it is unavailable.
- Automatic delivery acceptance: a successful `present` call opens one
  file-level review without an extra instruction from the user, and the notes
  are appended to the present result. Failures and dismissals never alter the
  original present result.
- Composer takeover for long confirmations: any `ask_user_question` with three
  or more questions is rendered as one sheet instead of one card per question;
  plan-review and approval interactions keep their own composer.
- Settings page for the takeover threshold and automatic sidebar opening, plus
  per-call drafts kept in browser session storage.
