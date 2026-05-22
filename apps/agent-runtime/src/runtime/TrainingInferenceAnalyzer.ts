import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { TrainingInferenceFacts } from "./InspectExplainFacts.js";

export function analyzeTrainingInference(
  workspace: WorkspaceTools,
  filePaths: string[]
): TrainingInferenceFacts {
  const inspectedFiles: string[] = [];
  const uncertainties: string[] = [];
  
  const training: TrainingInferenceFacts["training"] = [];
  const inference: TrainingInferenceFacts["inference"] = [];
  const persistence: TrainingInferenceFacts["persistence"] = [];

  const pyFiles = filePaths.filter(f => 
    /\.(py|ipynb)$/i.test(f) &&
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

    // Training
    if (/\bdef\s+(train|fit|build_model)[_A-Za-z0-9]*\b/.test(content)) {
      const matches = content.matchAll(/\bdef\s+((?:train|fit|build_model)[_A-Za-z0-9]*)\b/g);
      for (const m of matches) {
        if (m[1]) training.push({ name: m[1], type: "function", sourceRef: file });
      }
    }
    if (/\bclass\s+[A-Za-z0-9]*(?:Trainer|Builder)\b/.test(content)) {
      const matches = content.matchAll(/\bclass\s+([A-Za-z0-9]*(?:Trainer|Builder))\b/g);
      for (const m of matches) {
         if (m[1]) training.push({ name: m[1], type: "class", sourceRef: file });
      }
    }

    // Inference
    if (/\bdef\s+(predict|infer|classify|forecast)[_A-Za-z0-9]*\b/.test(content)) {
      const matches = content.matchAll(/\bdef\s+((?:predict|infer|classify|forecast)[_A-Za-z0-9]*)\b/g);
      for (const m of matches) {
        if (m[1]) inference.push({ name: m[1], type: "function", sourceRef: file });
      }
    }

    // Persistence
    if (/\b(joblib\.dump|pickle\.dump|save_model)\b/.test(content)) {
      persistence.push({ method: "save", sourceRef: file });
    }
    if (/\b(joblib\.load|pickle\.load|load_model)\b/.test(content)) {
      persistence.push({ method: "load", sourceRef: file });
    }
  }

  let separation: TrainingInferenceFacts["separation"] = "unclear";
  if (training.length > 0 && inference.length > 0) {
    const trainingFiles = new Set(training.map(t => t.sourceRef));
    const inferenceFiles = new Set(inference.map(i => i.sourceRef));
    
    // Check intersection
    const intersection = [...trainingFiles].filter(x => inferenceFiles.has(x));
    if (intersection.length === 0) {
      separation = "yes";
    } else {
      separation = "partial";
    }
  } else if (training.length > 0 || inference.length > 0) {
    separation = "no";
  }

  return {
    kind: "training_inference",
    separation,
    training,
    inference,
    persistence,
    inspectedFiles,
    uncertainties
  };
}
