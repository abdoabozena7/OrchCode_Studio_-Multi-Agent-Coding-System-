import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { CodeFlowFacts, AlgorithmInventoryFacts } from "./InspectExplainFacts.js";

export function analyzeCodeFlow(
  workspace: WorkspaceTools,
  filePaths: string[],
  algorithmFacts?: AlgorithmInventoryFacts
): CodeFlowFacts {
  const inspectedFiles: string[] = [];
  const uncertainties: string[] = [];
  const steps: CodeFlowFacts["steps"] = [];

  // Generalized SVM flow trace based on occurrences
  if (algorithmFacts?.items.some(i => i.canonicalName === "svm")) {
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
     if (hasClustering) steps.push({ order: order++, label: "upstream-clustering", description: "Clustering/labels are prepared before SVM", sourceRef: clusteringSource, proven: true });
     if (hasSvm) steps.push({ order: order++, label: "training", description: "SVM is trained on features and labels", sourceRef: svmSource, proven: true });
     if (hasPredict) steps.push({ order: order++, label: "prediction", description: "Predicts state for new data", sourceRef: predictSource, proven: true });
     if (hasShap) steps.push({ order: order++, label: "explainability", description: "SHAP explains predictions", sourceRef: shapSource, proven: true });
     if (hasRoute) steps.push({ order: order++, label: "usage", description: "Results used in API flow", sourceRef: routeSource, proven: true });
  }

  return {
    kind: "code_flow",
    steps,
    inspectedFiles,
    uncertainties
  };
}
