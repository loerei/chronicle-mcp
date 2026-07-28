# Conduct Reviewing Loop Reference & Prompt Templates

Templates, checklist builders, and multi-turn reviewer loop protocols for stress-testing any target artifact.

---

## 1. Reviewer Subagent Prompt Template (Blind Reviewer Protocol)

When invoking a reviewer subagent via `invoke_subagent`, use this structured prompt:

```markdown
You are <Domain> Reviewer #<N>. You are conducting an independent, blind audit of the proposed <Artifact Type> draft.

### Required Reading (MUST read using view_file):
1. Target Artifact Draft: `<draft_path>`
2. System Guidelines / Rules: `<rule_paths>`

### Synthesized Audit Checklist:
1. **User Requirements**: <User-defined high-level constraints and preferences>
2. **System Guidelines**: <Rules from AGENTS.md, /write-a-skill, /write-for-ai, etc.>
3. **Domain & Edge-Case Completeness**: <High-level correctness, safety, or performance checks without naming specific internal functions or private code markers>

> [!CAUTION]
> **Blind Protocol Enforcement**: You are auditing this draft with fresh eyes. Do NOT ask for or expect previous iteration logs or past reviewer notes. Focus strictly on discovering any architectural flaws, missing edge cases, or invalid logic in the current draft.

Conclude explicitly with either:
- **STATUS: REVISIONS NEEDED** (with a numbered list of required edits), OR
- **STATUS: PASS** (if the draft is 100% complete and compliant).
```

---

## 2. Domain Checklist Builders (High-Level Specification Examples)

### A. Implementation Plans & Architectural RFCs
- [ ] User goals & constraints explicitly addressed
- [ ] No hardcoded env values, magic numbers, or fixed pixel layouts
- [ ] Surgical changes: only touch required files
- [ ] Empirical verification plan included (build, test, lint)
- [ ] Rollback or failure recovery strategy present
- [ ] Transaction atomicity, crash recovery, and missing file cleanup specified
- [ ] Boundary validation, path normalization, and payload ambiguity prevented

### B. Skill Drafts & Documentation
- [ ] Description frontmatter includes explicit "Use when..." triggers
- [ ] `SKILL.md` strictly under 80-100 lines (Progressive Disclosure)
- [ ] `/write-for-ai` compliance: decision signals, no marketing fluff, decision tables used
- [ ] Concrete **Before / After** code examples included in `REFERENCE.md`
- [ ] 100% universal and usable across all target project repositories

### C. PRDs & Feature Specifications
- [ ] Problem statement & clear scope boundaries defined
- [ ] User stories & acceptance criteria unambiguous
- [ ] Security, permission, and data isolation requirements specified
- [ ] Edge cases (network timeouts, empty data states, rate limits) covered

---

## 3. Multi-Turn Iteration Best Practices

1. **Role Differentiation**: ALWAYS increment the Reviewer index (`Reviewer #1`, `Reviewer #2`, `Reviewer #3`) to enforce fresh, un-biased perspectives on each iteration.
2. **Blind Reviewer Protocol (No Past Context Feeding)**: NEVER include previous reviewer findings, lists of fixed points, or past iteration logs in the subagent prompt.
3. **No-Hint Checklist Rule (Prevent Prompt Poisoning & Anchoring)**: The checklist in the prompt MUST describe expectations at the **High-Level Domain/Functional Requirement Level**. NEVER list specific internal function names (`_commit_transaction_with_delay`), internal file flags (`old_start=0`), or marker suffixes (`.missing`) in the prompt. Giving low-level implementation hints causes **Anchoring Bias** and degrades the subagent's ability to discover fresh, un-anchored edge cases.
4. **Critical Evaluation Gatekeeper (Always Question Reviewer Feedback)**: Do NOT blindly apply every reviewer request. The Main Agent MUST filter reviewer feedback against code realities, user intent, and YAGNI/simplicity principles before editing the draft. Reject or refine over-engineered or hallucinated reviewer suggestions.
5. **Strict Termination & User Approval Protocol**: The loop terminates ONLY when:
   - **Case A**: A reviewer subagent explicitly returns `STATUS: PASS`.
   - **Case B**: All points raised in `REVISIONS NEEDED` are critically evaluated by the Main Agent as invalid/over-engineered.
   - **User Approval Gate**: In ALL cases (Case A & Case B), report results to user. In Case B, document specific technical justifications for every rejected point and await explicit user approval before proceeding to Tier 3 execution.
6. **Neutral & Un-biased Evaluation**: Do NOT tell the subagent reviewer that the draft is "almost finished" or "good". Keep prompt neutral to ensure objective critique.
7. **Surgical Refinement**: Apply edits strictly addressing verified, valid reviewer feedback without introducing unrequested side-effects.
