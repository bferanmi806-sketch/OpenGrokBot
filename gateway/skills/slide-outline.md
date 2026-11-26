---
description: Design assertion-evidence slide decks with headline takeaways, visual layout cues, and concise speaker notes.
---
# Slide Outline Playbook

Use this playbook when structuring presentations, executive readouts, pitch decks, quarterly reviews, or workshop slides.

## Workflow

1. **Build the Narrative Spine First (Situation → Complication → Resolution)**
   - Before drafting individual slides, map a clear story arc that reads coherently from slide titles alone:
     - **Situation:** What shared baseline or goal brings the room together?
     - **Complication:** What tension, bottleneck, market shift, or gap demands action now?
     - **Resolution:** What specific recommendation, plan, proof, and ask resolve it?
   - Pull verified project or client metrics via `wiki_search` / `read_file` so claims rest on real numbers.

2. **Write Assertion-Evidence Slide Titles**
   - Every slide title MUST be a complete takeaway sentence stating the conclusion of that slide — NEVER a generic topic label:
     - Good: `"Enterprise churn fell 38% after dedicated onboarding launched in Q2"`
     - Avoid: `"Q2 Churn & Onboarding Update"`
   - Reading just the slide headlines in sequence should tell the entire story without opening a single slide body.

3. **Enforce a Strict Information Density Ceiling**
   - Cap each slide at **3–4 supporting points or data callouts** maximum.
   - One core message per slide. When a topic has both a root-cause breakdown and a 3-phase roadmap, split them into two focused slides instead of cramming both onto one.

4. **Recommend the Right Visual Proof per Slide**
   - Pair every slide's assertion with a concrete layout or chart recommendation instead of defaulting to bullet walls:
     - Trend over time → line or area chart with callout annotation.
     - Part-to-whole / variance bridge → stacked bar or waterfall chart.
     - Option evaluation → 2×2 matrix or compact comparison table.
     - Workflow / architecture → 3–5 step horizontal flow diagram.
     - Key milestone / impact → single large hero metric + 2 context bullets.

5. **Draft Concise, Spoken-Voice Speaker Notes**
   - Add 2–3 natural sentences of speaker notes per slide covering the verbal transition, the story behind the chart, and the likely question from the room — never reading the slide bullets aloud.
   - For longer decks, save the full outline to `/workspace` via `write_file` alongside the summary in chat.

## Per-Slide Output Template

```markdown
### Slide N: <Complete takeaway sentence>
- **Visual / Layout:** <Chart type, diagram, or 2-column layout>
- **Evidence on Slide:**
  - <Metric or proof point 1>
  - <Metric or proof point 2>
  - <Metric or proof point 3>
- **Speaker Notes:** <2–3 spoken sentences + transition to Slide N+1>
```

## Quality Rules

- Keep slide text telegraphic (short phrases, exact numbers) while keeping titles complete sentences.
- End decision decks with an explicit **Decision / Next Steps** slide naming owners and dates.
