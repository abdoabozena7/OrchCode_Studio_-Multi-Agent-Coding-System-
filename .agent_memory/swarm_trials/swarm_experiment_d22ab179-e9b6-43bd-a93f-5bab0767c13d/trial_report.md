# Swarm Autopilot Trial Report

## Summary
Ran 10 automatic staffing scenario(s); 8/10 staffing accuracy.

## Staffing Accuracy
Accuracy: 0.8

### tiny: Change the label text in one HTML/component file.
- Result: pass
- Expected range: 3-8
- Actual agents: 5
- Executor limit: 1
- Specialists: none
- Deviations: none
### small: Fix a small bug in one function.
- Result: fail
- Expected range: 4-10
- Actual agents: 9
- Executor limit: 1
- Specialists: AccessibilityReviewerAgent
- Deviations: Unnecessary specialist AccessibilityReviewerAgent was created.
### medium: Add a feature touching one module and its tests.
- Result: pass
- Expected range: 10-30
- Actual agents: 25
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, AccessibilityReviewerAgent, TestCoverageReviewerAgent
- Deviations: none
### large: Refactor a cross-module service while preserving public API behavior.
- Result: fail
- Expected range: 35-130
- Actual agents: 25
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, AccessibilityReviewerAgent, APICompatibilityReviewerAgent
- Deviations: Expected agent range 35-130, got 25.
### huge: Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.
- Result: pass
- Expected range: 80-300
- Actual agents: 300
- Executor limit: 0
- Specialists: AccessibilityReviewerAgent, TestCoverageReviewerAgent, DocumentationReviewerAgent
- Deviations: none
### small: Modify the authentication/session/permission behavior.
- Result: pass
- Expected range: 5-30
- Actual agents: 13
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, AccessibilityReviewerAgent
- Deviations: none
### large: Add or change database migration behavior.
- Result: pass
- Expected range: 30-140
- Actual agents: 64
- Executor limit: 2
- Specialists: MigrationSafetyReviewerAgent, AccessibilityReviewerAgent
- Deviations: none
### medium: Update a shared UI component with accessibility-safe behavior.
- Result: pass
- Expected range: 8-40
- Actual agents: 22
- Executor limit: 1
- Specialists: AccessibilityReviewerAgent
- Deviations: none
### small: Make the app better and cleaner. Do not edit files until the plan is decomposed.
- Result: pass
- Expected range: 3-20
- Actual agents: 8
- Executor limit: 0
- Specialists: AccessibilityReviewerAgent
- Deviations: none
### huge: Upgrade a major framework version across the project as a staged campaign.
- Result: pass
- Expected range: 80-300
- Actual agents: 121
- Executor limit: 2
- Specialists: AccessibilityReviewerAgent, DependencyUpgradeReviewerAgent
- Deviations: none

## Comparison
No comparison was run.

## Safety
- Change the label text in one HTML/component file.: executor_limit=1, read_only_ratio=0.8
- Fix a small bug in one function.: executor_limit=1, read_only_ratio=0.89
- Add a feature touching one module and its tests.: executor_limit=1, read_only_ratio=0.92
- Refactor a cross-module service while preserving public API behavior.: executor_limit=1, read_only_ratio=0.92
- Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.: executor_limit=0, read_only_ratio=1
- Modify the authentication/session/permission behavior.: executor_limit=1, read_only_ratio=0.92
- Add or change database migration behavior.: executor_limit=2, read_only_ratio=0.95
- Update a shared UI component with accessibility-safe behavior.: executor_limit=1, read_only_ratio=0.91
- Make the app better and cleaner. Do not edit files until the plan is decomposed.: executor_limit=0, read_only_ratio=1
- Upgrade a major framework version across the project as a staged campaign.: executor_limit=2, read_only_ratio=0.98

## Specialist Selection
- Change the label text in one HTML/component file.: specialists=none
- Fix a small bug in one function.: specialists=AccessibilityReviewerAgent
- Add a feature touching one module and its tests.: specialists=AuthSecurityReviewerAgent, AccessibilityReviewerAgent, TestCoverageReviewerAgent
- Refactor a cross-module service while preserving public API behavior.: specialists=AuthSecurityReviewerAgent, AccessibilityReviewerAgent, APICompatibilityReviewerAgent
- Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.: specialists=AccessibilityReviewerAgent, TestCoverageReviewerAgent, DocumentationReviewerAgent
- Modify the authentication/session/permission behavior.: specialists=AuthSecurityReviewerAgent, AccessibilityReviewerAgent
- Add or change database migration behavior.: specialists=MigrationSafetyReviewerAgent, AccessibilityReviewerAgent
- Update a shared UI component with accessibility-safe behavior.: specialists=AccessibilityReviewerAgent
- Make the app better and cleaner. Do not edit files until the plan is decomposed.: specialists=AccessibilityReviewerAgent
- Upgrade a major framework version across the project as a staged campaign.: specialists=AccessibilityReviewerAgent, DependencyUpgradeReviewerAgent

## Tuning Recommendations
- 2 staffing scenario(s) deviated from expectations; tune thresholds only after repeated evidence.
- No comparison run was included.
- Do not update defaults from one noisy experiment; require confidence and repeated evidence.