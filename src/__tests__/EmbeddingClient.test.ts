import { describe, it } from "node:test";
import assert from "node:assert";
import {
  MockEmbeddingClient,
  TransformersEmbeddingClient,
  vectorToBlob,
  blobToVector,
  cosineSimilarityFloat32,
  EMBEDDING_DIMENSION,
  EMBEDDING_BLOB_SIZE,
} from "../embeddings.js";

describe("EmbeddingClient & Binary Vector Tests", () => {
  it("MockEmbeddingClient returns vectors corresponding directly to the length of the input texts", async () => {
    const client = new MockEmbeddingClient();
    const result = await client.embed(["hello", "world"]);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].length, EMBEDDING_DIMENSION);
    assert.strictEqual(result[1].length, EMBEDDING_DIMENSION);
  });

  it("TransformersEmbeddingClient returns correct vectors when running", async () => {
    const client = new TransformersEmbeddingClient();
    const result = await client.embed(["test text"]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].length, EMBEDDING_DIMENSION);
    assert.ok(typeof result[0][0] === "number");
  });

  describe("Binary BLOB Vector Serialization & Deserialization", () => {
    it("vectorToBlob serializes Float32Array to 1,536-byte buffer", () => {
      const vector = new Float32Array(EMBEDDING_DIMENSION);
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        vector[i] = i * 0.01;
      }
      const blob = vectorToBlob(vector);
      assert.strictEqual(blob.byteLength, EMBEDDING_BLOB_SIZE);
      assert.ok(Buffer.isBuffer(blob));
    });

    it("vectorToBlob serializes number[] to 1,536-byte buffer", () => {
      const vector = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => i * 0.05);
      const blob = vectorToBlob(vector);
      assert.strictEqual(blob.byteLength, EMBEDDING_BLOB_SIZE);
    });

    it("vectorToBlob throws error on dimension mismatch", () => {
      assert.throws(() => {
        vectorToBlob(new Float32Array(10));
      }, /Invalid vector dimension/);

      assert.throws(() => {
        vectorToBlob([1, 2, 3]);
      }, /Invalid vector dimension/);
    });

    it("blobToVector restores exact float coordinates with zero-copy view", () => {
      const original = new Float32Array(EMBEDDING_DIMENSION);
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        original[i] = (i - 192) * 0.12345;
      }
      const blob = vectorToBlob(original);
      const restored = blobToVector(blob);

      assert.strictEqual(restored.length, EMBEDDING_DIMENSION);
      assert.ok(restored instanceof Float32Array);
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        assert.ok(
          Math.abs(restored[i] - original[i]) < 1e-6,
          `Mismatch at index ${i}: expected ${original[i]}, got ${restored[i]}`
        );
      }
    });

    it("blobToVector safely handles unaligned byte offsets in memory buffers", () => {
      const rawBuffer = Buffer.alloc(EMBEDDING_BLOB_SIZE + 7);
      const unalignedSlice = rawBuffer.subarray(3, 3 + EMBEDDING_BLOB_SIZE);

      // Write test floats into unaligned slice
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        unalignedSlice.writeFloatLE(i * 1.5, i * 4);
      }

      const restored = blobToVector(unalignedSlice);
      assert.strictEqual(restored.length, EMBEDDING_DIMENSION);
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        assert.ok(
          Math.abs(restored[i] - i * 1.5) < 1e-5,
          `Unaligned mismatch at ${i}: expected ${i * 1.5}, got ${restored[i]}`
        );
      }
    });

    it("blobToVector throws error on invalid blob byte length", () => {
      assert.throws(() => {
        blobToVector(Buffer.alloc(100));
      }, /Invalid embedding blob byte length/);

      assert.throws(() => {
        blobToVector(Buffer.alloc(EMBEDDING_BLOB_SIZE + 1));
      }, /Invalid embedding blob byte length/);
    });
  });

  describe("cosineSimilarityFloat32 Math & Tolerance Tests", () => {
    it("returns 1.0 for identical vectors within epsilon tolerance", () => {
      const vec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const sim = cosineSimilarityFloat32(vec, vec);
      assert.ok(Math.abs(sim - 1.0) < 1e-5, `Expected ~1.0, got ${sim}`);
    });

    it("returns 0.0 for orthogonal vectors within epsilon tolerance", () => {
      const vecA = new Float32Array([1.0, 0.0, 0.0, 0.0]);
      const vecB = new Float32Array([0.0, 1.0, 0.0, 0.0]);
      const sim = cosineSimilarityFloat32(vecA, vecB);
      assert.ok(Math.abs(sim - 0.0) < 1e-5, `Expected ~0.0, got ${sim}`);
    });

    it("returns -1.0 for opposite vectors within epsilon tolerance", () => {
      const vecA = new Float32Array([1.0, 2.0, 3.0]);
      const vecB = new Float32Array([-1.0, -2.0, -3.0]);
      const sim = cosineSimilarityFloat32(vecA, vecB);
      assert.ok(Math.abs(sim - (-1.0)) < 1e-5, `Expected ~-1.0, got ${sim}`);
    });

    it("returns 0.0 when comparing against all-zero vectors without NaN", () => {
      const vecA = new Float32Array([0, 0, 0, 0]);
      const vecB = new Float32Array([1, 2, 3, 4]);
      const sim = cosineSimilarityFloat32(vecA, vecB);
      assert.strictEqual(sim, 0);
      assert.ok(!Number.isNaN(sim));
    });

    it("throws error on vector length mismatch", () => {
      assert.throws(() => {
        cosineSimilarityFloat32(new Float32Array([1, 2]), new Float32Array([1, 2, 3]));
      }, /Vector length mismatch/);
    });
  });
});

