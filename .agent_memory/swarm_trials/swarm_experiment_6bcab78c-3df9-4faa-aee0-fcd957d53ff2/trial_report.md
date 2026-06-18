# Swarm Autopilot Trial Report

## Summary
Ran 10 automatic staffing scenario(s); 10/10 staffing accuracy.

## Staffing Accuracy
Accuracy: 1

### tiny: Change the label text in one HTML/component file.
- Result: pass
- Expected range: 3-8
- Actual agents: 5
- Executor limit: 1
- Specialists: none
- Deviations: none
### small: Fix a small bug in one function.
- Result: pass
- Expected range: 4-10
- Actual agents: 8
- Executor limit: 1
- Specialists: none
- Deviations: none
### medium: Add a feature touching one module and its tests.
- Result: pass
- Expected range: 10-30
- Actual agents: 24
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, TestCoverageReviewerAgent
- Deviations: none
### large: Refactor a cross-module service while preserving public API behavior.
- Result: pass
- Expected range: 35-130
- Actual agents: 76
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Deviations: none
### huge: Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.
- Result: pass
- Expected range: 80-300
- Actual agents: 300
- Executor limit: 0
- Specialists: TestCoverageReviewerAgent, DocumentationReviewerAgent
- Deviations: none
### small: Modify the authentication/session/permission behavior.
- Result: pass
- Expected range: 5-30
- Actual agents: 12
- Executor limit: 1
- Specialists: AuthSecurityReviewerAgent
- Deviations: none
### large: Add or change database migration behavior.
- Result: pass
- Expected range: 30-140
- Actual agents: 74
- Executor limit: 2
- Specialists: MigrationSafetyReviewerAgent
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
- Actual agents: 7
- Executor limit: 0
- Specialists: none
- Deviations: none
### huge: Upgrade a major framework version across the project as a staged campaign.
- Result: pass
- Expected range: 80-300
- Actual agents: 134
- Executor limit: 2
- Specialists: DependencyUpgradeReviewerAgent
- Deviations: none

## Comparison
No comparison was run.

## Safety
- Change the label text in one HTML/component file.: executor_limit=1, read_only_ratio=0.8
- Fix a small bug in one function.: executor_limit=1, read_only_ratio=0.88
- Add a feature touching one module and its tests.: executor_limit=1, read_only_ratio=0.92
- Refactor a cross-module service while preserving public API behavior.: executor_limit=1, read_only_ratio=0.97
- Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.: executor_limit=0, read_only_ratio=1
- Modify the authentication/session/permission behavior.: executor_limit=1, read_only_ratio=0.92
- Add or change database migration behavior.: executor_limit=2, read_only_ratio=0.96
- Update a shared UI component with accessibility-safe behavior.: executor_limit=1, read_only_ratio=0.91
- Make the app better and cleaner. Do not edit files until the plan is decomposed.: executor_limit=0, read_only_ratio=1
- Upgrade a major framework version across the project as a staged campaign.: executor_limit=2, read_only_ratio=0.98

## Specialist Selection
- Change the label text in one HTML/component file.: specialists=none
- Fix a small bug in one function.: specialists=none
- Add a feature touching one module and its tests.: specialists=AuthSecurityReviewerAgent, TestCoverageReviewerAgent
- Refactor a cross-module service while preserving public API behavior.: specialists=AuthSecurityReviewerAgent, APICompatibilityReviewerAgent
- Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.: specialists=TestCoverageReviewerAgent, DocumentationReviewerAgent
- Modify the authentication/session/permission behavior.: specialists=AuthSecurityReviewerAgent
- Add or change database migration behavior.: specialists=MigrationSafetyReviewerAgent
- Update a shared UI component with accessibility-safe behavior.: specialists=AccessibilityReviewerAgent
- Make the app better and cleaner. Do not edit files until the plan is decomposed.: specialists=none
- Upgrade a major framework version across the project as a staged campaign.: specialists=DependencyUpgradeReviewerAgent

## Tuning Recommendations
- Staffing expectations passed in this run; keep defaults stable.
- No comparison run was included.
- Do not update defaults from one noisy experiment; require confidence and repeated evidence.