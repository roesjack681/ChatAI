import {one,run} from "@infra/db";
import {isoNow} from "@shared/time";
export const PORTRAIT_CUTOFF_KEY="portrait:after_message_id";
export function portraitCutoff(userId:string):number{return Math.max(0,Number(one("SELECT value FROM preferences WHERE user_id=? AND key=?",userId,PORTRAIT_CUTOFF_KEY)?.value??0)||0);}
/** Retain the chat itself, while preventing a deleted fact from being regenerated from old chat. */
export function invalidateUserPortrait(userId:string){
  const last=Number(one("SELECT coalesce(max(id),0) AS id FROM messages WHERE user_id=? AND role='user'",userId)?.id??0);
  run("DELETE FROM user_portraits WHERE user_id=?",userId);
  run("INSERT INTO preferences(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",userId,PORTRAIT_CUTOFF_KEY,String(last),isoNow());
  run("UPDATE jobs SET status='completed',finished_at=? WHERE kind='user_portrait' AND status='pending' AND json_extract(payload,'$.user_id')=?",isoNow(),userId);
}
