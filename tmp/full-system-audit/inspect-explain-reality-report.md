# Inspect/Explain Reality Report

Workspace: D:\projects\Ai\OrchCode_Studio_(Multi-Agent-Coding-System)
Provider: ollama qwen2.5-coder:7b
Ollama tags latency: 29 ms
Available models: gpt-oss:120b-cloud, qwen2.5-coder:7b, deepseek-coder:6.7b

| Prompt | Provider calls | Files surfaced | Fallback | Grade | Verdict |
| --- | ---: | ---: | --- | --- | --- |
| عندي هنا كام صفحة ف السيستم ده وكل واحدة بتعمل إيه؟ | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| إيه الزراير اللي عندي في السيستم وبتعمل إيه؟ | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| عندنا كام algorithm هنا؟ واشرحهم واحدة واحدة. | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| ازاي الDBSCAN بيتطبق هنا؟ اشرح بالتفصيل. | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| ازاي الfeedback بيتطبق هنا؟ اشرح بالتفصيل. | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| ازاي الouterloop بيتطبق هنا؟ اشرح بالتفصيل. | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| هل فيه inner loop و outer loop هنا؟ الفرق بينهم إيه؟ | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |
| هل عندي training و inference منفصلين؟ كل واحد فين وبيعمل إيه؟ | 1 | 0 | unknown | C | no opened/searched file evidence surfaced |

## Failures
None.

## Notes
- `swarmUsed` is recorded as false because the inspect/explain runtime path calls ProjectIntake and UniversalProjectQuestionEngine directly; no SwarmRuntime entry point was observed in this path.
- Grades are audit heuristics, not product tests. They penalize no provider call, no citations, not-found answers for requested concepts, and lack of surfaced file evidence.
