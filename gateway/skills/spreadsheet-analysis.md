---
description: Inspect CSV, TSV, or spreadsheet files deterministically with scripts before summarizing metrics, anomalies, and trends.
---
# Spreadsheet Analysis Playbook

Use this playbook whenever analyzing CSV, TSV, JSONL, or Excel/spreadsheet files in `/workspace` or `uploads/`.

## Workflow

1. **Inspect Schema & Data Hygiene First**
   - Locate the file (e.g., `/workspace/uploads/...`) and run a quick inspection script before computing any business metric.
   - Check and record:
     - Exact column headers and inferred data types
     - Total row count and blank/null cell counts per column
     - Delimiter, character encoding (UTF-8 BOM, CRLF), and currency/unit symbols
     - Min–max date range and duplicate primary keys

2. **Zero Mental Math — Always Run Deterministic Scripts**
   - NEVER compute sums, averages, growth rates, shares, cohorts, or percentiles in your head.
   - Run deterministic `python3` (using `csv`, `decimal`, `statistics`, `collections`, or `pandas`/`openpyxl` if installed) or `node` scripts via `shell` to calculate every number.
   - If `shell` commands are disabled on a local computer, state that plainly so your operator can turn on **Allow commands** in the computer panel rather than guessing figures from a partial `read_file` slice.

3. **Cross-Check & Reconcile Totals**
   - Verify that segment subtotals reconcile to the grand total and that row counts before and after filtering or joining match expectations.
   - Strip formatting artifacts (`$`, `,`, `%`, trailing spaces) deterministically in code before casting strings to numbers, and guard against division by zero or string-sorted numeric columns.

4. **State Denominators, Filters & Outliers Explicitly**
   - Pair every rate, average, or YoY/MoM change with its exact numerator, denominator, date window, and exclusion rule (e.g., *"excludes 14 refunded rows; N = 1,240 paid orders"*).
   - Report median and interquartile range (or P90) alongside the mean when distributions are skewed.
   - Flag anomalies separately: incomplete trailing weeks/months, sudden zero-value drops, negative quantities, or extreme single-row outliers.

5. **Deliver a Crisp Analytical Summary**
   - Save cleaned tables or reusable scripts in `/workspace` via `write_file` / `shell` when the operator may iterate on them.
   - Present findings clearly in the operator's language:
     - **Headline Takeaways** — 2–4 quantified conclusions up front.
     - **Key Metrics Table** — clean Markdown table with explicit units and period labels.
     - **Anomalies & Data Caveats** — missing values, duplicates, partial periods, or outliers spotted.
     - **Suggested Follow-Ups** — concrete slices or checks worth running next.

## Quality Rules

- Every number in your reply must trace directly to script output from this turn — never extrapolate silently.
- Keep precision honest (e.g., 1–2 decimal places for percentages, exact integers for counts, consistent currency units).
