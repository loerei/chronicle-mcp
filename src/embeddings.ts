import { pipeline, env } from "@huggingface/transformers";
import path from "node:path";
import os from "node:os";

// Normalize cache directory for Windows compatibility (avoid mixed slashes)
env.cacheDir = path.resolve(os.homedir(), ".cache", "huggingface");

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
