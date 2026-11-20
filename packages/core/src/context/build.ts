import { current } from "@world/emotion";
import { forUser } from "@memory";
import { profiles } from "@world/npc";
import { listGoals } from "@world/stories";
import { events } from "@world/daily-life";
import { activeFacts } from "@world/lore";
import { getRelationship } from "@people/relationship";
import { contextQuery, relevantGoals, relevantLore, relevantNpcs } from "../../../prompting/src/context-selection";

function estimateTokens(text: string): number {
  return Math.max(1, Math.trunc(text.length * 0.75));
}

export function buildContext(userId: string, query: string, budget = 5000, history:Array<{role:string;content:string}>=[]) {
  const selectionQuery=contextQuery(query,history);
  const memories = forUser(userId, query, 12);
  const emotion = current(userId);
  const relationship = getRelationship(userId);
  let used = estimateTokens(JSON.stringify(emotion)) + estimateTokens(JSON.stringify(relationship));
  const selected = [];
  // Private recall must not disappear merely because public configuration has become richer.
  const memoryBudget = Math.max(0,Math.min(budget-used,Math.floor(budget*0.5)));
  let memoryUsed=0;
  for (const item of memories) {
    const cost = estimateTokens(item.text);
    if (memoryUsed + cost > memoryBudget) continue;
    selected.push(item);
    used += cost;memoryUsed+=cost;
  }
  function fit<T>(items:T[]):T[]{const result:T[]=[];for(const item of items){const cost=estimateTokens(JSON.stringify(item));if(used+cost>budget)continue;result.push(item);used+=cost;}return result;}
  const worldEvents=fit(events(undefined,userId));
  const goals=fit(relevantGoals(listGoals(),selectionQuery));
  const npcs=fit(relevantNpcs(profiles(),selectionQuery));
  const lore=fit(relevantLore(activeFacts(1000),selectionQuery));
  return { world_events: worldEvents, world_facts: lore, memories: selected, goals, npcs, emotion, relationship, estimated_tokens: used, budget };
}
