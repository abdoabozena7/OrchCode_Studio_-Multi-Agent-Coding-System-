export class AgentPool {
  constructor(
    readonly agents: string[],
    readonly maxParallelAgents: number
  ) {}

  hasAgent(name: string) {
    return this.agents.includes(name);
  }
}
