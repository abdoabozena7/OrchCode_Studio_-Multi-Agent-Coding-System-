import { WorkspaceTools } from "../tools/WorkspaceTools.js";
import { UIControlFacts } from "./InspectExplainFacts.js";

const FRONTEND_EXTENSIONS = [".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"];

export function analyzeUIControls(workspace: WorkspaceTools, filePaths: string[]): UIControlFacts {
  const facts: UIControlFacts = {
    kind: "ui_controls",
    controls: [],
    inspectedFiles: [],
    uncertainties: []
  };

  const frontendFiles = filePaths.filter(p => 
    FRONTEND_EXTENSIONS.some(ext => p.endsWith(ext)) &&
    !p.includes("node_modules") &&
    !p.includes("dist") &&
    !p.includes("build") &&
    !p.includes(".test.") &&
    !p.includes(".spec.")
  );

  function extractAction(attributes: string): string | null {
    const onClickMatch = attributes.match(/on[C|c]lick={([^}]+)}/);
    if (onClickMatch) return onClickMatch[1].trim();
    
    const onSubmitMatch = attributes.match(/on[S|s]ubmit={([^}]+)}/);
    if (onSubmitMatch) return onSubmitMatch[1].trim();

    const onclickMatch = attributes.match(/onclick=["']([^"']+)["']/i);
    if (onclickMatch) return onclickMatch[1].trim();

    const ngClickMatch = attributes.match(/ng-click=["']([^"']+)["']/i);
    if (ngClickMatch) return ngClickMatch[1].trim();

    const vOnMatch = attributes.match(/v-on:click=["']([^"']+)["']/i) || attributes.match(/@click=["']([^"']+)["']/i);
    if (vOnMatch) return vOnMatch[1].trim();

    const onOnMatch = attributes.match(/on:click={([^}]+)}/);
    if (onOnMatch) return onOnMatch[1].trim();

    return null;
  }

  for (const file of frontendFiles) {
    try {
      const content = workspace.readFile(file);
      if (!content) continue;

      let foundAny = false;

      // Extract buttons
      const buttonRegex = /<button([^>]*)>([\s\S]*?)<\/button>/gi;
      let match;
      while ((match = buttonRegex.exec(content)) !== null) {
        const attributes = match[1];
        let text = match[2].trim().replace(/<[^>]+>/g, "").trim();
        if (!text && attributes.includes("aria-label")) {
            const ariaMatch = attributes.match(/aria-label=["']([^"']+)["']/i);
            if (ariaMatch) text = ariaMatch[1];
        }
        if (!text) text = "Unknown Button";

        let action = extractAction(attributes);
        facts.controls.push({
          text,
          type: "button",
          action: action || "Unknown action (No inline handler)",
          sourceRef: file,
          confidence: action ? "high" : "medium"
        });
        foundAny = true;
      }

      // Extract input buttons
      const inputRegex = /<input([^>]*type=["'](?:button|submit)["'][^>]*)>/gi;
      while ((match = inputRegex.exec(content)) !== null) {
        const attributes = match[1];
        let text = "Submit";
        const valMatch = attributes.match(/value=["']([^"']+)["']/i);
        if (valMatch) text = valMatch[1];
        
        let action = extractAction(attributes);
        facts.controls.push({
          text,
          type: "submit_input",
          action: action || "Form Submit",
          sourceRef: file,
          confidence: "high"
        });
        foundAny = true;
      }

      // Extract anchor tags that look like buttons
      const linkRegex = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
      while ((match = linkRegex.exec(content)) !== null) {
        const attributes = match[1];
        if (/class=["'][^"']*(?:btn|button|bg-blue-|cursor-pointer)[^"']*["']/i.test(attributes) || /role=["']button["']/i.test(attributes)) {
          let text = match[2].trim().replace(/<[^>]+>/g, "").trim();
          let action = extractAction(attributes);
          if (!action) {
            const hrefMatch = attributes.match(/href=["']([^"']+)["']/i);
            if (hrefMatch && hrefMatch[1] !== "#") action = `Navigate to ${hrefMatch[1]}`;
          }
          facts.controls.push({
            text: text || "Link Button",
            type: "link",
            action: action || "Unknown action",
            sourceRef: file,
            confidence: "medium"
          });
          foundAny = true;
        }
      }

      // Extract ad-hoc event listeners
      const addEventListenerRegex = /document\.getElementById\(['"]([^"']+)['"]\)\.addEventListener\(['"]click['"],\s*([^\)]+)\)/gi;
      while ((match = addEventListenerRegex.exec(content)) !== null) {
        const id = match[1];
        const handler = match[2].trim();
        facts.controls.push({
          text: `#${id}`,
          type: "other",
          action: `Listener: ${handler}`,
          sourceRef: file,
          confidence: "low"
        });
        foundAny = true;
      }

      if (foundAny) {
        facts.inspectedFiles.push(file);
      }
    } catch (e) {
      // Ignore unreadable files
    }
  }

  // Attempt to resolve "Unknown action" or function references by looking at the content
  // We can do a quick check to see if the action calls fetch
  for (const control of facts.controls) {
    if (control.action && !control.action.includes("Unknown")) {
      const funcNameMatch = control.action.match(/^([a-zA-Z0-9_$]+)/);
      if (funcNameMatch) {
        const funcName = funcNameMatch[1];
        const fileContent = workspace.readFile(control.sourceRef);
        if (fileContent) {
          const funcRegex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\}`, "i");
          const constFuncRegex = new RegExp(`const\\s+${funcName}\\s*=\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\}`, "i");
          
          let bodyMatch = funcRegex.exec(fileContent) || constFuncRegex.exec(fileContent);
          if (bodyMatch) {
            const body = bodyMatch[1];
            if (body.includes("fetch(")) {
              control.action += " (Makes API call)";
            } else if (body.includes("set") && fileContent.includes("useState")) {
              control.action += " (Updates React state)";
            } else if (body.includes("window.location")) {
              control.action += " (Navigates)";
            }
          }
        }
      }
    }
  }

  return facts;
}
