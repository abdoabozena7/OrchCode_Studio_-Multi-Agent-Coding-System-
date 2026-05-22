import type { WorkspaceTools } from "../tools/WorkspaceTools.js";
import type { FrontendStructureFacts } from "./InspectExplainFacts.js";

export function analyzeFrontendStructure(
  workspace: WorkspaceTools,
  filePaths: string[]
): FrontendStructureFacts {
  const inspectedFiles: string[] = [];
  const uncertainties: string[] = [];
  const items: FrontendStructureFacts["items"] = [];
  let hasRouter = false;

  const frontendFiles = filePaths.filter(f => 
    /\.(html|jsx|tsx|js|ts)$/i.test(f) &&
    !/(node_modules|\.git|dist|build)/i.test(f)
  );

  for (const file of frontendFiles) {
    inspectedFiles.push(file);
    let content = "";
    try {
      content = workspace.readWholeFile(file);
    } catch {
      continue;
    }
    
    // Router detection
    if (/\b(BrowserRouter|createBrowserRouter|Routes|Route|router)\b/i.test(content)) {
      hasRouter = true;
    }

    // Page/Route detection
    const routeMatches = content.matchAll(/<Route[^>]+path=["']([^"']+)["'][^>]*element=\{<([^>]+)>\}/gi);
    for (const match of routeMatches) {
      items.push({
        name: match[1] || "unknown",
        type: "route",
        purpose: `Renders ${match[2]} component`,
        sourceRef: file,
        confidence: "high"
      });
    }

    // View collections such as const VIEWS/PAGES/ROUTES/TABS = [{ id, title, description }]
    const collectionMatches = content.matchAll(/\b(?:const|let|var)\s+(?:VIEWS|PAGES|ROUTES|TABS|CHAPTERS)\s*=\s*\[([\s\S]*?)\];/g);
    for (const collection of collectionMatches) {
      const body = collection[1] ?? "";
      for (const match of body.matchAll(/\{[\s\S]*?id:\s*["']([^"']+)["'][\s\S]*?title:\s*["']([^"']+)["'][\s\S]*?(?:description:\s*["']([^"']+)["'])?[\s\S]*?\}/g)) {
        items.push({
          name: match[2] || match[1] || "unknown",
          type: "tab",
          purpose: match[3] || `View id ${match[1]}`,
          sourceRef: file,
          confidence: "high"
        });
      }
    }

    // React components that look like pages
    for (const match of content.matchAll(/function\s+([A-Z][a-zA-Z0-9]*(?:Page|Screen|View))/g)) {
      if (match[1]) {
        items.push({
          name: match[1],
          type: "page",
          purpose: "UI Page/Screen component",
          sourceRef: file,
          confidence: "medium"
        });
      }
    }

    // Page-like sections in HTML/JSX, including data-view/data-page markers.
    const sectionMatches = content.matchAll(/<(section|main|article|div)[^>]*(?:id|data-view|data-page)=["']([^"']+)["'][^>]*>([^<]{0,180})/gi);
    for (const match of sectionMatches) {
      const sectionName = match[2] || "unknown";
      if (/^(root|app|mount|container)$/i.test(sectionName)) continue;
      items.push({
        name: sectionName,
        type: "section",
        purpose: compact(match[3] || `${match[1]} ${match[2]}`),
        sourceRef: file,
        confidence: "high"
      });
    }

    // Static navigation anchors are direct evidence of page/view entries.
    const navMatches = content.matchAll(/<a[^>]*href=["']#?([^"']+)["'][^>]*>([^<]{1,100})<\/a>/gi);
    for (const match of navMatches) {
      items.push({
        name: compact(match[2] || match[1] || "navigation"),
        type: "section",
        purpose: `Navigation item for ${match[1]}`,
        sourceRef: file,
        confidence: "medium"
      });
    }
  }

  // Deduplicate items by name and sourceRef
  const uniqueItems = new Map<string, typeof items[0]>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, item);
    }
  }

  const finalItems = Array.from(uniqueItems.values());
  const isSinglePageApp = finalItems.length > 0 && !hasRouter;

  return {
    kind: "frontend_structure",
    totalItems: finalItems.length,
    items: finalItems,
    hasRouter,
    isSinglePageApp,
    inspectedFiles,
    uncertainties
  };
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
