import type { InspectExplainFacts } from "./InspectExplainFacts.js";

export function composeAnswer(
  facts: InspectExplainFacts,
  topic: "frontend" | "algorithms" | "training_inference" | "code_flow" | "ui_controls" | "general",
  language: "arabic" | "english",
  style: "child_simple" | "detailed" | "default" | "technical" | "concise"
): string {
  const ref = (path: string) => `[${path}:1](orchcode-file:${encodeURIComponent(path)}:1)`;

  if (topic === "frontend" && facts.frontend) {
    if (language === "arabic") {
      let ans = `لقيت ${facts.frontend.totalItems} صفحة أو عنصر واجهة:\n\n`;
      for (const item of facts.frontend.items) {
        ans += `- **${item.name}** (${item.type}): ${item.purpose} ${ref(item.sourceRef)}\n`;
      }
      return ans;
    } else {
      let ans = `I found ${facts.frontend.totalItems} frontend structural item(s):\n\n`;
      for (const item of facts.frontend.items) {
        ans += `- **${item.name}** (${item.type}): ${item.purpose} ${ref(item.sourceRef)}\n`;
      }
      return ans;
    }
  }

  if (topic === "algorithms" && facts.algorithms) {
    if (language === "arabic") {
      if (style === "child_simple") {
         let ans = `عندنا ${facts.algorithms.deduplicatedCount} خوارزميات/نماذج هنا زي اللعب اللي بتفكر:\n\n`;
         for (const item of facts.algorithms.items) {
           ans += `- **${item.name}** (${item.classification}): ${item.description} ${ref(item.sourceRef)}\n`;
         }
         return ans;
      }
      if (style === "detailed") {
         let ans = `تم العثور على ${facts.algorithms.deduplicatedCount} خوارزمية/نموذج بالتفصيل:\n\n`;
         for (const item of facts.algorithms.items) {
           ans += `- **${item.name}** (${item.classification}): ${item.description} ${ref(item.sourceRef)}\n`;
         }
         return ans;
      }
      let ans = `عندنا ${facts.algorithms.deduplicatedCount} algorithm/model هنا:\n\n`;
      for (const item of facts.algorithms.items) {
        ans += `- **${item.name}** (${item.classification}): ${item.description} ${ref(item.sourceRef)}\n`;
      }
      return ans;
    } else {
      if (style === "detailed") {
        let ans = `I found ${facts.algorithms.deduplicatedCount} algorithms/models in detail:\n\n`;
        for (const item of facts.algorithms.items) {
          ans += `- **${item.name}** (${item.classification}): ${item.description} ${ref(item.sourceRef)}\n`;
        }
        return ans;
      }
      let ans = `I found ${facts.algorithms.deduplicatedCount} algorithms/models:\n\n`;
      for (const item of facts.algorithms.items) {
        ans += `- **${item.name}** (${item.classification}): ${item.description} ${ref(item.sourceRef)}\n`;
      }
      return ans;
    }
  }

  if (topic === "training_inference" && facts.trainingInference) {
    if (language === "arabic") {
       let ans = `هل عندي training و inference منفصلين هنا؟\nالإجابة: ${facts.trainingInference.separation === "yes" ? "أيوه منفصلين" : (facts.trainingInference.separation === "partial" ? "منفصلين جزئياً" : "لا، أو مش واضح")}.\n\nالـ Training: ${facts.trainingInference.training.length} دوال\n`;
       for (const t of facts.trainingInference.training) {
         ans += `- ${t.name} ${ref(t.sourceRef)}\n`;
       }
       ans += `\nالـ Inference: ${facts.trainingInference.inference.length} دوال\n`;
       for (const i of facts.trainingInference.inference) {
         ans += `- ${i.name} ${ref(i.sourceRef)}\n`;
       }
       return ans;
    } else {
       let ans = `Is training and inference separated?\nAnswer: ${facts.trainingInference.separation}.\n\nTraining items: ${facts.trainingInference.training.length}\n`;
       for (const t of facts.trainingInference.training) {
         ans += `- ${t.name} ${ref(t.sourceRef)}\n`;
       }
       ans += `\nInference items: ${facts.trainingInference.inference.length}\n`;
       for (const i of facts.trainingInference.inference) {
         ans += `- ${i.name} ${ref(i.sourceRef)}\n`;
       }
       return ans;
    }
  }

  if (topic === "code_flow" && facts.codeFlow) {
    if (language === "arabic") {
      let ans = `إزاي بيطبق هنا؟ ده تسلسل الشغل بالتفصيل:\n\n`;
      for (const step of facts.codeFlow.steps) {
        ans += `${step.order}. **${step.label}**: ${step.description} ${ref(step.sourceRef)}\n`;
      }
      return ans;
    } else {
      let ans = `Here is the detailed code flow:\n\n`;
      for (const step of facts.codeFlow.steps) {
        ans += `${step.order}. **${step.label}**: ${step.description} ${ref(step.sourceRef)}\n`;
      }
      return ans;
    }
  }

  if (topic === "ui_controls" && facts.uiControls) {
    if (language === "arabic") {
      let ans = `لقيت ${facts.uiControls.controls.length} زرار أو أكشن في الواجهة:\n\n`;
      let count = 1;
      for (const ctrl of facts.uiControls.controls) {
        ans += `${count}. **${ctrl.text}**\n   المكان: ${ref(ctrl.sourceRef)}\n   بيعمل: ${ctrl.action}\n\n`;
        count++;
      }
      return ans.trim();
    } else {
      let ans = `I found ${facts.uiControls.controls.length} UI controls or actions:\n\n`;
      let count = 1;
      for (const ctrl of facts.uiControls.controls) {
        ans += `${count}. **${ctrl.text}**\n   Location: ${ref(ctrl.sourceRef)}\n   Action: ${ctrl.action}\n\n`;
        count++;
      }
      return ans.trim();
    }
  }

  return "I have analyzed the project based on the request.";
}
