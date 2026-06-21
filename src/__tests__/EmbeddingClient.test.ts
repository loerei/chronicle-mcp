import { describe, it } from "node:test";
import assert from "node:assert";
import { MockEmbeddingClient, TransformersEmbeddingClient } from "../embeddings.js";

describe("EmbeddingClient Tests", () => {
  it("MockEmbeddingClient returns vectors corresponding directly to the length of the input texts", async () => {
    const client = new MockEmbeddingClient();
    const result = await client.embed(["hello", "world"]);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], [1, 0]);
    assert.deepStrictEqual(result[1], [1, 0]);
  });

  it("TransformersEmbeddingClient returns correct vectors when running", async () => {
    const client = new TransformersEmbeddingClient();
    const result = await client.embed(["test text"]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].length, 384); // Xenova/all-MiniLM-L6-v2 outputs 384-dimensional embeddings
    assert.ok(typeof result[0][0] === "number");
  });
});
