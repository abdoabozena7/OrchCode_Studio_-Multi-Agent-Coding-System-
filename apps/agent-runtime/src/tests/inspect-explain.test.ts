import assert from "node:assert/strict";
import test from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { classifyIntent } from "../runtime/CodingAgentIntentRouter.js";
import { analyzeFrontendStructure } from "../runtime/FrontendStructureAnalyzer.js";
import { analyzeAlgorithmInventory } from "../runtime/AlgorithmInventoryAnalyzer.js";
import { analyzeTrainingInference } from "../runtime/TrainingInferenceAnalyzer.js";
import { analyzeUIControls } from "../runtime/UIControlAnalyzer.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

test("CodingAgentIntentRouter: Routing exactly matches requirements", () => {
  // 1. Exact reported prompts
  assert.equal(classifyIntent("عندي هنا كام صفحه ف السيستم دا وكل واحده بتعمل ايه ؟"), "inspect_explain");
  assert.equal(classifyIntent("عندنا كام algorithm هنا؟ واشرحهم واحده واحده."), "inspect_explain");
  assert.equal(classifyIntent("ازاي الsvm بيتطبق هنا ؟ اشرح بالتفصيل"), "inspect_explain");
  assert.equal(classifyIntent("هل عندي training و inference منفصلين هنا؟ كل واحد فين وبيعمل إيه؟"), "inspect_explain");

  // 2. English equivalents
  assert.equal(classifyIntent("How many pages are in this system and what does each do?"), "inspect_explain");
  assert.equal(classifyIntent("How many algorithms do we have here? Explain them one by one."), "inspect_explain");
  assert.equal(classifyIntent("How is SVM applied here? Explain in detail"), "inspect_explain");
  assert.equal(classifyIntent("Are training and inference separated here? Where is each and what does it do?"), "inspect_explain");

  // 3. Locate code
  assert.equal(classifyIntent("Where is the user login logic?"), "locate_code");
  assert.equal(classifyIntent("فين الكود بتاع الدفع؟"), "locate_code");

  // 4. Architecture
  assert.equal(classifyIntent("How does the architecture work?"), "architecture_reasoning");
  assert.equal(classifyIntent("شغال ازاي السيستم ده؟"), "architecture_reasoning");

  // 5. Plan change
  assert.equal(classifyIntent("How to add a new user role? Plan first."), "plan_change");
  
  // 6. Action wins if explicit
  assert.equal(classifyIntent("Explain the SVM algorithm and then change it to use Random Forest"), "edit");
  assert.equal(classifyIntent("اشرح الكود ده وبعدين غيره"), "edit");

  // 7. Explicit run/debug/verify
  assert.equal(classifyIntent("Run the server"), "run");
  assert.equal(classifyIntent("Debug the crash in main.py"), "debug");
  assert.equal(classifyIntent("Test the auth logic"), "verify");
});

test("Generic Analyzers: Frontend Structure", async () => {
  const workspace = await createFixtureWorkspace("frontend-test");
  try {
    const tools = new ToolRegistry(workspace);
    await mkdir(path.join(workspace, "src"), { recursive: true });
    
    // Test ignores CSS
    await writeFile(path.join(workspace, "src", "styles.css"), "body { color: red; }");
    
    // React Router detection
    await writeFile(path.join(workspace, "src", "App.jsx"), `
      import { BrowserRouter, Routes, Route } from 'react-router-dom';
      function App() {
        return (
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/about" element={<AboutPage />} />
            </Routes>
          </BrowserRouter>
        );
      }
    `);

    // HTML section detection
    await writeFile(path.join(workspace, "index.html"), `
      <html><body>
        <section id="header"></section>
        <section id="footer"></section>
      </body></html>
    `);

    const files = [
      path.join(workspace, "src", "styles.css"),
      path.join(workspace, "src", "App.jsx"),
      path.join(workspace, "index.html")
    ];

    const facts = analyzeFrontendStructure(tools.workspace, files);
    assert.equal(facts.hasRouter, true, "Should detect router");
    assert.equal(facts.isSinglePageApp, false, "Should not be a single page app if it has router");
    assert.equal(facts.totalItems, 4, "Should find 2 routes and 2 sections");
    
    const itemNames = facts.items.map(i => i.name);
    assert.ok(itemNames.includes("/"));
    assert.ok(itemNames.includes("/about"));
    assert.ok(itemNames.includes("header"));
    assert.ok(itemNames.includes("footer"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Generic Analyzers: Algorithm Inventory", async () => {
  const workspace = await createFixtureWorkspace("algorithm-test");
  try {
    const tools = new ToolRegistry(workspace);
    await mkdir(path.join(workspace, "ml"), { recursive: true });
    
    await writeFile(path.join(workspace, "ml", "models.py"), `
      from sklearn.svm import SVC
      from sklearn.cluster import DBSCAN
      import skfuzzy as fuzz
      from statsmodels.tsa.statespace.sarimax import SARIMAX
      import shap
      
      class MyCustomServiceWrapper:
         pass
    `);

    const files = [path.join(workspace, "ml", "models.py")];
    const facts = analyzeAlgorithmInventory(tools.workspace, files);
    
    const names = facts.items.map(i => i.canonicalName);
    assert.ok(names.includes("svm"), "Should detect SVM");
    assert.ok(names.includes("dbscan"), "Should detect DBSCAN");
    assert.ok(names.includes("fcm"), "Should detect Fuzzy C-Means");
    assert.ok(names.includes("sarima"), "Should detect SARIMA");
    assert.ok(names.includes("shap"), "Should detect SHAP");
    assert.ok(names.includes("mycustomservicewrapper"), "Should detect wrapper");
    
    assert.equal(facts.deduplicatedCount, 6);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Generic Analyzers: Training and Inference", async () => {
  const workspace = await createFixtureWorkspace("train-infer-test");
  try {
    const tools = new ToolRegistry(workspace);
    
    await writeFile(path.join(workspace, "train.py"), `
      def build_model():
         pass
      def train_model():
         pass
      import joblib
      joblib.dump(model, 'model.pkl')
    `);

    await writeFile(path.join(workspace, "predict.py"), `
      def predict_label():
         pass
      import joblib
      model = joblib.load('model.pkl')
    `);

    const files = [path.join(workspace, "train.py"), path.join(workspace, "predict.py")];
    const facts = analyzeTrainingInference(tools.workspace, files);
    
    assert.equal(facts.separation, "yes", "Should detect separated training and inference");
    assert.equal(facts.training.length, 2, "Should find 2 training functions");
    assert.equal(facts.inference.length, 1, "Should find 1 inference function");
    assert.equal(facts.persistence.length, 2, "Should find dump and load");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Generic Analyzers: UI Controls", async () => {
  const workspace = await createFixtureWorkspace("ui-controls-test");
  try {
    const tools = new ToolRegistry(workspace);
    
    await writeFile(path.join(workspace, "index.html"), `
      <button onclick="startPipeline()">Start</button>
      <input type="submit" value="Upload Dataset" />
      <a class="btn primary" href="/export">Export</a>
    `);

    await writeFile(path.join(workspace, "App.jsx"), `
      import React, { useState } from 'react';
      function App() {
        const [data, setData] = useState(null);
        function handleRefresh() {
          fetch('/api/data').then(res => setData(res));
        }
        return <button onClick={handleRefresh} aria-label="Refresh Dashboard">Refresh</button>;
      }
      export default App;
    `);

    const files = [path.join(workspace, "index.html"), path.join(workspace, "App.jsx")];
    const facts = analyzeUIControls(tools.workspace, files);
    
    assert.equal(facts.controls.length, 4, "Should find 4 UI controls");

    const btn1 = facts.controls.find(c => c.text === "Start");
    assert.ok(btn1);
    assert.equal(btn1?.action, "startPipeline()");
    
    const btn2 = facts.controls.find(c => c.text === "Upload Dataset");
    assert.ok(btn2);
    assert.equal(btn2?.type, "submit_input");

    const btn3 = facts.controls.find(c => c.text === "Export");
    assert.ok(btn3);
    assert.equal(btn3?.action, "Navigate to /export");

    const btn4 = facts.controls.find(c => c.text === "Refresh Dashboard" || c.text === "Refresh");
    assert.ok(btn4);
    assert.ok(btn4?.action?.includes("handleRefresh"));
    assert.ok(btn4?.action?.includes("Makes API call"), "Should detect fetch call inside handler");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
