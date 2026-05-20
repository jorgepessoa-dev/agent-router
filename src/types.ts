export type Role = "user" | "assistant";

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolDef {
  name?: string;
  [key: string]: unknown;
}

/** Minimal subset of the Anthropic Messages API request we need to inspect. */
export interface MessagesRequest {
  model: string;
  messages: Message[];
  system?: string | ContentBlock[];
  tools?: ToolDef[];
  stream?: boolean;
  max_tokens?: number;
  thinking?: { type?: string; budget_tokens?: number };
  metadata?: { user_id?: string };
  [key: string]: unknown;
}
