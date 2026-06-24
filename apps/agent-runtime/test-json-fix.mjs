import { OllamaProvider } from "./src/llm/OllamaProvider.js";

async function main() {
  const provider = new OllamaProvider(
    "http://127.0.0.1:11434",
    "qwen2.5-coder:7b",
    300_000
  );

  // Test 1: Simple structured output
  console.log("=== Test 1: Simple JSON schema ===");
  try {
    const result = await provider.generateStructured(
      {
        systemPrompt: "You are a helpful assistant.",
        userPrompt: "What is 2+2? Return as JSON with 'answer' and 'score' fields.",
        responseFormat: "json",
        maxOutputTokens: 256
      },
      {
        type: "object",
        properties: {
          answer: { type: "string" },
          score: { type: "number" }
        },
        required: ["answer", "score"]
      }
    );
    console.log("Result:", JSON.stringify(result));
  } catch (e) {
    console.error("FAIL:", e.message);
  }

  // Test 2: More complex schema
  console.log("\n=== Test 2: Complex JSON schema ===");
  try {
    const result = await provider.generateStructured(
      {
        systemPrompt: "You analyze user requests and return structured intent data.",
        userPrompt: "Create a 3D Crossy Road game in a single HTML file using Three.js from CDN",
        responseFormat: "json",
        maxOutputTokens: 1024
      },
      {
        type: "object",
        properties: {
          project_type: { type: "string" },
          technologies: { type: "array", items: { type: "string" } },
          estimated_complexity: { type: "string" }
        },
        required: ["project_type", "technologies", "estimated_complexity"]
      }
    );
    console.log("Result:", JSON.stringify(result));
  } catch (e) {
    console.error("FAIL:", e.message);
  }
}

main().catch(console.error);
