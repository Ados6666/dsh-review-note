# dsh-review-note

Turn a DeepSeek Harness checkpoint review into **one annotatable sheet** instead of a
back-and-forth of single-purpose confirmations: the agent hands over a deliverable, you
highlight the passages that need work, comment on each decision point, and send every
note back as one structured result.

- **Delivery review** — the agent calls `request_review` with the delivery body, the
  decision points, and the files it produced. A right-sidebar sheet opens; you annotate
  it the way plan review works, and the tool returns
  `approved` / `changes_requested` / `dismissed` with per-item notes.
- **Automatic acceptance** — when the agent declares finished files with `present`, the
  plugin opens one file-level review by itself. No instruction from you, no extra turn.
- **Batch confirmation** — once a single `ask_user_question` carries three or more
  questions, the native card is replaced by one sheet that shows every question at once;
  answers are submitted together.

## Requirements

- DeepSeek Harness `0.2.x`, opened in a **graphical** client: the desktop app, or a page served by `dsh web`. That UI is where the panel lives.
- A profile you can install a bundle into.

## Install

From GitHub:

```bash
dsh plugin --profile <profile> add github:Ados6666/dsh-review-note
```

From a checkout on disk:

```bash
dsh plugin --profile <profile> add /path/to/dsh-review-note
```

Then restart DSH, or hard-refresh the Web client. Remove it with
`dsh plugin --profile <profile> remove dsh-review-note`.

## Usage

### 1. Delivery review

The agent calls the tool when a deliverable needs your sign-off:

```text
request_review(
  title: "Fundraising plan · section 2 conventions",
  detail: "…the delivered Markdown…",
  items: [
    { id: "capex", prompt: "Is R&D fully expensed?", quote: "R&D is expensed in full" },
    { id: "working-capital", prompt: "Is working capital entirely self-funded?" }
  ],
  files: ["reports/plan.md"]
)
```

The right sidebar opens a sheet with the body on the left and one comment box per item.
Highlight any passage to attach a note to it; `quote` pins an item to an exact passage.
Submitting returns:

```json
{
  "decision": "changes_requested",
  "review_id": "rv_…",
  "annotations": [
    {
      "id": "capex",
      "prompt": "Is R&D fully expensed?",
      "action": "needs changes",
      "quote": "R&D is expensed in full",
      "note": "show both conventions side by side"
    }
  ],
  "note": "overall comment"
}
```

`decision` is one of `approved`, `changes_requested`, `dismissed`, `unavailable`.
Closing the sheet without submitting is reported as `dismissed` — never as approval.

### 2. Automatic acceptance after `present`

```text
present(files: ["reports/plan.docx", "reports/plan.md"])
```

The plugin opens a file-level review for those files and appends the outcome to the
present result, so the agent learns your verdict in the same turn. Behaviour:

- Turn it off with `autoReviewPresent: false` in the plugin configuration.
- Cooldown: one automatic review per session per `autoReviewCooldownMs` (120 s default).
- Close the sheet and the agent is told the delivery was not accepted.
- A failure or a cancellation never breaks the original `present` result.

### 3. Multi-question confirmations

When the agent asks three or more questions at once, the plugin takes over the composer
and shows every question in the sidebar sheet. Questions you leave untouched are
submitted as skipped (`selected: []`); overall remarks are carried in the trailing note.
Single-question confirmations, plan review, and approval prompts keep their native card.

## Settings

Settings → Checkpoint review notes:

- **Takeover threshold** — default `3` (more than two questions). Set it higher to leave
  medium-sized confirmations on the native card.
- **Open the sidebar automatically** — default on.

Changes apply to the next confirmation.

## How it works

| Concern | Approach | Why |
| --- | --- | --- |
| Taking over the composer | `conversation.composer` with `priority: -1` | The built-in question composer registers at `0`; a chain picks the first non-null selector in priority order |
| Recognising a review | Base64 HTML-comment envelope on `detail` | Does not rely on a private interaction kind; with the plugin off, the prompt still renders as a normal card |
| Answering | `pending.answer({ answers: [...] })` | Uses the documented answer contract, so the agent needs no adapter |
| Closing | `dismiss()` without `wait`; the Host maps `ASK_CANCELLED` and concludes the turn | Never leaves the turn hanging |
| Anchoring | CSS Custom Highlight API with `{ quote, occurrence }` | The delivered text is not mutated; without the API, items fall back to numbered references |
| Markdown | Self-contained renderer (headings, lists, quotes, code, pipe tables) | No Harness Client package is loaded as a module, so a Harness upgrade cannot blank the panel |
| Drafts | `sessionStorage`, keyed by session and call id | A refresh keeps your work; submitting clears it |

## Relation to dsh-plan-note

This plugin is a sibling of [dsh-plan-note](https://github.com/0-0-user/dsh-plan-note)
and stands on its shoulders: the idea of annotating a pending review in place, the
passage-anchored comment model, and the `{ quote, occurrence }` anchoring scheme all come
from it. dsh-plan-note covers plan review; this plugin extends the same interaction to
delivery checkpoints during task execution. The two do not compete for the composer: this
plugin explicitly excludes `plan-review` and `approval` interactions, so a plan review
still belongs to dsh-plan-note (which needs `dsh-plan-mode` enabled in the profile).

## Limitations

- The panel lives in the web UI - the window you are looking at inside the desktop app, or a page served by `dsh web`. That is the only conversation surface DSH ships today; there is no terminal chat client, so the panel does not appear anywhere else.
- Subagents cannot open a review (`userQuestions` rejects delegated callers), so the main
  agent has to aggregate and call the tool.
- Markdown support is deliberately small: headings, lists, quotes, fenced code, pipe
  tables, inline code, bold, italic, and http(s) links. Everything else renders as text.
- Settings and drafts live in this browser's storage; they do not sync across devices.
- Questions with a countdown timer (timeout prompts) are not taken over.

## Development

```bash
node --check lib/client.js
node --check lib/index.js
node --test test/*.test.mjs   # or: npm test
```

Layout:

```text
lib/index.js          Host: the request_review tool, the automatic acceptance hook, the prompt section
lib/client.js         Client: composer takeover, the sidebar sheet, the settings page
lib/review-format.js  Envelope codec, item normalisation, answer parsing (shared with the tests)
test/                 Unit tests for the format and Host halves
docs/                 Detail page image
```

## License

MIT — see [LICENSE](LICENSE).
