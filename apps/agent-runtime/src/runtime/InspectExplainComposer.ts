import type { InspectExplainFacts } from "./InspectExplainFacts.js";

export function composeAnswer(
  facts: InspectExplainFacts,
  topic: "frontend" | "algorithms" | "training_inference" | "code_flow" | "ui_controls" | "general",
  language: "arabic" | "english",
  style: "child_simple" | "detailed" | "default" | "technical" | "concise"
): string {
  const ref = (path: string) => `[${path}:1](hivo-file:${encodeURIComponent(path)}:1)`;

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
    if (style === "detailed") {
      const links = facts.codeFlow.steps.map((step) => ref(step.sourceRef)).join(", ");
      if (language === "arabic") {
        let ans = `## الخلاصة\nالفلو مثبت من ملفات المشروع، وأهم الأدلة موجودة هنا: ${links}.\n\n## التسلسل بالتفصيل\n`;
        for (const step of facts.codeFlow.steps) {
          ans += `\n### ${step.order}. ${step.label}\n`;
          ans += `- **ماذا يحدث:** ${step.description}. دي خطوة مثبتة من الكود وليست افتراض عام.\n`;
          ans += `- **لماذا مهمة:** الخطوة دي بتشرح دور الجزء ده في السلسلة: تجهيز بيانات، تدريب/تحميل موديل، تنبؤ، شرح النتيجة، أو استخدامها في API/service flow.\n`;
          ans += `- **أين:** ${ref(step.sourceRef)}\n`;
        }
        ans += `\n## العلاقة بين الأجزاء\n${facts.codeFlow.steps.map((step) => step.label).join(" -> ")}. التسلسل ده يوضح إزاي النتيجة بتنتقل من مرحلة للي بعدها بدل ما تكون مجرد أسماء متفرقة في الملفات.\n`;
        if (facts.codeFlow.uncertainties.length) {
          ans += `\n## غير مؤكد\n${facts.codeFlow.uncertainties.map((item) => `- ${item}`).join("\n")}\n`;
        }
        return ans;
      }
      let ans = `## Summary\nThe flow is grounded in project files: ${links}.\n\n## Detailed Flow\n`;
      for (const step of facts.codeFlow.steps) {
        ans += `\n### ${step.order}. ${step.label}\n`;
        ans += `- What happens: ${step.description}.\n`;
        ans += `- Why it matters: this step shows how data/model state moves through the implementation instead of being a loose file mention.\n`;
        ans += `- Where: ${ref(step.sourceRef)}\n`;
      }
      ans += `\n## How The Pieces Connect\n${facts.codeFlow.steps.map((step) => step.label).join(" -> ")}.\n`;
      return ans;
    }
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
