import { createHash } from "node:crypto";
import type { Message, MessagesRequest } from "./types";

function isToolResultMessage(message: Message): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * True when the last message is genuine user text (a fresh turn), false when
 * it carries tool_result blocks (a continuation of the same turn's tool loop).
 */
export function isNewUserTurn(req: MessagesRequest): boolean {
  const messages = req.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return false;
  return !isToolResultMessage(last);
}

function lastUserTextIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && !isToolResultMessage(message)) return i;
  }
  return messages.length - 1;
}

/**
 * Stable key for a user turn: a hash of the conversation prefix up to and
 * including the latest user-text message. Identical across every tool
 * round-trip of the turn, so a routing decision can be pinned for the turn.
 */
export function turnKey(req: MessagesRequest): string {
  const messages = req.messages ?? [];
  const prefix = messages.slice(0, lastUserTextIndex(messages) + 1);
  return createHash("sha1").update(JSON.stringify(prefix)).digest("hex");
}

export type PinValue = "simple" | "complex";

export interface PinCache {
  get(key: string): PinValue | undefined;
  set(key: string, value: PinValue): void;
}

export function createPinCache(ttlMs = 10 * 60 * 1000): PinCache {
  const store = new Map<string, { value: PinValue; expires: number }>();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expires < Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}
