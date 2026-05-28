# Swarm Autopilot Trial Report

## Summary
autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.

## Staffing Accuracy
Accuracy: 1

### small: Explain architecture without editing
- Result: pass
- Expected range: 1-300
- Actual agents: 9
- Executor limit: 1
- Specialists: DocumentationReviewerAgent
- Deviations: none
### small: Explain architecture without editing
- Result: pass
- Expected range: 1-300
- Actual agents: 9
- Executor limit: 1
- Specialists: DocumentationReviewerAgent
- Deviations: none
### small: Explain architecture without editing
- Result: pass
- Expected range: 1-300
- Actual agents: 9
- Executor limit: 1
- Specialists: DocumentationReviewerAgent
- Deviations: none

## Comparison
Recommendation: autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.
- baseline-simple: success=0.55, useful=0.32, duplicate=0.03, agents=1
- orchestrated: success=0.68, useful=0.44, duplicate=0.08, agents=6
- autopilot-fast: success=0.8, useful=0.52, duplicate=0, agents=9
- autopilot-deep: success=0.8, useful=0.52, duplicate=0, agents=9
- autopilot-exhaustive: success=0.8, useful=0.52, duplicate=0, agents=9

## Safety
- Explain architecture without editing: executor_limit=1, read_only_ratio=0.89
- Explain architecture without editing: executor_limit=1, read_only_ratio=0.89
- Explain architecture without editing: executor_limit=1, read_only_ratio=0.89

## Specialist Selection
- Explain architecture without editing: specialists=DocumentationReviewerAgent
- Explain architecture without editing: specialists=DocumentationReviewerAgent
- Explain architecture without editing: specialists=DocumentationReviewerAgent

## Tuning Recommendations
- Staffing expectations passed in this run; keep defaults stable.
- autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.
- Do not update defaults from one noisy experiment; require confidence and repeated evidence.