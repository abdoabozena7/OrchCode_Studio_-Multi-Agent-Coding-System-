import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { AlgorithmInventoryFacts } from "./InspectExplainFacts.js";

export function analyzeAlgorithmInventory(
  workspace: WorkspaceTools,
  filePaths: string[]
): AlgorithmInventoryFacts {
  const inspectedFiles: string[] = [];
  const uncertainties: string[] = [];
  const items: AlgorithmInventoryFacts["items"] = [];

  const pyFiles = filePaths.filter(f => 
    /\.(py)$/i.test(f) &&
    !/(node_modules|\.git|__pycache__|venv|\.venv)/i.test(f)
  );

  for (const file of pyFiles) {
    inspectedFiles.push(file);
    let content = "";
    try {
      content = workspace.readWholeFile(file);
    } catch {
      continue;
    }

    const add = (name: string, canonicalName: string, classification: AlgorithmInventoryFacts["items"][0]["classification"], description: string) => {
      items.push({ name, canonicalName, classification, description, sourceRef: file, confidence: "high" });
    };

    if (/\b(SVC|LinearSVC|SVM)\b/.test(content)) {
      add("SVM", "svm", "predictive_model", "Support Vector Machine classifier");
    }
    if (/\bDBSCAN\b/.test(content)) {
      add("DBSCAN", "dbscan", "clustering_algorithm", "Density-based spatial clustering");
    }
    if (/\b(Fuzzy\s*C[-\s]?Means|FCM|cmeans)\b/i.test(content) || /skfuzzy/.test(content)) {
      add("Fuzzy C-Means", "fcm", "clustering_algorithm", "Fuzzy C-Means clustering");
    }
    if (/\b(KMeans|MiniBatchKMeans)\b/.test(content)) {
      add("KMeans", "kmeans", "clustering_algorithm", "K-Means clustering");
    }
    if (/\bSARIMAX?\b/.test(content) || /statsmodels\.tsa\.statespace\.sarimax/.test(content)) {
      add("SARIMA", "sarima", "forecasting_model", "Seasonal ARIMA forecasting");
    }
    if (/\bARIMA\b/.test(content) && !/\bSARIMAX/.test(content)) {
      add("ARIMA", "arima", "forecasting_model", "ARIMA forecasting");
    }
    if (/\bshap\b/.test(content)) {
      add("SHAP", "shap", "explainability_method", "SHAP values for model explainability");
    }
    if (/\b(RandomForestClassifier|RandomForestRegressor)\b/.test(content)) {
      add("Random Forest", "random_forest", "predictive_model", "Random Forest ensemble");
    }
    if (/\b(LogisticRegression)\b/.test(content)) {
      add("Logistic Regression", "logistic_regression", "predictive_model", "Logistic Regression classifier");
    }

    // Detect wrapper classes
    const classMatch = content.matchAll(/class\s+([A-Za-z0-9_]+(?:Model|Classifier|Clusterer|Predictor|Wrapper|Service))\b/g);
    for (const match of classMatch) {
      const name = match[1];
      if (name && !items.some(i => i.sourceRef === file && i.name === name)) {
         items.push({
           name: name,
           canonicalName: name.toLowerCase(),
           classification: "service_wrapper",
           description: "Custom class wrapping ML logic",
           sourceRef: file,
           confidence: "medium"
         });
      }
    }
  }

  // Deduplicate
  const uniqueItems = new Map<string, typeof items[0]>();
  for (const item of items) {
    if (!uniqueItems.has(item.canonicalName)) {
      uniqueItems.set(item.canonicalName, item);
    } else if (item.classification !== "service_wrapper") {
      uniqueItems.set(item.canonicalName, item); // Prefer actual algorithm over wrapper
    }
  }

  const finalItems = Array.from(uniqueItems.values());

  return {
    kind: "algorithm_inventory",
    items: finalItems,
    deduplicatedCount: finalItems.length,
    inspectedFiles,
    uncertainties
  };
}
