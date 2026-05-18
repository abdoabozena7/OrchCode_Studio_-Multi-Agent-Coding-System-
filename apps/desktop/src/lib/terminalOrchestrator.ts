import type { AgentRuntimeSession, CommandRequest, SafetySettings } from "@orchcode/protocol";
import { executeApprovedCommand } from "./tauri";

type RuntimeCommandExecutionInput = {
  session: AgentRuntimeSession;
  request: CommandRequest;
  autoRun: boolean;
  safetySettings: Pick<
    SafetySettings,
    | "blockDangerousCommands"
    | "redactSecrets"
    | "allowNetworkCommands"
    | "autoRunMediumCommands"
    | "autoRunBackgroundCommands"
    | "autoRunNetworkCommands"
  >;
  sessionToken?: string;
};

export function canAutoRunRuntimeCommand(
  session: AgentRuntimeSession,
  request: CommandRequest,
  safetySettings: SafetySettings
) {
  const autonomyEnabled = session.accessProfile === "bounded_autonomy" || session.accessProfile === "auto_review" || session.accessProfile === "full_access";
  const alreadyTerminal =
    request.status === "executed" ||
    request.status === "failed" ||
    request.status === "blocked" ||
    request.status === "denied" ||
    request.status === "rejected";
  const hasUnappliedPatch = session.patchProposals.some((patch) => patch.status === "proposed" || patch.status === "approved");
  const riskAllowed =
    request.risk === "safe"
      ? safetySettings.autoRunSafeCommands
      : request.risk === "medium"
        ? safetySettings.autoRunMediumCommands
        : !safetySettings.blockDangerousCommands;
  const backgroundAllowed = !request.provenance?.background && !request.provenance?.backgroundDetected
    || safetySettings.autoRunBackgroundCommands;
  const networkAllowed = !request.provenance?.networkDetected || safetySettings.autoRunNetworkCommands;
  return autonomyEnabled
    && riskAllowed
    && backgroundAllowed
    && networkAllowed
    && !hasUnappliedPatch
    && !alreadyTerminal;
}

export async function executeRuntimeCommandRequest(input: RuntimeCommandExecutionInput) {
  return executeApprovedCommand(
    input.session.id,
    input.request.id,
    input.request.command,
    input.autoRun,
    input.safetySettings,
    input.sessionToken
  );
}
