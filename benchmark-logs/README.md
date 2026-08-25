# Chronicle MCP Benchmark Logs

This directory contains execution logs, benchmark reports, and visualization charts comparing how an AI coding agent performs when searching and auditing historical sessions with and without Chronicle MCP.

All benchmark tasks were evaluated using **Gemini 3.7 Flash (High)**.

---

## Benchmark Methodology

We evaluate the performance of an AI coding agent on complex historical audit tasks across 500+ local conversation brain folders and raw transcript log files under two distinct operational strategies:

1. **Variant A: Chronicle MCP (v2.1.0)**
   * Uses dedicated history intelligence tools.
   * Starts with `chronicle_guide` to pull targeted recipes on demand without polluting the global context.
   * Uses compact 1-line markdown progressive disclosure by default to keep context token usage low.
   * Directly slices turns and resolves session prefix IDs without manual log dumps.

2. **Variant B: Custom Scripts (No MCP Tools)**
   * No history MCP server. The agent is permitted to write and execute its own Python and Node.js scripts on disk.
   * The agent has to crawl hundreds of session brain directories, parse megabytes of raw Antigravity `transcript.jsonl` files line by line, handle regex matching, and aggregate turns manually.

---

## Directory Structure

```
benchmark-logs/
├── README.md                      # This file (overview, methodology, analysis)
├── generate_chart.py              # Script to compile and plot benchmark charts
└── prd-and-tickets/               # Benchmark: Historical PRD and Tickets Resolution Audit
    ├── prd-tickets-benchmark.md   # Consolidated report and metric tables
    ├── prd-tickets-benchmark-chart.png # 3-panel visualization (Time, Steps, Output Tokens)
    └── logs/                      # Raw session transcripts
        ├── variant-a-chronicle-mcp.md   # Full transcript for Variant A (8f5112a8)
        └── variant-b-custom-scripts.md  # Full transcript for Variant B (601586ec)
```

---

## Detailed Reports

To view the full task goals, metric comparisons, session transcripts, and delta gains, refer to:

* **[Historical PRD and Tickets Audit Benchmark Report](prd-and-tickets/prd-tickets-benchmark.md)**

---

## Generating Charts

The visualization charts in the subdirectories are compiled and generated using Matplotlib through uv:

```bash
uv run --with matplotlib python benchmark-logs/generate_chart.py
```

This compiles the metrics and saves `prd-tickets-benchmark-chart.png` into the `prd-and-tickets/` directory.

---

## Performance Analysis & Case Studies

### 1. Execution Time and Agent Velocity
* **Chronicle MCP (Variant A)** completed the entire cross-repo audit in **119.0s** (~1.98 minutes).
* **Custom Scripts (Variant B)** took **259.0s** (~4.31 minutes).
* *Observation:* Variant A was **2.18x faster** (saving 140 seconds). Having structured query endpoints like `search_history` and `query_transcript` removes the entire trial-and-error cycle of writing a script, running it, fixing syntax errors, and re-running it.

### 2. Output Tokens Consumption
* **Variant A** consumed **9,097 output tokens**.
* **Variant B** burned **25,424 output tokens** (2.79x more).
* *Observation:* When an agent has to write its own inspection scripts, output token consumption skyrockets. Output generation is the slowest and most computationally expensive part of an LLM turn. Offloading data extraction to dedicated tools cuts down on token waste.

### 3. Agent Steps and Cognitive Friction
* **Variant A** solved the task in **85 steps** and **38 tool calls**.
* **Variant B** required **128 steps** and **56 tool calls**.
* *Observation:* In Variant B, the agent suffered from cognitive friction, having to write recursive directory crawlers, parse massive `transcript.jsonl` files line by line, and handle regex edge cases before it could even start answering the user's actual question.

### 4. Precision and Recall
Both variants achieved 100% precision and recall, identifying all 5 historical PRDs (Chronicle #14, Chronicle #24, YumeShelf #41, YumeShelf #50, YumeShelf #60) and all 34 decomposed tickets across both repositories. However, Variant A extracted the exact GitHub issue links and resolved statuses directly through indexed search without touching raw JSONLines files.
