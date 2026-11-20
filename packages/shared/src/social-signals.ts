/** Distinguish direct abuse from self-criticism, quoted speech and ordinary venting. */
export function targetedInsult(message:string):boolean {
  const text=message.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/gu,"");
  return text.split(/[，,。！？!?；;\n]/u).some(clause=>{
    if(/(?:他|她).{0,4}(?:跟我|对我)?说|朋友说|室友说|老板说|骂我|说我|你.{0,4}(?:说|骂)我|不是(?:在)?(?:骂你|说你)|你不(?:是|算).{0,2}(?:傻逼|废物|白痴)/u.test(clause))return false;
    return /^(?:你(?:个|就是个|是个)?|真是个|就是个)?\s*(?:傻逼|傻比|傻b|煞笔|白痴|废物|贱货|滚蛋|闭嘴)\s*[啊吧呢呗啦]*$/iu.test(clause.trim())
      || /(?:你|知夏).{0,5}(?:傻逼|傻比|傻b|煞笔|白痴|废物|贱货)/iu.test(clause);
  });
}
