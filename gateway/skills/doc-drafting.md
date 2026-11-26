---
description: Draft clear, audience-tailored memos, specs, proposals, and emails with conclusions up front and explicit assumptions.
---
# Document Drafting Playbook

Use this playbook when drafting memos, product/technical specs, client proposals, status updates, or important emails.

## Workflow

1. **Align on Audience, Purpose & Context**
   - Identify the target reader (executive decision-maker, external client, engineering team, cross-functional partner), what they care about, and the exact decision or action needed from them.
   - Check `wiki_search` / `wiki_read` for relevant client, contact, or project background so terminology, commitments, and history stay consistent.
   - If a critical constraint (audience, stance, or scope) is genuinely ambiguous, ask a quick clarifying question via `ask_operator` before writing a long draft.

2. **Put the Conclusion Up Front (BLUF / Pyramid Principle)**
   - State the core conclusion, recommendation, or specific ask in the opening paragraph.
   - Group supporting arguments logically beneath scannable headings or short bullet points rather than narrating chronologically how you arrived at the answer.

3. **Make Assumptions, Scope & Risks Explicit**
   - For specs, proposals, and memos, include a dedicated **Assumptions & Risks** (or **Scope & Non-Goals**) section listing:
     - Key assumptions the plan relies on (timeline, headcount, pricing, dependencies).
     - Explicit trade-offs or out-of-scope items.
     - Top failure modes and concrete mitigations.

4. **Write Crisp, Concrete Prose**
   - Match the operator's language and preferred register (direct, respectful, zero corporate fluff).
   - Prefer concrete nouns, active verbs, and exact numbers/dates (`"ships by May 15 with 2 engineers"`) over vague qualifiers (`"streamlined"`, `"robust"`, `"soon"`).
   - Keep paragraphs to 3–4 lines max; use tables for structured comparisons, timelines, or ownership matrices.

5. **Save Locally & Respect the Outbound Approval Gate**
   - For substantial specs or proposals, write the clean Markdown file into `/workspace` via `write_file` and share a concise summary in chat so the operator can review or iterate easily.
   - Stop at the draft! Never send an email, post a message, publish a page, or message an external party on your own: either leave the draft for review, call the appropriate connector write tool (which pauses for operator approval), or call `hold_for_approval` with the exact recipient and text.

## Recommended Memo / Proposal Skeleton

- **Context & Recommendation (BLUF)** — What we recommend and what decision is needed by when.
- **Why Now / Evidence** — Quantified problem statement or customer signal.
- **Proposed Plan & Milestones** — Concrete deliverables, owners, and dates.
- **Assumptions, Non-Goals & Risks** — Explicit boundaries and mitigations.

## Quality Checklist Before Delivering

- Can a busy reader grasp the point and the ask in the first 15 seconds?
- Are every date, owner, number, and assumption explicit rather than implied?
- Has all generic AI filler (*"In conclusion"*, *"It is important to note"*, *"delve into"*) been cut?
