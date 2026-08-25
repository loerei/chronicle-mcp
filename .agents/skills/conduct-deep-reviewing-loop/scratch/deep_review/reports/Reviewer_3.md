### Review Evaluation: Reviewer #3 (Multi-Agent Architecture & Protocol Reviewer)

- **Status**: `STATUS: REVISIONS NEEDED`

---

### Blocking Issues (Required Edits to Draft):

1. **[Path Contradiction: Workspace Layout Tree vs Repo-Root Diagnostic Sandbox]**:
   - **Target Section**: `PROTOCOL.md` Section 2 (`Workspace Layout`) & `implementation_plan.md` (Proposed Changes -> `PROTOCOL.md`)
   - **Flaw**: In `simulated_plan_changes.diff`, the ASCII tree in `PROTOCOL.md` Section 2 places `.scratch/` as a child subdirectory under `scratch/deep_review/` (i.e. `scratch/deep_review/.scratch/`). However, all 5 reviewer guides, `REVIEW-HOST-GUIDE.md`, and `AGENTS.md` (Tier 2 Policy) explicitly reference `<repo-root>/.scratch/` (e.g. `.scratch/repro_*`). If `.scratch/` is located at `<repo-root>/.scratch/`, putting it inside `scratch/deep_review/` in the architecture diagram creates a direct contract contradiction and path resolution bugs for subagents attempting to run `node .scratch/...`.
   - **Required Edit**: Update `PROTOCOL.md` Section 2 and `implementation_plan.md` to clearly specify `<repo-root>/.scratch/` as an external gitignored diagnostic sandbox rather than a nested subfolder of `scratch/deep_review/`, or explicitly define the path resolution convention across all guides.

2. **[Lifecycle Teardown Omission: Missing Workflow Completion Purge for `.scratch/`]**:
   - **Target Section**: `REVIEW-HOST-GUIDE.md` (Step 5 / Final Verdict / Reporting) & `PROTOCOL.md` Section 7 (`Full Sweep Gate & !SP Threshold`)
   - **Flaw**: `REVIEW-HOST-GUIDE.md` mandates purging `.scratch/` scripts at round start and before Full Sweep passes, but fails to mandate a final cleanup pass when issuing `FINAL_PASS` or terminating the loop. Diagnostic scripts (`repro_*`, `bench_*`, `dryrun_*`) created during the final targeted passes will linger permanently in `<repo-root>/.scratch/`, violating `AGENTS.md` private data hygiene rules.
   - **Required Edit**: In `REVIEW-HOST-GUIDE.md` and `PROTOCOL.md` Section 7, add an explicit requirement that upon issuing `FINAL_PASS` (or loop termination), the Host MUST execute a final cleanup purging all temporary files in `.scratch/`.

3. **[Purge Glob Incompleteness & Auxiliary Artifact Leaks]**:
   - **Target Section**: `REVIEW-HOST-GUIDE.md` Step 1 (`Workspace Preparation`) & `PROTOCOL.md` Section 2
   - **Flaw**: The purge filter explicitly matches only 5 specific file prefixes (`.scratch/repro_*`, `.scratch/bench_*`, `.scratch/harness_*`, `.scratch/check_*`, `.scratch/dryrun_*`). If diagnostic scripts produce auxiliary output files (e.g. `.scratch/mock_db.sqlite`, `.scratch/temp_payload.json`, `.scratch/trace.log`), these files evade the prefix globs and accumulate as leftover state across review rounds.
   - **Required Edit**: Update Step 1 in `REVIEW-HOST-GUIDE.md` and `PROTOCOL.md` Section 2 to specify purging all contents of `.scratch/` (or `.scratch/*`) at round start and teardown, rather than relying solely on the 5 script prefix globs.

4. **[Missing Cross-Reviewer Diagnostic Isolation Guard]**:
   - **Target Section**: `EDGECASE-REVIEWER-GUIDE.md`, `PERFORMANCE-REVIEWER-GUIDE.md`, `TESTABILITY-REVIEWER-GUIDE.md`, `READINESS-REVIEWER-GUIDE.md`, `DATA-MIGRATION-REVIEWER-GUIDE.md` (`Empirical Verification & Diagnostics` sections)
   - **Flaw**: While reviewers are instructed not to inspect host coordination files or other reviewer reports, there is no explicit constraint preventing parallel Tier 2 reviewers (e.g. `Readiness` and `DataMigration` in Tier 3.2, or `Edgecase` and `Performance` in Tier 3.3) from reading or executing each other's diagnostic files in `.scratch/`, risking cognitive anchoring and inter-agent contamination.
   - **Required Edit**: In all 5 reviewer guides under `Empirical Verification & Diagnostics (.scratch/)`, add an explicit imperative: "You MUST author and execute ONLY your own role-prefixed diagnostic scripts in `.scratch/` and MUST NOT inspect or execute scratch files authored by other reviewer roles."

---

### Suggestions for Improvement (Optional / Non-blocking):

- **Performance Guide Phrasing Deslop (`/write-for-ai`)**: In `PERFORMANCE-REVIEWER-GUIDE.md`, streamline `"measuring execution time with bounded iterations (N = 100,000, max 15s timeout), measuring regex backtracking latency, or profiling memory heap allocations"` to eliminate duplicate verb chaining: `"measuring execution time with bounded iterations (N = 100,000, max 15s timeout), regex backtracking latency, or heap allocations"`.
- **Tool Allowlist Parameter Passing**: In `REVIEW-HOST-GUIDE.md` Step 2, clarify that when summoning Tier 1 subagents, the Host should explicitly omit `run_command` from tool declarations where supported by the subagent runtime.
