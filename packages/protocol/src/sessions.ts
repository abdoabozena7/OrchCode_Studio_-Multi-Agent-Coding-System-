import type { AgentStatus, Session, Task } from "./models.js";

export type CreateSessionRequest = {
  userPrompt: string;
};

export type CreateSessionResponse = {
  session: Session;
  tasks: Task[];
  agents: AgentStatus[];
};
