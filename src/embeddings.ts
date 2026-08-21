import { pipeline, env } from "@huggingface/transformers";
import path from "node:path";
import os from "node:os";

// Normalize cache directory for Windows compatibility (avoid mixed slashes)
env.cacheDir = path.resolve(os.homedir(), ".cache", "huggingface");

export const EMBEDDING_DIMENSION = 384;
export const EMBEDDING_BLOB_SIZE = 1536; // 384 dimensions * 4 bytes per Float32

/**
 * Serializes a 384-dimensional vector (Float32Array or number[]) into an exact 1,536-byte binary Buffer.
 */
export function vectorToBlob(vector: Float32Array | number[]): Buffer {
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Invalid vector dimension: expected ${EMBEDDING_DIMENSION}, received ${vector.length}`
    );
  }

  if (vector instanceof Float32Array) {
    if (vector.byteOffset % 4 === 0 && vector.byteLength === EMBEDDING_BLOB_SIZE) {
      return Buffer.from(vector.buffer, vector.byteOffset, EMBEDDING_BLOB_SIZE);
    }
    const aligned = new Float32Array(vector);
    return Buffer.from(aligned.buffer, aligned.byteOffset, EMBEDDING_BLOB_SIZE);
  }

  const float32 = new Float32Array(vector);
  return Buffer.from(float32.buffer, float32.byteOffset, EMBEDDING_BLOB_SIZE);
}

/**
 * Deserializes a 1,536-byte binary Buffer into a Float32Array.
 * Utilizes a zero-copy view when 4-byte memory aligned, with safe copy fallback.
 */
export function blobToVector(blob: Buffer): Float32Array {
  if (blob.byteLength !== EMBEDDING_BLOB_SIZE) {
    throw new Error(
      `Invalid embedding blob byte length: expected ${EMBEDDING_BLOB_SIZE}, received ${blob.byteLength}`
    );
  }

  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIMENSION);
  }

  // Safe fallback for unaligned buffer slices: copy into aligned ArrayBuffer
  const copyBuffer = new ArrayBuffer(EMBEDDING_BLOB_SIZE);
  new Uint8Array(copyBuffer).set(
    new Uint8Array(blob.buffer, blob.byteOffset, EMBEDDING_BLOB_SIZE)
  );
  return new Float32Array(copyBuffer, 0, EMBEDDING_DIMENSION);
}

/**
 * Computes cosine similarity between two float vectors.
 * Handles both Float32Array and number[] arrays with zero-magnitude guard.
 */
export function cosineSimilarityFloat32(
  a: Float32Array | number[],
  b: Float32Array | number[]
): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i];
    const valB = b[i];
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

let extractor: any = null;

export async function getExtractor() {
  if (extractor) {
    return extractor;
  }
  
  // Disable native/local path warnings and log noise
  // pipeline returns a singleton or cached pipeline instance
  extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    device: "cpu", // Force CPU execution to avoid GPU driver issues on server environment
  });
  return extractor;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const pipe = await getExtractor();
  // Generate embedding with mean pooling and L2 normalization
  const output = await pipe(text, { pooling: "mean", normalize: true });
  // output.data is a Float32Array containing the vector coordinates
  return Array.from(output.data);
}

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

export class TransformersEmbeddingClient implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => getEmbedding(text)));
  }
}

export class MockEmbeddingClient implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 0]);
  }
}

let currentClient: EmbeddingClient = new TransformersEmbeddingClient();

export function getEmbeddingClient(): EmbeddingClient {
  return currentClient;
}

export function setEmbeddingClient(client: EmbeddingClient): void {
  currentClient = client;
}
