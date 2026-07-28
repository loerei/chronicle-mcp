import { describe, it } from "node:test";
import assert from "node:assert";
import { ProgressReporter } from "../progress.js";

describe("ProgressReporter", () => {
  it("should format progress message correctly", () => {
    let lastMsg = "";
    let lastProgress = 0;

    const reporter = new ProgressReporter(
      (progress, total, message) => {
        lastProgress = progress;
        lastMsg = message;
      },
      { label: "Indexing", minStep: 0, minIntervalMs: 0 }
    );

    reporter.start(10, "Starting test...");
    assert.strictEqual(lastProgress, 0);
    assert.ok(lastMsg.includes("Indexing [------------] 0.0% 0/10 Starting test..."));

    reporter.update(5, 10, "Halfway");
    assert.strictEqual(lastProgress, 0.5);
    assert.ok(lastMsg.includes("Indexing [######------] 50.0% 5/10 Halfway"));

    reporter.finish("Done");
    assert.strictEqual(lastProgress, 1.0);
    assert.ok(lastMsg.includes("Indexing [############] 100.0% 10/10 Done"));
  });

  it("should handle stall watchdog timer reset and stall notification", async () => {
    let stallCalled = false;
    let stallDetail = "";

    const reporter = new ProgressReporter(
      (progress, total, message) => {
        if (message.includes("STALLED")) {
          stallCalled = true;
          stallDetail = message;
        }
      },
      { label: "StallTest", stallTimeoutMs: 30, minStep: 0, minIntervalMs: 0 }
    );

    reporter.start(5, "Processing...");
    assert.strictEqual(reporter.getIsStalled(), false);

    // Wait for stall timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(reporter.getIsStalled(), true);
    assert.strictEqual(stallCalled, true);
    assert.ok(stallDetail.includes("[STALLED]"));

    // Advancing progress resets stall state
    reporter.update(2, 5, "Moving again");
    assert.strictEqual(reporter.getIsStalled(), false);

    reporter.finish("Complete");
  });
});
