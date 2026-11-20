type Data = Record<string, any>;

const GROUPS: Array<[RegExp, string[]]> = [
  [/换个话题|聊点别的/u,["hobbies","food_preferences","music_preferences","leisure_preferences"]],
  [/学校|大学|专业|年级|上学|读书|学什么/u,["school","major","academic_year","education"]],
  [/家人|家庭|家里|家境|父母|妈妈|母亲|爸爸|父亲|你爸|你妈|姐姐|姐妹|妹妹|哥哥|弟弟/u,["family_background","family_dynamics"]],
  [/宿舍|室友|舍友|住哪/u,["living_arrangement"]],
  [/样子|头发|外貌|长相|穿衣/u,["appearance"]],
  [/生日|哪天出生/u,["birthday"]],
  [/哪里人|家乡|老家/u,["hometown"]],
  [/歌|音乐|在听|那首/u,["music_preferences"]],
  [/书|小说|随笔|那本/u,["reading_preferences"]],
  [/口味|吃|喝|辣|饭/u,["food_preferences"]],
  [/游戏|王者|开黑|段位/u,["gaming_preferences"]],
  [/爱好|兴趣|闲着|平时爱|平时喜欢/u,["hobbies","leisure_preferences"]],
  [/钱|预算|消费|花销/u,["money_attitude"]],
  [/作息|日常|几点睡|几点起/u,["routines"]],
  [/未来|毕业|以后想|长期/u,["long_term_direction"]],
  [/童年|小时候|从小/u,["childhood"]],
  [/为什么.{0,8}(?:性格|温和|画画|设计)|性格.{0,6}(?:形成|变成)/u,["personality_origins"]],
  [/前任|初恋|恋爱经历|谈过|喜欢过|感情经历/u,["romantic_history"]],
  [/物品|随身|包里|素描本|杯子|帆布包/u,["important_objects"]],
  [/安慰|难过.*怎么办|放松|恢复心情/u,["comforts"]],
  [/讨厌|烦什么|雷点/u,["pet_peeves"]],
  [/害怕|怕什么|紧张/u,["fears"]],
  [/吵架|矛盾|分歧|和好/u,["conflict_style"]],
  [/受挫|失败|失落|不顺/u,["disappointment_style"]],
  [/幽默|玩笑/u,["humor_style"]],
  [/身体|过敏|健康|肩颈/u,["health_and_habits"]],
  [/手机|社交账号|微信|电话号码/u,["digital_habits"]],
  [/独处|空间|回复.*慢/u,["personal_space"]],
  [/颜色|奶茶|糖|天气.*喜欢|小习惯/u,["small_preferences"]],
  [/牵挂|最近.*烦|最近.*担心/u,["current_concerns"]],
];
const OPTIONAL = new Set(GROUPS.flatMap(([,fields])=>fields).concat(["gender","life_experiences","relationship_network"]));
function userSubject(query: string) {
  const own = /(?:我|我们)(?:的|家)?(?:室友|舍友|朋友|同学|妈妈|母亲|爸爸|姐姐|妹妹|家人|生日|学校|专业|目标|小时候|童年|高中|经历)|我.{0,4}(?:喜欢|不喜欢|吃|喝)/u.test(query);
  const role = /(?:你(?:的|家)?|知夏).{0,5}(?:室友|舍友|朋友|家人|妈妈|母亲|姐姐|生日|学校|专业|口味|爱好|吃|喝|目标|小时候|童年|高中|经历)/u.test(query);
  return own && !role;
}

export function personaForTurn(persona: Data, query: string): Data {
  const fields = new Set(GROUPS.filter(([pattern]) => pattern.test(query)).flatMap(([,fields])=>fields));
  if (/优点|缺点|擅长|性格/u.test(query)) { fields.add("strengths");fields.add("weaknesses"); }
  if (/男生|女生|男的|女的|性别/u.test(query)) fields.add("gender");
  if (userSubject(query)) fields.clear();
  const selected = Object.fromEntries(Object.entries(persona).filter(([key])=>!OPTIONAL.has(key)||fields.has(key)));
  if (!userSubject(query)) {
    const past = /经历|小时候|童年|从小|小学|初中|高中|大学前|以前|怎么认识|为什么.*(?:学|选|设计)|吵过|吵架|闹过|具体说一件|拖延|受挫|性格.*(?:形成|原因)/u.test(query);
    const allPast = /人生经历|成长经历|成长过程|经历有哪些/u.test(query);
    const experiences = Array.isArray(persona.life_experiences) ? persona.life_experiences : [];
    if (past) {
      const matched = experiences.filter((item:Data)=>(item.keywords ?? []).some((word:string)=>query.includes(word)) || (item.people ?? []).some((name:string)=>query.includes(name)) || query.includes(item.period)
        || /选.*专业|选.*设计|为什么.*设计|这个专业/u.test(query)&&item.id==="design-choice"
        || /室友|舍友/u.test(query)&&item.id==="roommate-boundary"
        || /拖延|作业.*狼狈/u.test(query)&&item.id==="course-deadline");
      selected.life_experiences = (allPast ? experiences : matched.length ? matched : experiences.slice(0,2)).slice(0,allPast?10:3);
    }
    const relations = Array.isArray(persona.relationship_network) ? persona.relationship_network : [];
    if (/家人|家庭|家里|父母|关系网|朋友|室友|舍友|爸|妈|姐姐|姐妹|阿宁|许棠|周敏|林建平|林晚晴/u.test(query)) {
      const selectedNames = relevantNpcs(relations.map((item:Data)=>({name:item.to,relationship:item.relation})),query).map((item:Data)=>item.name);
      selected.relationship_network = relations.filter((item:Data)=>/家人|家庭|家里|父母|关系网/u.test(query) || query.includes(item.from) || query.includes(item.to) || selectedNames.includes(item.to) || /姐姐|姐妹/u.test(query)&&/姐妹/u.test(item.relation) || /爸/u.test(query)&&/父女|夫妻/u.test(item.relation) || /妈/u.test(query)&&/母女|夫妻/u.test(item.relation)).slice(0,8);
    }
  }
  return selected;
}

export function relevantNpcs<T extends Data>(people: T[], query: string): T[] {
  if (!query) return people;
  if (userSubject(query)) return [];
  const relations: Array<[RegExp,RegExp]> = [
    [/roommate|室友|舍友/u,/室友|舍友/u], [/mother|母亲|妈妈|母女/u,/妈妈|母亲|你妈|家人|家庭|家里|父母/u],
    [/sister|姐姐|姐妹|妹妹/u,/姐姐|姐妹|妹妹|家人|家庭|家里/u], [/friend|朋友|好友/u,/朋友|好友/u],
    [/classmate|同学/u,/同学|社团|摄影社/u], [/father|父亲|父女/u,/爸爸|父亲|你爸|家人|家庭|家里|父母/u],
  ];
  return people.filter((person)=>query.includes(String(person.name)) || relations.some(([relation,topic])=>relation.test(String(person.relationship))&&topic.test(query))).slice(0,6);
}

/** Carry only referential questions back to their recent subject; acknowledgments stay lightweight. */
export function contextQuery(query:string,history:Array<{role:string;content:string}>) {
  if (!/(?:你俩|你们|姐妹|这件事|这个专业|那件|那次|当时|后来|具体说一件|还这样|怎么认识)/u.test(query)) return query;
  const prior=history.filter((message)=>message.role==="user").at(-1)?.content;
  return prior ? `${query}\n前一个话题：${prior}` : query;
}

export function relevantGoals<T extends Data>(goals: T[], query: string): T[] {
  if (!query) return goals;
  if (userSubject(query) || /^我(?:准备|打算|计划|想)/u.test(query)) return [];
  const asksGoals = /(?:你|知夏).{0,10}(?:目标|计划|想做|想学|打算)|(?:有什么|哪些).{0,5}(?:目标|计划)/u.test(query);
  return goals.filter((goal)=>asksGoals || query.includes(String(goal.title)) || /作品集/u.test(query)&&/作品集/u.test(String(goal.title)) || /(?:你|知夏).{0,5}摄影/u.test(query)&&/摄影/u.test(String(goal.title))).slice(0,5);
}

export function relevantLore<T extends Data>(facts: T[], query: string): T[] {
  if (!query) return facts;
  const bigrams = [...new Set([...query.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(([text])=>Array.from({length:text.length-1},(_,index)=>text.slice(index,index+2))))];
  return facts.filter((fact)=>query.includes(String(fact.subject)) || bigrams.some((part)=>String(fact.subject).includes(part))
    || fact.scope==="character"&&bigrams.some((part)=>String(fact.predicate).includes(part))
    || fact.scope==="character"&&/住哪|住在|哪个城市/u.test(query)&&/城市|居住|住址/u.test(String(fact.predicate))
    || fact.scope==="organization"&&/学校|社团/u.test(query) || fact.scope==="global"&&/世界|背景|设定/u.test(query));
}
