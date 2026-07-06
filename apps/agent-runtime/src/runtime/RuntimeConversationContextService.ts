import type { AgentRuntimeSession } from "@hivo/protocol";
import {
  REASONING_CONVERSATION_CONTEXT_MAX_CHARS,
  REASONING_CONVERSATION_CONTEXT_MAX_MESSAGES,
  type ReasoningConversationContext
} from "./ReasoningKernel.js";

export class RuntimeConversationContextService {
  buildSameSession(session: AgentRuntimeSession, currentMessage: string): ReasoningConversationContext {
    const priorMessages = previousMessagesForCurrentTurn(session.messages, currentMessage);
    const scopedAgentMessages = buildScopedAgentContextMessages(session);
    const candidates = [...priorMessages, ...scopedAgentMessages]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-REASONING_CONVERSATION_CONTEXT_MAX_MESSAGES);
    const messages = selectConversationContextMessages(candidates, REASONING_CONVERSATION_CONTEXT_MAX_CHARS);
    const totalOriginalChars = candidates.reduce((sum, message) => sum + message.content.length, 0);
    const totalIncludedChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    return {
      source: "same_session_messages",
      sessionId: session.id,
      currentMessage,
      maxMessages: REASONING_CONVERSATION_CONTEXT_MAX_MESSAGES,
      maxChars: REASONING_CONVERSATION_CONTEXT_MAX_CHARS,
      omittedMessageCount: Math.max(0, candidates.length - messages.length),
      truncatedMessageCount: messages.filter((message) => message.truncated).length,
      totalOriginalChars,
      totalIncludedChars,
      createdAt: new Date().toISOString(),
      messages
    };
  }
}

function buildScopedAgentContextMessages(session: AgentRuntimeSession): AgentRuntimeSession["messages"] {
  const state = session.swarmState;
  if (!state?.messages.length) return [];
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  return state.messages.slice(-12).map((message) => {
    const node = nodesById.get(message.agentId);
    const label = node ? `${node.name} (${node.role})` : message.agentId;
    return {
      id: message.id,
      role: message.role === "agent" ? "assistant" : message.role,
      content: `[Scoped agent message for ${label}]\n${message.content}`,
      providerRequestRefs: message.providerRequestRefs,
      createdAt: message.createdAt
    };
  });
}

function previousMessagesForCurrentTurn(
  messages: AgentRuntimeSession["messages"],
  currentMessage: string
): AgentRuntimeSession["messages"] {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "user" && normalizeConversationContent(lastMessage.content) === normalizeConversationContent(currentMessage)) {
    return messages.slice(0, -1);
  }
  return messages;
}

function selectConversationContextMessages(
  messages: AgentRuntimeSession["messages"],
  maxChars: number
): ReasoningConversationContext["messages"] {
  const selected: ReasoningConversationContext["messages"] = [];
  let remainingChars = maxChars;
  const minReservedCharsPerOlderMessage = 200;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.content) continue;
    const reserveForOlderMessages = Math.min(remainingChars, index * minReservedCharsPerOlderMessage);
    const allowedChars = Math.max(0, remainingChars - reserveForOlderMessages);
    if (allowedChars <= 0) continue;
    const content = truncateConversationContent(message.content, allowedChars);
    if (!content) continue;
    selected.push({
      role: message.role,
      content,
      createdAt: message.createdAt,
      originalChars: message.content.length,
      truncated: content.length < message.content.length
    });
    remainingChars -= content.length;
    if (remainingChars <= 0) break;
  }
  return selected.reverse();
}

function truncateConversationContent(content: string, maxChars: number) {
  if (content.length <= maxChars) return content;
  if (maxChars <= 3) return content.slice(0, Math.max(0, maxChars));
  return `${content.slice(0, maxChars - 3)}...`;
}

function normalizeConversationContent(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
