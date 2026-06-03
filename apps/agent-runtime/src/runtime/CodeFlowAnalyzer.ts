import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { CodeFlowFacts, AlgorithmInventoryFacts } from "./InspectExplainFacts.js";

export function analyzeCodeFlow(
  workspace: WorkspaceTools,
  filePaths: string[],
  algorithmFacts?: AlgorithmInventoryFacts,
  targetConcept = ""
): CodeFlowFacts {
  const inspectedFiles: string[] = [];
  const uncertainties: string[] = [];
  const steps: CodeFlowFacts["steps"] = [];

  const canonicalTarget = targetConcept.toLowerCase();

  if (canonicalTarget && canonicalTarget !== "svm" && canonicalTarget !== "pipeline" && canonicalTarget !== "general") {
     const aliases = conceptAliases(canonicalTarget);
     const pyFiles = filePaths.filter(f => /\.(py)$/i.test(f));
     for (const file of pyFiles) {
       inspectedFiles.push(file);
       let content = "";
       try {
         content = workspace.readWholeFile(file);
       } catch {
         continue;
       }
       const lines = content.split(/\r?\n/);
       for (const [index, line] of lines.entries()) {
         const normalizedLine = line.toLowerCase();
         if (!aliases.some((alias) => normalizedLine.includes(alias))) continue;
         const snippet = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 7)).join("\n");
         steps.push({
           order: steps.length + 1,
           label: `${canonicalTarget} implementation`,
           description: summarizeConceptLine(canonicalTarget, snippet),
           sourceRef: file,
           proven: true,
           inputData: (snippet.match(/\b(features|payload|data|records|labels|background)\b/i)?.[1]),
           output: (snippet.match(/^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*=/m)?.[1]),
           parameters: extractCallArgs(snippet),
           nextConsumers: Array.from(snippet.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:labels|clusters|memberships|state|segments))\b/g)).map((match) => match[1] ?? "").slice(0, 6),
           sourceRole: sourceRoleForPath(file),
           confidence: sourceRoleForPath(file) === "implementation" ? "high" : "medium"
         });
       }
     }
  } else if (algorithmFacts?.items.some(i => i.canonicalName === "svm")) {
     let hasClustering = false;
     let hasSvm = false;
     let hasPredict = false;
     let hasShap = false;
     let hasRoute = false;

     let clusteringSource = "";
     let svmSource = "";
     let predictSource = "";
     let shapSource = "";
     let routeSource = "";

     const pyFiles = filePaths.filter(f => /\.(py)$/i.test(f));
     for (const file of pyFiles) {
       inspectedFiles.push(file);
       let content = "";
       try {
         content = workspace.readWholeFile(file);
       } catch {
         continue;
       }
       
       if (/DBSCAN|Fuzzy\s*C[-\s]?Means|FCM|cmeans/i.test(content)) {
         hasClustering = true;
         clusteringSource = file;
       }
       if (/SVC|LinearSVC|SVM/i.test(content) && /fit/i.test(content)) {
         hasSvm = true;
         svmSource = file;
       }
       if (/predict/i.test(content)) {
         hasPredict = true;
         predictSource = file;
       }
       if (/shap/i.test(content)) {
         hasShap = true;
         shapSource = file;
       }
       if (/routes?\.py|api|endpoint/i.test(file)) {
         hasRoute = true;
         routeSource = file;
       }
     }

     let order = 1;
     if (hasClustering) steps.push({ order: order++, label: "upstream-clustering", description: "Clustering/labels are prepared before SVM", sourceRef: clusteringSource, proven: true, sourceRole: sourceRoleForPath(clusteringSource), confidence: "high" });
     if (hasSvm) steps.push({ order: order++, label: "training", description: "SVM is trained on features and labels", sourceRef: svmSource, proven: true, sourceRole: sourceRoleForPath(svmSource), confidence: "high" });
     if (hasPredict) steps.push({ order: order++, label: "prediction", description: "Predicts state for new data", sourceRef: predictSource, proven: true, sourceRole: sourceRoleForPath(predictSource), confidence: sourceRoleForPath(predictSource) === "implementation" ? "high" : "medium" });
     if (hasShap) steps.push({ order: order++, label: "explainability", description: "SHAP explains predictions", sourceRef: shapSource, proven: true, sourceRole: sourceRoleForPath(shapSource), confidence: sourceRoleForPath(shapSource) === "implementation" ? "high" : "medium" });
     if (hasRoute) steps.push({ order: order++, label: "usage", description: "Results used in API flow", sourceRef: routeSource, proven: true, sourceRole: sourceRoleForPath(routeSource), confidence: "medium" });
  }

  return {
    kind: "code_flow",
    steps,
    inspectedFiles,
    uncertainties
  };
}

function conceptAliases(concept: string) {
  if (concept === "dbscan") return ["dbscan", "density-based", "fit_predict"];
  if (concept === "fcm") return ["fcm", "cmeans", "fuzzy c", "skfuzzy"];
  if (concept === "shap") return ["shap", "kernelexplainer", "shap_values"];
  if (concept === "sarima") return ["sarima", "sarimax", "arima"];
  if (concept === "multi_agent_system") {
    return [
      "baseagent",
      "reliabilityagent",
      "forecastagent",
      "clusterhealthagent",
      "build_default_agents",
      "reactorchestrator",
      "agent_recommendations",
      "agent_consensus",
      "weighted_votes",
      "choose_route",
      "actionexecutor"
    ];
  }
  return [concept];
}

function summarizeConceptLine(concept: string, snippet: string) {
  if (concept === "dbscan") return "DBSCAN is applied in the clustering implementation, including its call, arguments, and assigned output.";
  if (concept === "fcm") return "Fuzzy C-Means is applied in the clustering implementation, including memberships or labels.";
  if (concept === "multi_agent_system") {
    if (/\bbuild_default_agents\b/i.test(snippet)) return "Default specialist agents are assembled for runtime decision support.";
    if (/\bclass\s+(?:BaseAgent|ReliabilityAgent|ForecastAgent|ClusterHealthAgent)\b/i.test(snippet)) return "A specialist agent class contributes recommendations, reasoning, or vote weight.";
    if (/\bchoose_route\b|\bweighted_votes\b/i.test(snippet)) return "The central orchestrator weighs agent recommendations and chooses the final route.";
    if (/\bagent_recommendations\b|\bagent_consensus\b/i.test(snippet)) return "Runtime traces keep agent recommendations and consensus visible for the decision.";
    if (/\bActionExecutor\b/i.test(snippet)) return "The chosen route/action is handed to the action executor.";
    return "This code is part of the specialist-agent and orchestrator decision path.";
  }
  return `This code block contains target-specific evidence for ${concept}.`;
}

function extractCallArgs(snippet: string) {
  const args: string[] = [];
  for (const match of snippet.matchAll(/\b[A-Za-z_][A-Za-z0-9_.]*\s*\(([^()\n]*)\)/g)) {
    args.push(...(match[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  }
  return Array.from(new Set(args)).slice(0, 10);
}

function sourceRoleForPath(path: string) {
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(path)) return "test";
  if (/\.(md|txt)$/i.test(path) || /(^|\/)docs?\//i.test(path)) return "documentation";
  if (/routes?|api|controller|endpoint/i.test(path)) return "orchestration";
  return "implementation";
}
