import { MAX_GRAPH_STEPS, type AgentState } from "./state";
import {
  answerNode,
  executeNode,
  generateNode,
  guardNode,
  repairNode,
  retrieveNode,
  type AgentDeps,
  type NodeId,
} from "./nodes";

const NODES: Record<
  Exclude<NodeId, "done">,
  (state: AgentState, deps: AgentDeps) => Promise<NodeId>
> = {
  retrieve: retrieveNode,
  generate: generateNode,
  guard: guardNode,
  execute: executeNode,
  repair: repairNode,
  answer: answerNode,
};

/**
 * Run the agent state graph: retrieve → generate → guard → execute → answer,
 * with repair loops back through generate. Total node executions capped at
 * MAX_GRAPH_STEPS. LLM failures degrade to graceful answers, not crashes.
 */
export async function runAgent(
  state: AgentState,
  deps: AgentDeps,
): Promise<AgentState> {
  let next: NodeId = "retrieve";
  let steps = 0;
  while (next !== "done" && steps < MAX_GRAPH_STEPS) {
    const current: Exclude<NodeId, "done"> = next;
    const node: (state: AgentState, deps: AgentDeps) => Promise<NodeId> = NODES[current];
    const started = Date.now();
    try {
      next = await node(state, deps);
      state.trace.push({ node: current, ms: Date.now() - started });
    } catch (err) {
      // LLM or infra failure mid-run: degrade, don't 500
      state.trace.push({
        node: current,
        ms: Date.now() - started,
        note: `error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
      });
      if (!state.answer) {
        state.answer =
          "The model is unavailable right now, so I couldn't complete that. Please try again in a moment.";
        state.status = "failed";
        state.error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      }
      next = "done";
    }
    steps += 1;
  }
  if (state.status === "working") state.status = "answered";
  if (!state.answer) {
    state.answer = "I ran out of steps before finishing. Try a narrower question.";
    state.status = "failed";
  }
  return state;
}
