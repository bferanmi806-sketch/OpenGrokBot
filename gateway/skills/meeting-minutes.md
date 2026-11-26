---
description: Turn raw meeting notes or transcripts into structured decisions, open questions, and owned action items.
---
# Meeting Minutes Playbook

Use this playbook whenever summarizing a meeting transcript, voice memo, call notes, or working-session thread.

## Workflow

1. **Gather Context First**
   - When the notes reference recurring projects, clients, or teammates, run `wiki_search` (and `wiki_read` on matching pages) so names, milestones, and prior open items are accurate rather than guessed.
   - Match the operator's language (e.g., Simplified Chinese or English) while keeping proper nouns, code identifiers, and exact metrics intact.

2. **Lead with an Executive Summary**
   - Open with 2–3 crisp sentences stating the meeting's purpose, participants, and headline outcome so a reader skimming only the top gets the full picture.

3. **Separate Confirmed Decisions from Discussion**
   - List **Decisions** explicitly, pairing each decision with its concise rationale or constraint.
   - Never promote tentative brainstorming, one person's suggestion, or unresolved options into confirmed decisions. If an idea was floated without sign-off, place it under Open Questions / Parking Lot.

4. **Extract Owned Action Items**
   - Format every action item strictly as:
     - `Owner · Concrete action · Due date`
   - If an owner or deadline was not stated in the source notes, mark `[Owner TBD]` or `[Due TBD]` explicitly instead of inventing one.

5. **Capture Open Questions & Parking Lot**
   - Record unresolved trade-offs, missing numbers, external dependencies, and deferred topics, noting who needs to weigh in next.

6. **Sync Durable Team Context**
   - When the meeting establishes durable facts, decisions, or open items for an existing or recurring `project`, `client`, or session `topic`, update the Team Wiki via `wiki_patch` (`decisions`, `openItems`, `keyFacts`, citing `[#msg:<id>]` when summarizing thread messages).
   - If the meeting advances an active goal you participate in, log a brief note with `update_goal_progress`.
   - Never store personal behavioral rules in the wiki (use `save_memory` only when the operator states a standing rule), and never send external follow-up emails or messages without `hold_for_approval` (or connector approval gates).

## Output Template

```markdown
### Summary
<2–3 sentences: meeting goal, participants, and headline outcome>

### Decisions
- **<Decision>** — <Rationale / constraint>

### Action Items
- [ ] <Owner> · <Concrete next step> · <Due date or [Due TBD]>

### Key Discussion Points
- **<Topic>:** <Concise synthesis of trade-offs and constraints>

### Open Questions / Parking Lot
- <Unresolved question or deferred topic> (Needs: <Who>)
```

## Quality Rules

- Quote numbers, dates, and commitments accurately; flag transcript ambiguities rather than smoothing them over.
- Keep prose tight and scannable — cut throat-clearing, small talk, and chronological blow-by-blow narration.
