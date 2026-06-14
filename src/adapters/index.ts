import { HistoryAdapter } from "./types.js";
import { AntigravityAdapter } from "./Antigravity.js";
import { CursorAdapter } from "./Cursor.js";

export const ADAPTERS: HistoryAdapter[] = [
  new AntigravityAdapter(),
  new CursorAdapter(),
];

export * from "./types.js";
