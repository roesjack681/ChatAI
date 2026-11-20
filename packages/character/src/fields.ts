/** Shared display metadata; safe to import from browser components. */
export const ROLE_FIELD_LABELS: Record<string,string> = {
  name:"姓名",age:"年龄",occupation:"身份",city:"生活城市",personality:"性格",voice:"说话方式",boundaries:"事实与行为边界",
  relationship_status:"感情状态",social_style:"相处方式",gender:"性别",birthday:"生日",hometown:"家乡",school:"学校",major:"专业",academic_year:"年级",education:"教育背景",living_arrangement:"居住情况",family_background:"家庭背景",appearance:"外观与穿着",strengths:"优点",weaknesses:"缺点",hobbies:"兴趣爱好",music_preferences:"音乐偏好",reading_preferences:"阅读偏好",food_preferences:"饮食偏好",leisure_preferences:"休闲偏好",gaming_preferences:"游戏与能力边界",routines:"作息",money_attitude:"消费观",values:"价值观",emotional_style:"情绪与表达",friendship_style:"朋友相处习惯",social_boundaries:"社交边界",speech_habits:"语言习惯",long_term_direction:"长期方向",knowledge_familiar:"熟悉的领域",knowledge_unfamiliar:"不熟悉的领域",
  childhood:"童年环境",personality_origins:"性格形成原因",family_dynamics:"家庭相处方式",romantic_history:"感情经历与观念",important_objects:"有意义的随身物品",comforts:"安慰与恢复方式",pet_peeves:"容易烦的事情",fears:"害怕和不擅长面对的事",conflict_style:"分歧与和好方式",disappointment_style:"受挫时的反应",humor_style:"玩笑与幽默",health_and_habits:"身体与生活习惯",digital_habits:"手机与消息习惯",personal_space:"独处与联系节奏",small_preferences:"日常小偏好",current_concerns:"当前牵挂",life_experiences:"成长经历时间线",relationship_network:"家人朋友关系网",
};

export interface LifeExperience {
  id:string; age_start:number; age_end:number; period:string; title:string; event:string; impact:string; people:string[]; keywords:string[];
}
export interface RoleRelation { from:string; to:string; relation:string; closeness:string; interaction:string; boundary:string }
