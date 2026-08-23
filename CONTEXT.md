# Pi Atelier

Pi Atelier presents calm, session-scoped visibility into Pi without taking control away from the terminal workspace.

## Language

**Turn settled**:
The point at which Pi has no automatic retry, compaction retry, or queued continuation left and is waiting for the next user action.
_Avoid_: Task completed, session ended, agent ended

**Input requested**:
A state explicitly signaled by an interactive question tool that cannot continue until the user answers.
_Avoid_: Waiting, question detected

**Completion notification**:
A user-facing notice emitted when a Turn settles or Input is requested. It contains operational status only, never prompt or assistant-response content.
_Avoid_: Alert, task-complete notification

**Time to first token (TTFT)**:
The elapsed time from dispatching a provider request until its first generated response content arrives, including reasoning, visible text, or tool-call content.
_Avoid_: First visible text latency, first-token speed

**Generation throughput (TPS)**:
The final output-token count divided by elapsed generation time from the first generated token until the provider response ends.
_Avoid_: Request throughput, characters per second

**Subagent Fleet**:
The current-session set of active child agents reported by `pi-subagents` through its versioned public Fleet status interface. Pi Atelier presents operational display fields only: active count, custom agent/role, model effort, elapsed time, token usage, overflow, and top-level async capacity. It does not infer child state from transcript text or import package internals. The panel is absent when the integration is unavailable or the Fleet is idle.
_Avoid_: Subagent process list, scraped subagent output

**Workspace Pulse**:
A live summary of the current Git worktree's uncommitted change state that updates during an active Turn, not only after the Turn settles. The worktree containing the current directory defines the Workspace Pulse boundary, including when Pi starts in a repository subdirectory. HEAD is the committed baseline when it exists; a repository without commits uses an empty baseline and still has a valid Pulse. Its scope is the whole worktree, regardless of whether changes came from the current Turn, an earlier Turn, or the user. Untracked files belong to the Pulse but are represented by a separate count only; their contents and line totals are not inspected. The tracked and untracked file counts are mutually exclusive. The Pulse reports workspace facts, not test or validation status. It presents an aggregate summary rather than staged/unstaged or per-change-type breakdowns. Binary tracked files count as changed files but not as added or removed lines, and are called out separately when present. Changed Git submodules also count as tracked changes, have no line totals, and are identified separately from binary files. Unresolved merge or rebase conflicts are a distinct, highest-priority Pulse state while the remaining workspace summary stays available. Conflicted files remain included in the tracked change count; the conflict count identifies the affected subset. Before the first inspection completes, the Pulse is explicitly inspecting. A clean workspace is an explicit Pulse state, not the absence of Pulse data. A directory outside a Git repository and a failed Git inspection are distinct unavailable states; neither is treated as clean. If inspection fails after a successful Pulse, the last known snapshot may remain visible only when explicitly marked stale. Workspace Pulse inspection requests are coalesced and serialized: Turn start and tool activity request a live refresh, while Turn end waits for an inspection fresh through that point.
_Avoid_: Turn changes, Agent changes, Agent impact
