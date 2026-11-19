# Recorded workflow traces

Recorded workflows can be replayed deterministically through the teammate's existing browser. This slice exposes API
controls only; it adds no start/stop buttons or workflow editor to the product UI. Replay does not schedule a workflow
or hand changed pages to the agent.

Recordings attach to the page already owned by the teammate's shared `BrowserSession`. They do not launch a second
browser or replace its logged-in context. In local-computer mode, `showWindow()` and `hideWindow()` relaunch
Chromium; the recorder reattaches to the replacement page and continues recording. Show the local browser window
before recording: its panel screencast is view-only, so the operator drives the real window. Docker recording also
attaches to the current page. The recorder captures navigation, clicks, text entry, selection, checkbox state, and
Enter presses as typed steps. A navigation caused by an action is recorded as that action's expected URL, and a
popup is marked as unrecorded. It does not store screenshots, cookies, arbitrary page dumps, or generated JavaScript.

## Start, stop, review, and save

All endpoints require the gateway's normal authentication token. Drive the teammate's current page through its
computer screen while recording is active.

```http
POST /api/bots/{botId}/workflows/recording
Content-Type: application/json

{"title":"Open the project dashboard","intent":"Find the current project status"}
```

`intent` is optional. The gateway responds with `202` and starts recording. Only one recording or unsaved draft can
exist per teammate. Stop capture to receive a review draft:

```http
POST /api/bots/{botId}/workflows/recording/stop
```

Stopping does not save anything to SQLite (recordings also auto-stop after 15 minutes with `truncated: true`). To
cancel an active recording and discard everything captured so far without creating a draft, send
`DELETE /api/bots/{botId}/workflows/recording`. Review the returned trace, remove steps that should not be retained,
replace literal values with `{ "kind": "placeholder", "key": "customerEmail" }`, and then save the edited trace:

```http
POST /api/bots/{botId}/workflows
Content-Type: application/json

{"draftId":"<id returned by stop>","trace":{"format":"opensuperbot.workflow","version":1,"title":"...","steps":[]}}
```

The submitted trace is validated and sensitive fields are redacted again before persistence. To discard a draft:

```http
DELETE /api/bots/{botId}/workflows/drafts/{draftId}
```

Drafts are held in gateway memory until saved or discarded. Restarting the gateway discards pending drafts. Saved
traces are stored as rows in the gateway SQLite database, alongside routines. List, read, and delete saved traces with:

```http
GET /api/bots/{botId}/workflows
GET /api/bots/{botId}/workflows/{workflowId}
DELETE /api/bots/{botId}/workflows/{workflowId}
```

## Replay a saved workflow

Replay is operator-only and runs through the teammate's existing browser session. A workflow step with a placeholder
uses its key in `bindings`; a redacted field uses the one-based step name `step:N`. Supply every required value in the
request body:

```http
POST /api/bots/{botId}/workflows/{workflowId}/run
Content-Type: application/json

{"bindings":{"customerEmail":"person@example.test","step:4":"value entered at run time"}}
```

The gateway returns `202` with a run ID and does not echo bindings. Values stay in memory for the run; they are not
written to the trace, approval, message, action-log, or run response. They are cleared when the run completes, fails,
or is discarded. A gateway restart loses the in-memory continuation: approving a pending workflow step then returns
`409`; discard it and start a new run with fresh bindings.

To stop an active run, send `DELETE /api/bots/{botId}/workflows/runs/{runId}` (or `POST /api/threads/dm:{botId}/stop`).
If a step is awaiting approval, stopping discards that approval and releases the teammate. If a browser operation is in
progress, the run finishes that operation before stopping and will not start another step.

Steps run without asking unless an action step declares explicit `approval` metadata during trace review/save:

```json
{"type":"click","target":{"candidates":[{"role":{"role":"button","name":"Send"}}]},"approval":{"kind":"email","target":"person@example.test","action":"Send the invoice"}}
```

Steps with `approval` pause at the existing approval gate before executing (`purchase`, `booking`, and `other` always
ask; `email`, `message`, and `post` can match an existing exact standing rule only when the operator supplies no
runtime bindings). Workflows with dynamic values always ask, so a saved rule cannot silently approve a different
runtime destination. Approval resumes the exact held step without asking the language model to reconstruct it. A
discarded approval stops the run.

The v1 runner rejects a trace before any browser action if it is truncated, has an unrecorded popup, or references a
page/frame. It resolves locator candidates in order, but once an action is attempted it never retries another
candidate; this avoids repeating an action whose completion is uncertain. An expected-URL mismatch (polled for up to
five seconds), an unrecorded popup (which is closed immediately), or a browser error stops the workflow before later
steps run.

The computer status response includes `workflowRecording` during capture and `workflowDraft` while review is
pending. An active workflow run or recording prevents idle computer cleanup until it finishes or is stopped.

## Trace format v1

The trace is JSON. Each locator candidate uses exactly one strategy; the ordered array preserves preference from
stable semantic locator to structural CSS fallback.

```ts
type WorkflowTrace = {
  format: 'opensuperbot.workflow'
  version: 1
  title: string
  intent?: string
  steps: WorkflowStep[]
}

type WorkflowStepContext = {
  intent?: string
  page?: string
  frame?: string
}

type WorkflowActionContext = WorkflowStepContext & {
  expect?: { url: string }
  approval?: { kind: 'email' | 'message' | 'post' | 'purchase' | 'booking' | 'other'; target: string; action?: string }
}

type WorkflowStep = WorkflowStepContext & (
  | { type: 'navigate'; url: string }
  | (WorkflowActionContext & { type: 'click'; target: { candidates: Locator[] } })
  | (WorkflowActionContext & { type: 'fill'; target: { candidates: Locator[] }; value: WorkflowValue })
  | (WorkflowActionContext & { type: 'select'; target: { candidates: Locator[] }; value: WorkflowValue })
  | (WorkflowActionContext & { type: 'check' | 'uncheck'; target: { candidates: Locator[] } })
  | (WorkflowActionContext & { type: 'press'; key: 'Enter'; target: { candidates: Locator[] } })
  | { type: 'unrecorded-popup' }
)

type Locator =
  | { role: { role: string; name: string } }
  | { label: string }
  | { placeholder: string }
  | { testId: string }
  | { text: string }
  | { css: string }

type WorkflowValue =
  | { kind: 'literal'; text: string }
  | { kind: 'placeholder'; key: string }
  | { kind: 'redacted'; reason: 'sensitive-input' }
```

`page`, `frame`, and `intent` are optional on every step so recorder metadata can grow while the trace remains v1.
The current recorder emits one locator candidate for each recognized strategy, ordered as role/name, label,
placeholder, test ID, text, then CSS. CSS fallbacks are positional paths and do not copy element IDs or classes.

## Redaction and limits

The browser checks input type, autocomplete, labels, accessible names, placeholders, and field names before sending
values to the gateway. Password and one-time-code fields, credit-card autocomplete fields, fields marked with
sensitive terms such as `secret`, `token`, or `api key`, known credential formats, and high-entropy strings are
stored as redacted values without their text. The gateway validates every event again and re-applies field-name and
credential-pattern checks before a draft is returned or a saved trace is written. URL user info and fragments are
removed; query keys are retained with empty values. High-entropy path segments, including UUIDs, are replaced with
`:redacted`; those navigation steps cannot be replayed as the original record-specific URL. Only HTTP and HTTPS
navigation is recorded.

V1 is bounded to 1,000 steps, 120 title characters, 500 intent characters, 2,000 input characters per step, and
5 MB per trace. Secret detection relies on field metadata and credential-pattern checks; avoid entering secrets
into fields that are not marked or named as sensitive. The operator review before saving lets the operator remove
personal values that do not match these automatic checks.
