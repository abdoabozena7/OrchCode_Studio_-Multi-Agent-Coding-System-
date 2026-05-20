import fs from "node:fs";
import path from "node:path";
import type {
  ProjectExplainEvidenceRef,
  ProjectExplainModule,
  ProjectExplainReport,
  ProjectExplainSection,
  ProjectIntake,
  ProjectMap
} from "@orchcode/protocol";
import { isSecretCandidate, resolveInsideWorkspace } from "../tools/security.js";
import {
  extractRequestedConcept,
  matchingConceptEvidenceGroups,
  textSupportsRequestedConcept,
  type RequestedConcept
} from "./ProjectQuestionGrounding.js";

export type ProjectExplainSettings = {
  maxExplainFiles: number;
  maxModuleSamples: number;
  maxFileReadChars: number;
  maxFinalAnswerChars: number;
};

type BuildProjectExplainReportInput = {
  workspacePath: string;
  message: string;
  projectMap: ProjectMap;
  intake?: ProjectIntake;
  settings?: Partial<ProjectExplainSettings>;
};

type InventoryFile = {
  path: string;
  ext: string;
  basename: string;
  root: string;
  language?: string;
  readable: boolean;
  isManifest: boolean;
  isDoc: boolean;
  isTest: boolean;
  isEntryPoint: boolean;
};

type Inventory = {
  files: InventoryFile[];
  totalFiles: number;
  totalDirectories: number;
  omittedFiles: number;
  ignoredDirectories: string[];
  rootCounts: Map<string, number>;
  languages: Record<string, number>;
};

type SampledFile = {
  path: string;
  reason: string;
  charsRead: number;
  summary: string;
  excerpt: string;
  dependencies: string[];
  language?: string;
  lineCount: number;
  anchors: ProjectExplainSection[];
};

type ModuleDraft = {
  root: string;
  files: InventoryFile[];
};

const DEFAULT_EXPLAIN_SETTINGS: ProjectExplainSettings = {
  maxExplainFiles: 10_000,
  maxModuleSamples: 12,
  maxFileReadChars: 20_000,
  maxFinalAnswerChars: 12_000
};

const IGNORED_DIRS = new Set([
  ".cache",
  ".git",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".playwright-cli",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "ENV",
  "build",
  "coverage",
  "dist",
  "env",
  "htmlcov",
  "node_modules",
  "out",
  "output",
  "outputs",
  "playwright-report",
  "screenshots",
  "site-packages",
  "test-results",
  "venv",
  "target"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "tauri.conf.json"
]);

const DOMAIN_EVIDENCE_RE = /\b(sentiment|sentement|classifier|classification|model|pipeline|polarity|todo|task|analytics|dashboard|metrics|agent|agents|runtime|orchestrat|llm|provider|frontend|backend|api|server|forecast|forecasting|arima|sarima|threshold|score|decision|dispatch)\b/i;
const DATA_FLOW_EVIDENCE_RE = /\b(dataset|data set|records?|rows?|csv|ingest|ingestion|stream|consumer|producer|fetch|setinterval|set interval|poll|polling|refresh|socket|websocket|api\/|snapshot|timestamp|schema|message|pipeline|classifier|model|sentiment|forecast|forecasting|arima|sarima|trend|threshold|score|weight|orchestrator|decision|dispatch|drift)\b/i;
const NUMERIC_FACT_EVIDENCE_RE = /\b(threshold|threshlod|cutoff|floor|min|max|minimum|maximum|borderline|direct|dispatch|high|low|score|weight|gap|cosine|membership|severity|trend|drift|accepted|f1|accuracy|delta|deviation|multiplier|guardrail|forecast|arima|sarima|orchestrator|condition|rule)\b/i;
const FORECAST_EVIDENCE_RE = /\b(forecast|forecasting|arima|sarima|trend|prediction|timeseries|time series|customer|aggregate|global|delta|deviation|drift)\b/i;
const SOURCE_EVIDENCE_EXT_RE = /\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i;

export function buildLargeProjectExplainReport(input: BuildProjectExplainReportInput): ProjectExplainReport {
  const settings = { ...DEFAULT_EXPLAIN_SETTINGS, ...input.settings };
  const workspaceRoot = resolveInsideWorkspace(input.workspacePath);
  const inventory = collectInventory(workspaceRoot, settings.maxExplainFiles);
  const modules = buildModules(inventory, input.projectMap, input.intake, settings, input.message);
  const sampledFiles = readSampledFiles(workspaceRoot, inventory, modules, input, settings);
  const sampledByPath = new Map(sampledFiles.map((sample) => [sample.path, sample]));
  const sections = createExplainSections(sampledFiles, input.message, settings);
  const moduleMap = modules.map((module, index) => createExplainModule(module, index, sampledByPath, settings));
  const importantFiles = uniqueStrings([
    ...(input.intake?.importantFiles ?? []),
    ...input.projectMap.importantFiles,
    ...inventory.files.filter((file) => file.isManifest || file.isDoc || file.isEntryPoint).map((file) => file.path)
  ].filter((file) => shouldIncludeAgentArtifact(file, input.message))).slice(0, 30);
  const entryPoints = uniqueStrings([
    ...(input.intake?.knownEntryPoints ?? []),
    ...input.projectMap.entryPoints,
    ...inventory.files.filter((file) => file.isEntryPoint).map((file) => file.path)
  ]).slice(0, 20);
  const evidence = createReportEvidence(moduleMap, sampledFiles, importantFiles, input.message);
  const howToRun = uniqueStrings([
    ...(input.intake?.buildCommands ?? []),
    ...(input.intake?.knownCommands ?? []),
    ...(input.intake?.testCommands ?? []),
    ...input.projectMap.testCommands
  ]).slice(0, 10);
  const rootFolders = [...inventory.rootCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([root, files]) => ({ path: root, files }))
    .slice(0, 30);
  const risksAndUnknowns = createRisksAndUnknowns(input, inventory, moduleMap, entryPoints);

  return {
    overview: createOverview(input, inventory, moduleMap),
    architecture: createArchitectureSummary(input, rootFolders, moduleMap),
    sections,
    findings: sections,
    moduleMap,
    entryPoints,
    dataFlow: createDataFlowSummary(moduleMap, entryPoints),
    importantFiles,
    howToRun,
    risksAndUnknowns,
    suggestedNextQuestions: createSuggestedNextQuestions(moduleMap, entryPoints, howToRun),
    evidence,
    contextPack: {
      inventory: {
        totalFiles: inventory.totalFiles,
        totalDirectories: inventory.totalDirectories,
        scannedFiles: inventory.files.length,
        omittedFiles: inventory.omittedFiles,
        ignoredDirectories: inventory.ignoredDirectories,
        languages: inventory.languages,
        rootFolders
      },
      readBudget: {
        maxExplainFiles: settings.maxExplainFiles,
        maxModuleSamples: settings.maxModuleSamples,
        maxFileReadChars: settings.maxFileReadChars,
        sampledFiles: sampledFiles.length
      },
      sampledFiles: sampledFiles.map((sample) => ({
        path: sample.path,
        reason: sample.reason,
        charsRead: sample.charsRead,
        summary: sample.summary
      }))
    }
  };
}

function createExplainSections(
  sampledFiles: SampledFile[],
  message: string,
  settings: ProjectExplainSettings
): ProjectExplainSection[] {
  const normalized = message.toLowerCase();
  const requestedConcept = extractRequestedConcept(message);
  const factHeavyQuestion = requestedConcept.evidenceGroups?.some((group) => group.id === "threshold_fact" || group.id === "forecasting_fact") ?? false;
  const smallProject = sampledFiles.length <= 8;
  const anchors = sampledFiles.flatMap((sample) => {
    const perFileLimit = factHeavyQuestion ? 12 : smallProject || normalized.includes(path.basename(sample.path).toLowerCase()) ? 4 : 2;
    return sample.anchors.slice(0, perFileLimit);
  });
  const maxSections = factHeavyQuestion
    ? Math.max(48, settings.maxModuleSamples * 4)
    : smallProject ? Math.min(24, anchors.length) : Math.max(16, settings.maxModuleSamples * 2);
  return anchors
    .sort((left, right) => scoreSection(right, normalized) - scoreSection(left, normalized) || left.filePath.localeCompare(right.filePath) || left.lineStart - right.lineStart)
    .slice(0, maxSections);
}

function scoreSection(section: ProjectExplainSection, normalizedMessage: string) {
  let score = 0;
  const pathText = section.filePath.toLowerCase();
  const title = section.title.toLowerCase();
  if (normalizedMessage.includes(path.basename(pathText))) score += 80;
  if (/main\.py|routes\.py|server\.(ts|js|py)|pipeline|processor|orchestr|agent|service|retriev|repository|decision|action|classification|model|ingest|stream|consumer|producer|queue|event|schema/.test(pathText)) score += 70;
  if (/index\.html|main\.(js|ts)|app\.(tsx|jsx|ts|js)|lib\.rs/.test(pathText)) score += 20;
  if (/api route|service function|domain class|decision|action|http\/api|orchestr|pipeline|retriev|classification|model|ingest|cluster|forecast|formula|numeric threshold|agent weight|project scripts|test|requested concept/i.test(title)) score += 60;
  if (/event|render|export|manifest/i.test(title)) score += 20;
  if (/dom wiring|html loads|css rule|dependency import|readable file sample/i.test(title)) score -= 40;
  if (/agent_proposal|agent-proposal|proposal|orchcode/i.test(pathText)) score -= 100;
  return score;
}

function extractExplainAnchors(filePath: string, content: string, requestedConcept?: RequestedConcept): ProjectExplainSection[] {
  const lines = content.split(/\r?\n/);
  const anchors: ProjectExplainSection[] = [];
  const add = (lineIndex: number, title: string, explanation: string, whyItMatters: string, symbol?: string) => {
    const lineStart = lineIndex + 1;
    const snippetWindow = snippetAround(lines, lineIndex, symbol ? 2 : 1);
    anchors.push({
      title,
      explanation,
      filePath,
      lineStart: snippetWindow.lineStart,
      lineEnd: snippetWindow.lineEnd,
      symbol,
      language: languageForPath(filePath) ?? "text",
      snippet: snippetWindow.snippet,
      whyItMatters
    });
    if (snippetWindow.lineStart !== lineStart && anchors.at(-1)) {
      anchors[anchors.length - 1]!.lineStart = lineStart;
    }
  };

  if (/\.py$/i.test(filePath)) {
    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      const numericAnchor = numericFactAnchor(line, filePath);
      if (numericAnchor) {
        add(index, numericAnchor.title, numericAnchor.explanation, numericAnchor.whyItMatters, numericAnchor.symbol);
      }
      const route = line.match(/^@(app|router)\.(get|post|put|delete|patch)\(["']([^"']+)["']/);
      const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      const fn = line.match(/^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\(/);
      if (route) add(index, "API route", `هنا backend بيفتح endpoint \`${route[2].toUpperCase()} ${route[3]}\` لاستقبال طلب من المستخدم أو الواجهة.`, "ده يثبت boundary حقيقي في workflow المشروع.", `${route[2].toUpperCase()} ${route[3]}`);
      else if (/FastAPI\(|APIRouter\(/.test(line)) add(index, "Python app setup", "هنا بيبدأ إعداد تطبيق أو router في backend.", "دي نقطة دخول لسلوك API وليست مجرد بداية ملف.", "app");
      else if (cls) add(index, "Python domain class", `هنا تعريف \`${cls[1]}\` ككلاس بيجمع منطق أو حالة مرتبطة بالدومين.`, "الكلاسات دي غالبا هي مكان فهم workflow المشروع بدل تفاصيل الواجهة.", cls[1]);
      else if (fn) add(index, "Python service function", `هنا تعريف \`${fn[2]}\` كدالة خدمة أو خطوة معالجة.`, "الدوال دي تثبت خطوات التنفيذ من input لحد output.", fn[2]);
      else if (/\b(decision|action|dispatch|policy|evaluate|retrieve|classif|search|ingest|cluster|segment|forecast|drift|threshold|alert|stream|poll|dataset|sentiment)\b/i.test(line)) add(index, "Decision or action branch", "هنا الكود بيتعامل مع قرار أو action أو retrieval داخل workflow المشروع.", "دي نقطة logic مهمة لأنها بتحدد الخطوة التالية.", extractQuotedValue(line));
    });
  }

  if (/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      const numericAnchor = numericFactAnchor(line, filePath);
      if (numericAnchor) {
        add(index, numericAnchor.title, numericAnchor.explanation, numericAnchor.whyItMatters, numericAnchor.symbol);
      }
      if (/\b(fetch|axios\.|ky\.|request\()\b|\/api\/|POST|GET|PUT|DELETE/.test(line)) {
        add(index, "HTTP/API call", "هنا الواجهة أو الخدمة بتكلم endpoint أو API بدل ما تشتغل محلي فقط.", "دي نقطة مهمة لأنها تثبت انتقال الطلب بين طبقات المشروع.", extractQuotedValue(line));
      } else if (/\b(decision|action|dispatch|policy|evaluate|threshold|alert|status|state)\b/i.test(line)) {
        add(index, "Decision or action branch", "هنا الكود بيتعامل مع قرار أو action في workflow المشروع.", "دي نقطة منطق أعلى من مجرد ربط عناصر، لأنها بتحدد الخطوة التالية للمستخدم أو للنظام.", extractQuotedValue(line));
      }
    });
  }

  if (requestedConcept?.specific) {
    const conceptMatches: number[] = [];
    lines.forEach((rawLine, index) => {
      if (conceptMatches.length >= 6) return;
      if (textSupportsRequestedConcept(`${filePath}\n${rawLine}`, requestedConcept)) {
        conceptMatches.push(index);
      }
    });
    const groupMatches = new Map<number, string[]>();
    if (requestedConcept.evidenceGroups?.length) {
      lines.forEach((rawLine, index) => {
        if (groupMatches.size >= 10) return;
        const matchedGroupIds = matchingConceptEvidenceGroups(`${filePath}\n${rawLine}`, requestedConcept);
        if (matchedGroupIds.length) groupMatches.set(index, matchedGroupIds);
      });
    }
    for (const [index, matchedGroupIds] of groupMatches) {
      const labels = requestedConcept.evidenceGroups
        ?.filter((group) => matchedGroupIds.includes(group.id))
        .map((group) => group.label)
        .join(", ") || "requested concept";
      add(
        index,
        `Requested concept evidence: ${labels}`,
        `This line matched ${labels} for the requested concept \`${requestedConcept.label}\`.`,
        "This is direct current-workspace evidence for one required part of the concept-specific project question.",
        requestedConcept.label
      );
    }
    for (const index of conceptMatches) {
      add(
        index,
        "Requested concept match",
        `This line matched the requested concept \`${requestedConcept.label}\` during current-workspace evidence search.`,
        "This is direct evidence for the concept-specific project question.",
        requestedConcept.label
      );
    }
  }

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const numericAnchor = numericFactAnchor(line, filePath);
    if (numericAnchor) {
      add(index, numericAnchor.title, numericAnchor.explanation, numericAnchor.whyItMatters, numericAnchor.symbol);
    }
    if (/\.html$/i.test(filePath)) {
      if (/<script\b/i.test(line)) add(index, "HTML loads the app script", "السطر ده بيربط صفحة HTML بملف JavaScript المسؤول عن السلوك.", "من غير الربط ده الصفحة هتبقى هيكل ثابت من غير منطق التطبيق.", "script");
      else if (/<canvas\b|id=["']scene["']|id=["']app["']|id=["']root["']/i.test(line)) add(index, "HTML mount point", "ده العنصر اللي JavaScript غالبا بيرسم أو يركب عليه التجربة.", "بيعرفك نقطة اتصال الواجهة بالكود.", "mount");
    } else if (/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
      const imported = line.match(/^import\s+(.+?)\s+from\s+["'](.+?)["']/);
      const exported = line.match(/^export\s+(class|function|const|let|type|interface)\s+([A-Za-z0-9_$]+)/);
      const fn = line.match(/^(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)/) ?? line.match(/^(const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s*)?\(/);
      if (imported) add(index, "Dependency import", `السطر ده يدخل اعتماد مهم: \`${imported[2]}\`.`, "الـ imports بتوضح المكتبات أو modules اللي الملف مبني عليها.", imported[2]);
      else if (/document\.getElementById|querySelector/.test(line)) add(index, "DOM wiring", "هنا الكود بيمسك عنصر من الصفحة عشان يقرأ منه أو يحدثه.", "دي نقطة الربط بين HTML والـ JavaScript.", extractQuotedValue(line));
      else if (/addEventListener|onkeydown|onclick|pointer|mouse|touch/i.test(line)) add(index, "User interaction handler", "هنا بيتسجل تفاعل المستخدم أو إدخال من لوحة المفاتيح/الماوس.", "دي السطور اللي بتفسر إزاي المستخدم بيأثر في التطبيق.", "event");
      else if (/requestAnimationFrame|setInterval|setTimeout|renderer\.render|animate\(/i.test(line)) add(index, "Render or update loop", "ده جزء من loop أو تحديث مستمر للتطبيق.", "لو التطبيق لعبة أو مشهد تفاعلي، ده غالبا قلب الحركة.", "loop");
      else if (/new\s+THREE\.|THREE\./.test(line)) add(index, "Three.js scene setup", "هنا الملف بيستخدم Three.js لبناء المشهد أو الكاميرا أو المجسمات.", "دي علامة إن التجربة مرئية/ثلاثية الأبعاد وليست DOM عادي فقط.", "THREE");
      else if (exported) add(index, "Public export", `هنا الملف يصدّر \`${exported[2]}\` للاستخدام من ملفات أخرى.`, "الـ exports بتوضح الحدود العامة للـ module.", exported[2]);
      else if (fn) add(index, "Function or callback", `هنا تعريف \`${fn[3] ?? fn[2]}\`، وهي وحدة منطق قابلة للتتبع.`, "الدوال هي أفضل نقاط تبدأ منها لفهم السلوك خطوة بخطوة.", fn[3] ?? fn[2]);
    } else if (/\.css$/i.test(filePath)) {
      if (/^[.#]?[A-Za-z0-9_:-][^{]+{/.test(line) || line.startsWith(":root")) {
        add(index, "CSS rule", "هنا قاعدة CSS بتحدد جزء من الشكل أو التخطيط.", "الـ CSS يشرح ليه التجربة طالعة بالشكل اللي شايفه.", line.replace(/\s*\{$/, "").slice(0, 60));
      }
    } else if (isManifestFile(filePath)) {
      if (/"scripts"\s*:/.test(line)) add(index, "Project scripts", "هنا manifest بيبدأ تعريف أوامر التشغيل والاختبار.", "دي أفضل طريقة لإثبات أوامر التشغيل بدل التخمين.", "scripts");
      else if (/"dependencies"\s*:|^\[dependencies\]/.test(line)) add(index, "Project dependencies", "هنا manifest بيعلن الاعتمادات الأساسية.", "الاعتمادات بتوضح stack المشروع وإزاي يتبني.", "dependencies");
    } else if (isDocFile(filePath) && /^#/.test(line)) {
      add(index, "Documentation heading", "ده عنوان وثائقي يشرح نية أو اسم جزء من المشروع.", "الوثائق مفيدة كدليل، لكنها أقل دقة من الكود عند التعارض.", line.replace(/^#+\s*/, "").slice(0, 80));
    }
  });

  if (!anchors.length && lines.length) {
    const firstMeaningful = Math.max(0, lines.findIndex((line) => line.trim().length > 0));
    add(firstMeaningful, "Readable file sample", "ده أول جزء مقروء من الملف ويستخدم كدليل عام.", "لما الملف مفيهوش anchors واضحة، بناخد بداية مقروءة بدل ما نخمن.");
  }

  const anchorLimit = requestedConcept?.evidenceGroups?.some((group) => group.id === "threshold_fact" || group.id === "forecasting_fact")
    ? 16
    : 8;
  return dedupeSections(anchors).slice(0, anchorLimit);
}

function numericFactAnchor(line: string, filePath: string) {
  if (/^\s*</.test(line)) return undefined;
  if (!NUMERIC_FACT_EVIDENCE_RE.test(`${filePath}\n${line}`)) return undefined;
  if (!/-?\d+(?:\.\d+)?/.test(line)) return undefined;
  if (!/[<>]=?|==|=|:/.test(line)) return undefined;
  const compact = line.replace(/\s+/g, " ").slice(0, 180);
  const comparison = compact.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)/);
  const assignment = compact.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*(-?\d+(?:\.\d+)?)/)
    ?? compact.match(/["']?([A-Za-z_][A-Za-z0-9_ -]+)["']?\s*:\s*(-?\d+(?:\.\d+)?)/);
  const formula = compact.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*(.+)/);
  const symbol = comparison?.[1] ?? assignment?.[1] ?? formula?.[1] ?? "numeric fact";
  const title = formula && !assignment && /[+\-*/()]|\bmax\b|\bmin\b|\*\*/.test(formula[2] ?? "")
    ? "Formula or score calculation"
    : /\b(weight|weights)\b/i.test(`${symbol} ${filePath}`)
      ? "Agent weight or numeric constant"
      : "Numeric threshold or condition";
  return {
    title,
    explanation: `Current-workspace code contains the numeric fact \`${compact}\`.`,
    whyItMatters: "This supports threshold, formula, forecasting, or decision-rule project questions with concrete file evidence.",
    symbol
  };
}

function snippetAround(lines: string[], lineIndex: number, radius: number) {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length - 1, lineIndex + Math.max(radius, 3));
  return {
    lineStart: start + 1,
    lineEnd: end + 1,
    snippet: lines.slice(start, end + 1).join("\n").trimEnd()
  };
}

function formatFileLineLink(filePath: string, line: number) {
  return `[${filePath}:${line}](orchcode-file:${encodeURIComponent(filePath)}:${line})`;
}

function collectInventory(workspaceRoot: string, maxFiles: number): Inventory {
  const files: InventoryFile[] = [];
  const rootCounts = new Map<string, number>();
  const ignoredDirectories = new Set<string>();
  const languages: Record<string, number> = {};
  let totalFiles = 0;
  let totalDirectories = 0;
  let omittedFiles = 0;
  const stack = ["."];

  while (stack.length) {
    const relativeDir = stack.pop()!;
    const absoluteDir = path.join(workspaceRoot, relativeDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        totalDirectories += 1;
        if (shouldIgnoreDirectory(entry.name, relativePath)) {
          ignoredDirectories.add(relativePath);
          continue;
        }
        stack.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      totalFiles += 1;
      if (files.length >= maxFiles) {
        omittedFiles += 1;
        continue;
      }

      const absolutePath = path.join(workspaceRoot, relativePath);
      if (isSecretCandidate(absolutePath)) {
        omittedFiles += 1;
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const language = languageForPath(relativePath);
      const readable = isTextLike(relativePath);
      const root = selectModuleRoot(relativePath);
      if (language) languages[language] = (languages[language] ?? 0) + 1;
      rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
      files.push({
        path: relativePath,
        ext,
        basename: entry.name,
        root,
        language,
        readable,
        isManifest: isManifestFile(relativePath),
        isDoc: isDocFile(relativePath),
        isTest: isTestFile(relativePath),
        isEntryPoint: isEntryPointFile(relativePath)
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    totalFiles,
    totalDirectories,
    omittedFiles,
    ignoredDirectories: [...ignoredDirectories].sort(),
    rootCounts,
    languages
  };
}

function buildModules(
  inventory: Inventory,
  projectMap: ProjectMap,
  intake: ProjectIntake | undefined,
  settings: ProjectExplainSettings,
  message: string
): ModuleDraft[] {
  const grouped = new Map<string, InventoryFile[]>();
  for (const file of inventory.files.filter((entry) => entry.readable)) {
    if (!shouldIncludeAgentArtifact(file.path, message)) continue;
    const root = chooseClusterRoot(file, projectMap, intake);
    const current = grouped.get(root) ?? [];
    current.push(file);
    grouped.set(root, current);
  }

  const importantRoots = new Set([
    ...projectMap.importantFiles.map(selectModuleRoot),
    ...(intake?.importantFiles ?? []).map(selectModuleRoot),
    ...(intake?.knownEntryPoints ?? []).map(selectModuleRoot)
  ]);

  return [...grouped.entries()]
    .map(([root, files]) => ({ root, files }))
    .sort((left, right) => {
      const leftImportant = importantRoots.has(left.root) ? 1 : 0;
      const rightImportant = importantRoots.has(right.root) ? 1 : 0;
      if (leftImportant !== rightImportant) return rightImportant - leftImportant;
      return right.files.length - left.files.length;
    })
    .slice(0, Math.max(8, settings.maxModuleSamples * 2));
}

function readSampledFiles(
  workspaceRoot: string,
  inventory: Inventory,
  modules: ModuleDraft[],
  input: BuildProjectExplainReportInput,
  settings: ProjectExplainSettings
): SampledFile[] {
  const selected = new Map<string, string>();
  const add = (filePath: string, reason: string) => {
    const file = inventory.files.find((entry) => entry.path === normalizePath(filePath));
    if (!file?.readable) return;
    if (!shouldIncludeAgentArtifact(file.path, input.message)) return;
    if (!selected.has(file.path)) selected.set(file.path, reason);
  };

  for (const file of inventory.files.filter((entry) => entry.isManifest || entry.isDoc)) add(file.path, file.isManifest ? "manifest" : "documentation");
  for (const file of input.projectMap.importantFiles) add(file, "project-map-important-file");
  for (const file of input.intake?.importantFiles ?? []) add(file, "project-intake-important-file");
  for (const file of input.intake?.knownEntryPoints ?? []) add(file, "entrypoint");
  for (const file of inventory.files.filter((entry) => entry.isEntryPoint)) add(file.path, "entrypoint");

  const requestedConcept = extractRequestedConcept(input.message);
  for (const entry of findProjectUnderstandingFiles(workspaceRoot, inventory, input, settings)) {
    add(entry.file.path, entry.reason);
  }
  if (requestedConcept.specific) {
    for (const file of findConceptMatchingFiles(workspaceRoot, inventory, requestedConcept, input, settings)) {
      add(file.path, "requested-concept-match");
    }
  }

  for (const module of modules) {
    for (const file of rankFilesForModule(module.files).slice(0, settings.maxModuleSamples)) {
      add(file.path, `${module.root}-module-sample`);
    }
  }

  const maxSamples = Math.min(240, 30 + modules.length * settings.maxModuleSamples);
  const sampled: SampledFile[] = [];
  for (const [filePath, reason] of [...selected.entries()].slice(0, maxSamples)) {
    try {
      const absolutePath = path.join(workspaceRoot, filePath);
      const content = fs.readFileSync(absolutePath, "utf8").slice(0, settings.maxFileReadChars);
      const anchors = extractExplainAnchors(filePath, content, requestedConcept);
      sampled.push({
        path: filePath,
        reason,
        charsRead: content.length,
        summary: summarizeFile(filePath, content),
        excerpt: compactText(content).slice(0, 280),
        dependencies: inferDependencies(filePath, content),
        language: languageForPath(filePath),
        lineCount: content.split(/\r?\n/).length,
        anchors
      });
    } catch {
      // Ignore unreadable files; the report still carries inventory evidence.
    }
  }
  return sampled;
}

function findConceptMatchingFiles(
  workspaceRoot: string,
  inventory: Inventory,
  concept: RequestedConcept,
  input: BuildProjectExplainReportInput,
  settings: ProjectExplainSettings
) {
  const matches: Array<{ file: InventoryFile; score: number }> = [];
  const wantsThresholdFacts = concept.evidenceGroups?.some((group) => group.id === "threshold_fact") ?? false;
  const wantsForecastingFacts = concept.evidenceGroups?.some((group) => group.id === "forecasting_fact") ?? false;
  for (const file of inventory.files.filter((entry) => entry.readable)) {
    if (!shouldIncludeAgentArtifact(file.path, input.message)) continue;
    const pathGroups = matchingConceptEvidenceGroups(file.path, concept);
    let score = textSupportsRequestedConcept(file.path, concept) ? 50 : 0;
    if (pathGroups.length) score += pathGroups.length * 35;
    if (wantsThresholdFacts && /orchestrator|agents?|routes?|arima|forecast|model|services|decision|policy/i.test(file.path)) score += 45;
    if (wantsForecastingFacts && /arima|forecast|trend|model|routes?|services/i.test(file.path)) score += 55;
    try {
      const content = fs.readFileSync(path.join(workspaceRoot, file.path), "utf8").slice(0, settings.maxFileReadChars);
      const contentGroups = matchingConceptEvidenceGroups(content, concept);
      if (textSupportsRequestedConcept(content, concept)) score += file.isDoc || file.isManifest ? 80 : 100;
      if (contentGroups.length) score += contentGroups.length * (file.isDoc || file.isManifest ? 90 : 130);
      if (wantsThresholdFacts && NUMERIC_FACT_EVIDENCE_RE.test(`${file.path}\n${content}`)) score += file.isDoc || file.isManifest ? 60 : 150;
      if (wantsForecastingFacts && FORECAST_EVIDENCE_RE.test(`${file.path}\n${content}`)) score += file.isDoc || file.isManifest ? 70 : 150;
    } catch {
      // Ignore unreadable files; inventory and other sampled files still provide context.
    }
    if (score > 0) {
      if (file.isDoc) score += 10;
      if (!file.isDoc && !file.isManifest) score += 25;
      if (file.isEntryPoint) score += 10;
      matches.push({ file, score });
    }
  }
  return matches
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .map((entry) => entry.file)
    .slice(0, 20);
}

function findProjectUnderstandingFiles(
  workspaceRoot: string,
  inventory: Inventory,
  input: BuildProjectExplainReportInput,
  settings: ProjectExplainSettings
) {
  const scored: Array<{ file: InventoryFile; reason: string; domain: number; dataFlow: number; source: number; validation: number }> = [];
  for (const file of inventory.files.filter((entry) => entry.readable)) {
    if (!shouldIncludeAgentArtifact(file.path, input.message)) continue;
    let content = "";
    try {
      content = fs.readFileSync(path.join(workspaceRoot, file.path), "utf8").slice(0, settings.maxFileReadChars);
    } catch {
      // Keep path-only signals when a readable file cannot be read here.
    }
    const text = `${file.path}\n${content}`;
    const sourceFile = SOURCE_EVIDENCE_EXT_RE.test(file.path);
    const domain = DOMAIN_EVIDENCE_RE.test(text)
      ? (sourceFile ? 130 : file.isDoc ? 85 : 60) + pathSignalBonus(file.path, DOMAIN_EVIDENCE_RE)
      : 0;
    const dataFlow = DATA_FLOW_EVIDENCE_RE.test(text)
      ? (sourceFile ? 130 : file.isDoc ? 90 : 70) + pathSignalBonus(file.path, DATA_FLOW_EVIDENCE_RE)
      : 0;
    const numeric = NUMERIC_FACT_EVIDENCE_RE.test(text)
      ? (sourceFile ? 150 : file.isDoc ? 80 : 55) + pathSignalBonus(file.path, NUMERIC_FACT_EVIDENCE_RE)
      : 0;
    const forecasting = FORECAST_EVIDENCE_RE.test(text)
      ? (sourceFile ? 145 : file.isDoc ? 85 : 60) + pathSignalBonus(file.path, FORECAST_EVIDENCE_RE)
      : 0;
    const source = sourceFile
      ? scoreSourceUnderstandingFile(file, text)
      : 0;
    const validation = Math.max(domain, dataFlow, numeric, forecasting, source) + (file.isEntryPoint ? 25 : 0);
    if (domain || dataFlow || numeric || forecasting || source || validation > 40) {
      const reason = [
        domain ? "project-domain-evidence" : "",
        dataFlow ? "project-data-flow-evidence" : "",
        numeric ? "numeric-threshold-evidence" : "",
        forecasting ? "forecasting-evidence" : "",
        source ? "project-source-evidence" : "",
        validation > 80 ? "project-validation-evidence" : ""
      ].filter(Boolean).join("+") || "project-understanding-evidence";
      scored.push({ file, reason, domain: Math.max(domain, forecasting), dataFlow: Math.max(dataFlow, numeric, forecasting), source: Math.max(source, numeric), validation });
    }
  }
  return uniqueScoredFiles([
    ...scored.sort((left, right) => right.domain - left.domain || left.file.path.localeCompare(right.file.path)).slice(0, 12),
    ...scored.sort((left, right) => right.dataFlow - left.dataFlow || left.file.path.localeCompare(right.file.path)).slice(0, 16),
    ...scored.sort((left, right) => right.source - left.source || left.file.path.localeCompare(right.file.path)).slice(0, 12),
    ...scored.sort((left, right) => right.validation - left.validation || left.file.path.localeCompare(right.file.path)).slice(0, 12)
  ]);
}

function scoreSourceUnderstandingFile(file: InventoryFile, text: string) {
  let score = SOURCE_EVIDENCE_EXT_RE.test(file.path) ? 40 : 0;
  if (file.isEntryPoint) score += 40;
  if (/(\bclass\b|\bdef\b|\bfunction\b|=>|export\s+function|FastAPI|APIRouter)/.test(text)) score += 25;
  if (DATA_FLOW_EVIDENCE_RE.test(text)) score += 45;
  if (DOMAIN_EVIDENCE_RE.test(text)) score += 45;
  if (NUMERIC_FACT_EVIDENCE_RE.test(text)) score += 55;
  if (FORECAST_EVIDENCE_RE.test(text)) score += 50;
  if (/(pipeline|model|classifier|ingest|stream|service|api|route|app\.(jsx|tsx|js|ts)|main\.|orchestrator|agents?|arima|forecast)/i.test(file.path)) score += 35;
  if (file.isTest) score -= 30;
  return score;
}

function pathSignalBonus(filePath: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return pattern.test(filePath) ? 35 : 0;
}

function uniqueScoredFiles<T extends { file: InventoryFile }>(entries: T[]) {
  const byPath = new Map<string, T>();
  for (const entry of entries) {
    if (!byPath.has(entry.file.path)) byPath.set(entry.file.path, entry);
  }
  return [...byPath.values()];
}

function createExplainModule(
  module: ModuleDraft,
  index: number,
  sampledByPath: Map<string, SampledFile>,
  settings: ProjectExplainSettings
): ProjectExplainModule {
  const rankedFiles = rankFilesForModule(module.files);
  const importantFiles = rankedFiles.slice(0, settings.maxModuleSamples).map((file) => file.path);
  const entryPoints = module.files.filter((file) => file.isEntryPoint).map((file) => file.path).slice(0, 8);
  const tests = module.files.filter((file) => file.isTest).map((file) => file.path).slice(0, 8);
  const samples = importantFiles.map((file) => sampledByPath.get(file)).filter((sample): sample is SampledFile => Boolean(sample));
  const dependencies = uniqueStrings(samples.flatMap((sample) => sample.dependencies)).slice(0, 10);
  const risksAndUnknowns = [
    tests.length ? "" : "No nearby tests were detected in this module sample.",
    module.files.length > 200 ? `Large module surface (${module.files.length} readable files); explanation is summary-first.` : "",
    samples.length ? "" : "No readable samples were captured for this module."
  ].filter(Boolean);

  return {
    id: `module_${index + 1}`,
    name: humanizeModuleName(module.root),
    root: module.root,
    responsibility: inferResponsibility(module.root, rankedFiles, samples),
    importantFiles,
    entryPoints,
    tests,
    dependencies,
    risksAndUnknowns,
    evidence: samples.slice(0, 5).map((sample) => ({
      type: evidenceTypeForPath(sample.path),
      path: sample.path,
      reason: sample.summary,
      excerpt: sample.excerpt,
      lineStart: sample.anchors[0]?.lineStart,
      lineEnd: sample.anchors[0]?.lineEnd,
      symbol: sample.anchors[0]?.symbol,
      language: sample.language,
      snippet: sample.anchors[0]?.snippet
    }))
  };
}

function createReportEvidence(
  moduleMap: ProjectExplainModule[],
  sampledFiles: SampledFile[],
  importantFiles: string[],
  message: string
): ProjectExplainEvidenceRef[] {
  const requestedConcept = extractRequestedConcept(message);
  const domainSamples = pickSamples(sampledFiles, (sample) => sampleMatchesPattern(sample, DOMAIN_EVIDENCE_RE), 10);
  const dataFlowSamples = pickSamples(sampledFiles, (sample) => sampleMatchesPattern(sample, DATA_FLOW_EVIDENCE_RE), 12);
  const numericSamples = pickSamples(sampledFiles, (sample) => sampleMatchesPattern(sample, NUMERIC_FACT_EVIDENCE_RE), 14);
  const forecastSamples = pickSamples(sampledFiles, (sample) => sampleMatchesPattern(sample, FORECAST_EVIDENCE_RE), 10);
  const conceptSamples = requestedConcept.specific
    ? pickSamples(sampledFiles, (sample) => textSupportsRequestedConcept(sampleText(sample), requestedConcept), 12)
    : [];
  const sourceSamples = pickSamples(sampledFiles, (sample) => SOURCE_EVIDENCE_EXT_RE.test(sample.path) && sample.anchors.length > 0, 10);
  const docSamples = pickSamples(sampledFiles, (sample) => isDocFile(sample.path) || isManifestFile(sample.path), 8);
  const remainingSamples = sampledFiles.slice(0, 16);
  const sampledEvidence = uniqueSamples([
    ...domainSamples,
    ...dataFlowSamples,
    ...numericSamples,
    ...forecastSamples,
    ...conceptSamples,
    ...sourceSamples,
    ...docSamples,
    ...remainingSamples
  ]).map(sampleToEvidence);
  const importantEvidence = importantFiles.slice(0, 10).map((file) => ({
    type: evidenceTypeForPath(file),
    path: file,
    reason: "High-signal file selected by intake or project map."
  }));
  const moduleEvidence = moduleMap.slice(0, 8).map((module) => ({
    type: "directory" as const,
    path: module.root,
    reason: module.responsibility
  }));
  return dedupeEvidence([...sampledEvidence, ...importantEvidence, ...moduleEvidence]).slice(0, 60);
}

function sampleToEvidence(sample: SampledFile): ProjectExplainEvidenceRef {
  return {
    type: evidenceTypeForPath(sample.path),
    path: sample.path,
    reason: sample.summary,
    excerpt: sample.excerpt,
    lineStart: sample.anchors[0]?.lineStart,
    lineEnd: sample.anchors[0]?.lineEnd,
    symbol: sample.anchors[0]?.symbol,
    language: sample.language,
    snippet: sample.anchors[0]?.snippet
  };
}

function pickSamples(sampledFiles: SampledFile[], predicate: (sample: SampledFile) => boolean, limit: number) {
  return sampledFiles
    .filter(predicate)
    .sort((left, right) => scoreSampleForEvidence(right) - scoreSampleForEvidence(left) || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function scoreSampleForEvidence(sample: SampledFile) {
  let score = 0;
  if (SOURCE_EVIDENCE_EXT_RE.test(sample.path)) score += 50;
  if (sample.anchors.length) score += 35;
  if (sample.reason.includes("project-domain")) score += 30;
  if (sample.reason.includes("project-data-flow")) score += 30;
  if (sample.reason.includes("requested-concept")) score += 25;
  if (isDocFile(sample.path)) score += 10;
  if (isManifestFile(sample.path)) score -= 20;
  return score;
}

function sampleMatchesPattern(sample: SampledFile, pattern: RegExp) {
  pattern.lastIndex = 0;
  return pattern.test(sampleText(sample));
}

function sampleText(sample: SampledFile) {
  return `${sample.path}\n${sample.reason}\n${sample.summary}\n${sample.excerpt}\n${sample.anchors.map((anchor) => anchor.snippet).join("\n")}`;
}

function uniqueSamples(samples: SampledFile[]) {
  const byPath = new Map<string, SampledFile>();
  for (const sample of samples) {
    if (!byPath.has(sample.path)) byPath.set(sample.path, sample);
  }
  return [...byPath.values()];
}

function createOverview(input: BuildProjectExplainReportInput, inventory: Inventory, modules: ProjectExplainModule[]) {
  const stack = input.projectMap.stack.length ? input.projectMap.stack.join(", ") : Object.keys(inventory.languages).slice(0, 4).join(", ") || "unknown stack";
  const projectName = input.intake?.detectedProjectName ?? path.basename(path.resolve(input.workspacePath));
  const moduleNames = modules.slice(0, 5).map((module) => module.root).join(", ") || "no clear module roots";
  return `${projectName} appears to be a ${stack} workspace with ${inventory.files.length} scanned file(s) across ${modules.length} mapped module(s). Main areas: ${moduleNames}.`;
}

function createArchitectureSummary(
  input: BuildProjectExplainReportInput,
  rootFolders: Array<{ path: string; files: number }>,
  modules: ProjectExplainModule[]
) {
  if (input.intake?.architectureSummary) return input.intake.architectureSummary;
  const roots = rootFolders.slice(0, 6).map((entry) => `${entry.path} (${entry.files})`).join(", ");
  const responsibilities = modules.slice(0, 4).map((module) => `${module.root}: ${module.responsibility}`).join(" | ");
  return `The project is organized around ${roots || "the workspace root"}. ${responsibilities || "No module responsibility could be inferred beyond the file inventory."}`;
}

function createDataFlowSummary(moduleMap: ProjectExplainModule[], entryPoints: string[]) {
  const apiModules = moduleMap.filter((module) => /(api|server|runtime|backend|tauri|protocol)/i.test(`${module.root} ${module.name}`));
  const uiModules = moduleMap.filter((module) => /(app|ui|desktop|component|frontend|web)/i.test(`${module.root} ${module.name}`));
  const tests = moduleMap.filter((module) => module.tests.length);
  const parts = [
    entryPoints.length ? `Entry starts around ${entryPoints.slice(0, 4).join(", ")}.` : "No proven entry point was found.",
    uiModules.length ? `UI-facing modules include ${uiModules.slice(0, 3).map((module) => module.root).join(", ")}.` : "",
    apiModules.length ? `Runtime/API/backend-facing modules include ${apiModules.slice(0, 3).map((module) => module.root).join(", ")}.` : "",
    tests.length ? `Tests are visible near ${tests.slice(0, 3).map((module) => module.root).join(", ")}.` : "Tests were not strongly visible in the sampled module map."
  ].filter(Boolean);
  return parts.join(" ");
}

function createRisksAndUnknowns(
  input: BuildProjectExplainReportInput,
  inventory: Inventory,
  moduleMap: ProjectExplainModule[],
  entryPoints: string[]
) {
  return uniqueStrings([
    ...(input.intake?.warnings ?? []),
    ...(input.intake?.unknowns ?? []),
    inventory.omittedFiles ? `${inventory.omittedFiles} file(s) were omitted after the explain inventory limit.` : "",
    entryPoints.length ? "" : "No definitive runtime entry point was proven from filenames and manifests.",
    moduleMap.some((module) => !module.tests.length) ? "Some modules do not have nearby tests in the scanned file tree." : "",
    inventory.ignoredDirectories.length ? `Ignored generated/vendor directories: ${inventory.ignoredDirectories.slice(0, 8).join(", ")}.` : ""
  ].filter(Boolean)).slice(0, 12);
}

function createSuggestedNextQuestions(moduleMap: ProjectExplainModule[], entryPoints: string[], howToRun: string[]) {
  const firstModule = moduleMap[0]?.root;
  return [
    firstModule ? `Explain ${firstModule} in more detail.` : "",
    entryPoints[0] ? `Trace what happens from ${entryPoints[0]}.` : "",
    howToRun[0] ? `Explain how ${howToRun[0]} works and what it starts.` : "",
    "Show the risky or unclear parts before editing."
  ].filter(Boolean).slice(0, 4);
}

function rankFilesForModule(files: InventoryFile[]) {
  return [...files].sort((left, right) => scoreFile(right) - scoreFile(left) || left.path.localeCompare(right.path));
}

function scoreFile(file: InventoryFile) {
  let score = 0;
  if (file.isManifest) score += 50;
  if (file.isDoc) score += 35;
  if (file.isEntryPoint) score += 30;
  if (file.isTest) score += 10;
  if (/types?|schema|protocol|config|route|server|runtime|main|index|app/i.test(file.path)) score += 12;
  if (!shouldIncludeAgentArtifact(file.path, "")) score -= 100;
  if (/lock|snapshot|generated/i.test(file.path)) score -= 30;
  return score;
}

function chooseClusterRoot(file: InventoryFile, projectMap: ProjectMap, intake: ProjectIntake | undefined) {
  const directSignals = uniqueStrings([
    ...projectMap.importantFiles,
    ...(intake?.importantFiles ?? []),
    ...(intake?.knownEntryPoints ?? [])
  ]).map(selectModuleRoot);
  return directSignals.includes(file.root) ? file.root : file.root;
}

function selectModuleRoot(filePath: string) {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  if (parts.length >= 2 && /^(apps|packages|services|libs|crates|plugins|examples)$/.test(parts[0] ?? "")) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "src" && parts[1] && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "app" && parts[1] && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === "project" && parts[1] && parts.length >= 3) {
    if (parts[1] === "backend" && parts[2] === "services" && parts[3]) return "project/backend/services";
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || ".";
}

function shouldIgnoreDirectory(name: string, relativePath: string) {
  return IGNORED_DIRS.has(name) || relativePath.split("/").some((part) => IGNORED_DIRS.has(part));
}

function isTextLike(filePath: string) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || MANIFEST_NAMES.has(path.basename(filePath));
}

function isManifestFile(filePath: string) {
  return MANIFEST_NAMES.has(path.basename(filePath));
}

function isDocFile(filePath: string) {
  return /(^|\/)(README|CHANGELOG|CONTRIBUTING|ARCHITECTURE|docs\/)/i.test(filePath) || /\.md$/i.test(filePath);
}

function isTestFile(filePath: string) {
  return /(^|\/)(test|tests|__tests__)\b|(\.test\.|\.(spec)\.)/i.test(filePath);
}

function isEntryPointFile(filePath: string) {
  return /(^|\/)(index|main|app|server|cli|lib)\.(ts|tsx|js|jsx|rs|py|html)$/i.test(filePath)
    || /(^|\/)src-tauri\/src\/main\.rs$/i.test(filePath);
}

function evidenceTypeForPath(filePath: string): ProjectExplainEvidenceRef["type"] {
  if (isManifestFile(filePath)) return "manifest";
  if (isEntryPointFile(filePath)) return "entrypoint";
  if (isTestFile(filePath)) return "test";
  return "file";
}

function languageForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".cs": "C#",
    ".css": "CSS",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".kt": "Kotlin",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".scss": "CSS",
    ".sql": "SQL",
    ".swift": "Swift",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".toml": "TOML",
    ".yaml": "YAML",
    ".yml": "YAML"
  };
  return map[ext];
}

function summarizeFile(filePath: string, content: string) {
  const compact = compactText(content);
  if (path.basename(filePath) === "package.json") {
    try {
      const parsed = JSON.parse(content) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = Object.keys(parsed.scripts ?? {}).slice(0, 6).join(", ") || "no scripts";
      const deps = Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }).slice(0, 6).join(", ") || "no listed dependencies";
      return `package.json${parsed.name ? ` for ${parsed.name}` : ""}; scripts: ${scripts}; deps: ${deps}.`;
    } catch {
      return "package.json manifest could not be parsed as JSON.";
    }
  }
  if (/README|ARCHITECTURE|CONTRIBUTING|CHANGELOG|\.md$/i.test(filePath)) {
    const heading = content.split(/\r?\n/).find((line) => /^#/.test(line.trim()))?.replace(/^#+\s*/, "");
    return heading ? `Documentation: ${heading}. ${compact.slice(0, 260)}.` : `Documentation sample: ${compact.slice(0, 180)}.`;
  }
  const declarations = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(export\s+)?(class|function|type|interface|const|async function)\b|^import\b|^pub\s+(struct|enum|fn|mod)\b/.test(line))
    .slice(0, 5)
    .map((line) => line.slice(0, 100));
  return declarations.length ? `Code declarations/imports: ${declarations.join(" | ")}.` : `Readable text/code sample: ${compact.slice(0, 140)}.`;
}

function inferDependencies(filePath: string, text: string) {
  if (path.basename(filePath) === "package.json") {
    try {
      const parsed = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) });
    } catch {
      return [];
    }
  }
  const deps: string[] = [];
  for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g)) {
    const dep = match[1] ?? match[2];
    if (dep && !dep.startsWith(".")) deps.push(dep.split("/")[0] ?? dep);
  }
  return deps;
}

function inferResponsibility(root: string, files: InventoryFile[], samples: SampledFile[]) {
  const pathJoined = `${root} ${files.map((file) => file.path).slice(0, 20).join(" ")}`.toLowerCase();
  const joined = `${pathJoined} ${samples.map((sample) => `${sample.summary} ${sample.excerpt}`).join(" ")}`.toLowerCase();
  if (/test|spec/.test(pathJoined)) return "Test coverage and behavior verification.";
  if (/frontend|app|ui|component|web|index\.html|styles\.css/.test(pathJoined)) return "User-facing application or interface surface.";
  if (/backend|routes|fastapi|api/.test(pathJoined)) return "Backend API routes and service orchestration.";
  if (/data|dataset|pipeline|clean|transform|ingest|stream|consumer|producer|queue|alert|model|classification|forecast|cluster|retriev|vector/.test(joined)) return "Data loading, transformation, model/service processing, or emitted results.";
  if (/protocol|schema|types?/.test(pathJoined)) return "Shared contracts, protocol types, or schema definitions.";
  if (/runtime|agent|orchestrat/.test(pathJoined)) return "Agent runtime, orchestration, or execution behavior.";
  if (/desktop|tauri|electron/.test(pathJoined)) return "Desktop shell, native bridge, or app host behavior.";
  if (/docs|readme|architecture/.test(pathJoined)) return "Documentation and project guidance.";
  const summary = samples[0]?.summary;
  return summary ? `Inferred from samples: ${summary}` : "General project module inferred from its directory and file names.";
}

function humanizeModuleName(root: string) {
  return root
    .split("/")
    .map((part) => part.replace(/[-_]/g, " "))
    .join(" / ");
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeEvidence(values: ProjectExplainEvidenceRef[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.type}:${value.path}:${value.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSections(values: ProjectExplainSection[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.filePath}:${value.lineStart}:${value.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractQuotedValue(value: string) {
  return value.match(/["']([^"']+)["']/)?.[1];
}

function shouldIncludeAgentArtifact(filePath: string, message: string) {
  const normalizedPath = filePath.toLowerCase();
  const normalizedMessage = message.toLowerCase();
  if (!/(agent[_-]?proposal|agent\.proposal|orchcode|work[_-]?journal|decision)/i.test(normalizedPath)) {
    return true;
  }
  return /\b(agent|proposal|orchcode|journal|decision)\b/i.test(normalizedMessage) || /(اقتراح|اورك|أورك|وكيل|اجينت)/.test(normalizedMessage);
}
