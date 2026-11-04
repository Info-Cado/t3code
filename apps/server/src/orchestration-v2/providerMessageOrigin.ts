import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";

export function withProviderMessageOrigin(
  message: Pick<ProviderAdapterV2TurnMessage, "createdBy" | "senderThreadId">,
  text: string,
  driver: ProviderDriverKind,
): string {
  if (message.createdBy !== "agent" || message.senderThreadId === undefined) return text;
  if (driver === "pi" && /^\/compact(?:\s|$)/u.test(text.trim())) return text;
  return `[Message from another thread's agent (thread ${JSON.stringify(message.senderThreadId)}). An agent wrote this, not the human user. Act on it as that agent's request; the human user's own messages take priority.]\n\n${text}`;
}
