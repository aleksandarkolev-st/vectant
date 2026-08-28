Implement the following agent architecture in the existing codebase.

The goal is to make **every meaningful atomic change** go through a lightweight routing step before execution.

For each atomic task/change:

1. Decompose larger requests into the smallest independently solvable atomic changes.
2. For each atomic change, spawn the **cheapest capable routing sub-agent**.
3. The routing sub-agent must NOT solve the task. Its only job is to inspect the available skill catalog and return:

   * the recommended execution agent role;
   * the minimum relevant skill or skills;
   * whether independent validation is required;
   * a very short reason for the decision.
4. Only after routing, spawn the smallest appropriate execution sub-agent.
5. Give the execution agent only:

   * the atomic task;
   * minimal relevant repository context;
   * the selected skills;
   * the tools exposed by or associated with those skills.
6. Do not expose the full tool catalog or all skill contents to every agent.
7. After execution, run the smallest appropriate validation agent when validation is required.

The architecture should follow this conceptual hierarchy:

```text
User request
    ↓
Main orchestrator
    ↓
Decompose into atomic changes
    ↓
Cheap routing sub-agent
    ↓
Inspect skill index / metadata
    ↓
Return relevant skill(s) + agent role
    ↓
Execution sub-agent
    ↓
Selected skills
    ↓
Relevant tools only
    ↓
Apply atomic change
    ↓
Validation sub-agent
```

Use these concepts consistently:

* **Agents = reasoning roles**
* **Skills = reusable specialized knowledge/workflows**
* **Tools = executable capabilities**

Do NOT create one agent per skill or one agent per tool.

Prefer a small reusable set of agent roles such as:

```text
implementation
debugging
infrastructure
data
security
research
validation
```

Skills should provide the specialization within those roles.

For example:

```text
debugging agent
    + postgres-debugging skill
    + docker-logs skill

infrastructure agent
    + docker skill
    + nginx skill
```

Design skill discovery so the router does not need to load every full `SKILL.md`.

Create or use a lightweight skill registry/index containing enough metadata to select skills, for example:

```text
skill id
name
description
task categories
keywords/capabilities
skill path
associated tool groups
```

The router should inspect this lightweight metadata first and only load full skill instructions after selecting a skill.

The desired scaling behavior is:

```text
500 tools
   ↓
skill metadata lookup
   ↓
1–3 relevant skills
   ↓
small relevant tool subset
   ↓
execution agent
```

NOT:

```text
every agent
   ↓
500 tool descriptions
   ↓
all skills
   ↓
reasoning
```

The router output should use a small machine-readable structure similar to:

```json
{
  "role": "debugging",
  "skills": [
    "postgres-debugging",
    "docker-logs"
  ],
  "validation": "integration-tests",
  "reason": "The failure crosses the application and database boundary."
}
```

Keep routing cheap:

* use the cheapest available model/sub-agent capable of reliable classification;
* pass minimal context;
* avoid repository-wide context unless necessary;
* avoid full skill bodies during routing;
* avoid full tool schemas during routing.

Do not spawn a routing sub-agent for completely trivial mechanical operations where the routing overhead would clearly exceed the work itself. Build a small explicit fast-path for those operations.

The main orchestrator should remain responsible for:

* decomposing work;
* managing dependencies between atomic changes;
* invoking routers;
* spawning execution agents;
* collecting results;
* deciding when further atomic changes are required.

Execution sub-agents should remain narrow and disposable. They should not silently expand their scope into unrelated work.

Validation should be independent when practical. The validator should inspect the resulting change rather than merely trusting the execution agent's own report.

Before writing code:

1. Inspect the current agent/sub-agent architecture.
2. Locate existing `AGENTS.md`, skill handling, tool registry/discovery, model selection, and validation logic.
3. Reuse existing abstractions rather than creating parallel systems.
4. Identify the smallest architectural changes required.

Then implement the architecture end-to-end.

Include:

* skill metadata/index representation;
* skill discovery/routing logic;
* cheapest-capable sub-agent selection;
* execution-agent role selection;
* selective skill loading;
* selective tool exposure;
* atomic task orchestration;
* validation routing;
* sensible fallbacks when no skill matches;
* logging/tracing sufficient to see:

  * atomic task;
  * router chosen;
  * skill(s) selected;
  * execution agent chosen;
  * tools exposed;
  * validator used;
* tests for the routing and orchestration behavior.

Important constraints:

* Do not hard-code routing around only the current skills.
* The design must remain usable if the system grows to hundreds of skills and 500+ tools.
* Do not duplicate full skill descriptions into prompts if metadata is sufficient.
* Do not require all tools to be loaded into model context for selection.
* Preserve backwards compatibility where reasonably possible.
* Prefer simple abstractions over a large new framework.
* Keep each component single-purpose.
* Avoid oversized files; split responsibilities where appropriate.
* Do not merely produce a design document. Make the actual code changes.

After implementation:

1. Run the relevant tests.
2. Add tests for at least:

   * one-skill routing;
   * multi-skill routing;
   * no-match fallback;
   * trivial-operation fast path;
   * cheapest-agent selection;
   * selective tool exposure;
   * validation invocation;
   * failure of an execution agent and appropriate propagation/recovery.
3. Review the implementation for places where the full skill/tool catalog is accidentally injected into context.
4. Fix issues you find.
5. Return a concise summary of the architecture, files changed, tests run, and any remaining limitations.