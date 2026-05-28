# Swarm Autopilot Trial Report

## Summary
autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.

## Staffing Accuracy
Accuracy: 1

### large: Refactor a cross-module service while preserving public API behavior.
- Result: pass
- Expected range: 1-300
- Actual agents: 65
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Deviations: none
### large: Refactor a cross-module service while preserving public API behavior.
- Result: pass
- Expected range: 1-300
- Actual agents: 65
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Deviations: none
### large: Refactor a cross-module service while preserving public API behavior.
- Result: pass
- Expected range: 1-300
- Actual agents: 65
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Deviations: none

## Comparison
Recommendation: autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.
- baseline-simple: success=0.55, useful=0.32, duplicate=0.03, agents=1
- orchestrated: success=0.68, useful=0.44, duplicate=0.08, agents=6
- autopilot-fast: success=0.78, useful=0.53, duplicate=0.08, agents=65
- autopilot-deep: success=0.78, useful=0.53, duplicate=0.08, agents=65
- autopilot-exhaustive: success=0.78, useful=0.53, duplicate=0.08, agents=65

## Safety
- Refactor a cross-module service while preserving public API behavior.: executor_limit=1, read_only_ratio=0.97
- Refactor a cross-module service while preserving public API behavior.: executor_limit=1, read_only_ratio=0.97
- Refactor a cross-module service while preserving public API behavior.: executor_limit=1, read_only_ratio=0.97

## Specialist Selection
- Refactor a cross-module service while preserving public API behavior.: specialists=AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Refactor a cross-module service while preserving public API behavior.: specialists=AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Refactor a cross-module service while preserving public API behavior.: specialists=AuthSecurityReviewerAgent, APICompatibilityReviewerAgent

## Tuning Recommendations
- Staffing expectations passed in this run; keep defaults stable.
- autopilot-fast has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.
- Do not update defaults from one noisy experiment; require confidence and repeated evidence.