import {one,transaction} from "@infra/db";
import {enqueue} from "@core/jobs";
import {deepseek} from "@shared/config";
import {addSeconds} from "@shared/time";
import {portraitCutoff} from "./portrait-invalidation";

/** Debounce portrait work. It runs after a successful chat and never calls a model on the send path. */
export function scheduleUserPortrait(userId:string):number|null{
  if(!deepseek().apiKey)return null;
  return transaction(()=>{
    if(one("SELECT id FROM jobs WHERE kind='user_portrait' AND status IN ('pending','running') AND json_extract(payload,'$.user_id')=? LIMIT 1",userId))return null;
    const saved=one("SELECT sources FROM user_portraits WHERE user_id=?",userId);
    const represented=Math.max(portraitCutoff(userId),...(saved?(JSON.parse(String(saved.sources)) as Array<{kind:string;id:number}>).filter(item=>item.kind==="message").map(item=>item.id):[0]));
    const recent=one("SELECT count(*) AS n,max(id) AS last_id FROM messages WHERE user_id=? AND role='user' AND trim(content)!='' AND id>?",userId,represented)!;
    const hasMemory=Boolean(one("SELECT id FROM memories WHERE user_id=? AND status='active' LIMIT 1",userId));
    if(Number(recent.n)<3&&(saved||!hasMemory||!Number(recent.n)))return null;
    return enqueue("user_portrait",{user_id:userId},addSeconds(45),`user-portrait:${userId}:${recent.last_id}`,3);
  });
}
