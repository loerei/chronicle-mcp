/**
 * MCP progress notification & stall watchdog helper for chronicle-mcp
 * Emits `notifications/progress` so MCP hosts (e.g. Antigravity IDE / VS Code)
 * display a live inline progress bar.
 */

export type ProgressNotify = (
  progress: number,
  total: number | null,
  message: string
) => Promise<void> | void;

export interface ProgressReporterOptions {
  label?: string;
  barWidth?: number;
  minStep?: number; // Minimum progress fraction change (default 0.01 = 1%)
  minIntervalMs?: number; // Minimum wall-clock ms between sends (default 100ms)
  stallTimeoutMs?: number; // Stall watchdog timeout in ms (default 15000ms)
  onStall?: (done: number, total: number, detail: string) => void;
}

export class ProgressReporter {
  private notify: ProgressNotify | null;
  private label: string;
  private barWidth: number;
  private minStep: number;
  private minIntervalMs: number;
  private stallTimeoutMs: number;
  private onStall?: (done: number, total: number, detail: string) => void;

  private lastSentProgress = 0;
  private lastSendTs = 0;
  private doneCount = 0;
  private totalCount = 0;
  private finished = false;
  private stalled = false;
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(notify: ProgressNotify | null, options: ProgressReporterOptions = {}) {
    this.notify = notify;
    this.label = options.label || "Syncing";
    this.barWidth = options.barWidth ?? 12;
    this.minStep = Math.max(options.minStep ?? 0.01, 0);
    this.minIntervalMs = Math.max(options.minIntervalMs ?? 100, 0);
    this.stallTimeoutMs = Math.max(options.stallTimeoutMs ?? 15000, 0);
    this.onStall = options.onStall;
  }

  public start(total = 0, detail = "Starting..."): void {
    if (this.finished) return;
    this.totalCount = Math.max(total, 0);
    this.doneCount = 0;
    this.lastSentProgress = 0;
    this.send(0, detail);
    this.resetStallWatchdog(detail);
  }

  public update(done: number, total?: number, detail = ""): void {
    if (this.finished) return;
    if (total !== undefined && total > 0) {
      this.totalCount = total;
    }
    const currentTotal = Math.max(this.totalCount, 1);
    const clampedDone = Math.max(0, Math.min(done, currentTotal));

    const newProgress = clampedDone / currentTotal;
    const isFinal = clampedDone >= currentTotal;

    // Reset stall watchdog if forward progress is made
    if (clampedDone > this.doneCount) {
      this.stalled = false;
      this.resetStallWatchdog(detail);
    }

    this.doneCount = clampedDone;

    if (!isFinal) {
      if (newProgress - this.lastSentProgress < this.minStep) {
        return;
      }
      if (Date.now() - this.lastSendTs < this.minIntervalMs) {
        return;
      }
    }

    this.send(newProgress, detail);
  }

  public finish(detail = "Complete"): void {
    if (this.finished) return;
    this.finished = true;
    this.clearStallWatchdog();
    if (this.totalCount > 0) {
      this.doneCount = this.totalCount;
    }
    this.send(1.0, detail);
  }

  public getIsStalled(): boolean {
    return this.stalled;
  }

  public stop(): void {
    this.finished = true;
    this.clearStallWatchdog();
  }

  private send(progress: number, detail: string): void {
    if (!this.notify) return;
    const clampedProgress = Math.max(0, Math.min(progress, 1.0));
    this.lastSentProgress = clampedProgress;
    this.lastSendTs = Date.now();

    const message = this.formatMessage(clampedProgress, detail);
    try {
      const res = this.notify(clampedProgress, 1.0, message);
      if (res && typeof (res as any).catch === "function") {
        (res as any).catch(() => {});
      }
    } catch {
      // Ignore notification failures
    }
  }

  private formatMessage(progress: number, detail: string): string {
    const filled = Math.floor(progress * this.barWidth);
    const bar = "[" + "#".repeat(filled) + "-".repeat(this.barWidth - filled) + "]";
    const pct = `${(progress * 100).toFixed(1)}%`;
    const parts = [this.label, bar, pct];
    if (this.totalCount > 0) {
      parts.push(`${Math.min(this.doneCount, this.totalCount)}/${this.totalCount}`);
    }
    if (detail) {
      parts.push(detail);
    }
    return parts.join(" ");
  }

  private resetStallWatchdog(detail: string): void {
    this.clearStallWatchdog();
    if (this.finished) return;

    this.stallTimer = setTimeout(() => {
      if (!this.finished) {
        this.stalled = true;
        const stallDetail = `[STALLED] Waiting for disk I/O... ${detail}`.trim();
        if (this.onStall) {
          this.onStall(this.doneCount, this.totalCount, stallDetail);
        }
        this.send(this.lastSentProgress, stallDetail);
      }
    }, this.stallTimeoutMs);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}
