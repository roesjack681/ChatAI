from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.section import WD_SECTION

out = r'D:\Project\ChatAI\SQL人员异动查询学习总结与自测.docx'
d = Document()
sec = d.sections[0]
sec.top_margin = Inches(.7); sec.bottom_margin = Inches(.7)
sec.left_margin = Inches(.8); sec.right_margin = Inches(.8)
styles=d.styles
styles['Normal'].font.name='Microsoft YaHei'; styles['Normal'].font.size=Pt(10.5)
styles['Normal']._element.rPr.rFonts.set('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia','Microsoft YaHei')
for s in ['Title','Heading 1','Heading 2']:
    styles[s].font.name='Microsoft YaHei'; styles[s]._element.rPr.rFonts.set('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia','Microsoft YaHei')
styles['Title'].font.size=Pt(22); styles['Title'].font.color.rgb=RGBColor(25,59,87)
styles['Heading 1'].font.color.rgb=RGBColor(25,91,120)

def para(text='', style=None): return d.add_paragraph(text, style)
def bullet(text): d.add_paragraph(text, style='List Bullet')
def question(n, text):
    p=d.add_paragraph(); p.paragraph_format.space_after=Pt(4); p.add_run(f'{n}. {text}').bold=True

p=d.add_paragraph(style='Title'); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('SQL 人员异动查询学习总结与自测')
p=d.add_paragraph(); p.alignment=WD_ALIGN_PARAGRAPH.CENTER; p.add_run('零基础入门版 · 建议先读总结，再独立完成问卷').italic=True
para('这份材料用一条人事数据查询示例，带你认识 SQL 如何“选出要看的信息、找到相关资料、按条件筛选，再把多类记录合在一起”。不需要先会写 SQL；先理解每一步在做什么。')

d.add_heading('一 这段 SQL 在做什么', level=1)
para('它想生成一张“人员异动明细表”。每一行大致对应一条已审批的人事业务记录，并展示人员、原单位和新单位、原部门和新部门、岗位、业务日期等信息。查询把三类业务记录合并起来：人员异动单、借调单、借调归还单。')
para('它还会按日期范围筛选记录，可以按员工编号筛选某些人，也会按组织范围过滤。最后按业务日期从新到旧排列。')
para('注意：原文中的部分中文标签、注释显示为乱码。所以下面只解释能从字段名、表名和 SQL 结构确认的内容；乱码标签不作猜测。')

d.add_heading('二 先认识 SQL 的几个积木', level=1)
items=[
('SELECT：选择要展示的列。','例子：SELECT 姓名, 年龄。意思是只看姓名和年龄，不显示其他列。'),
('FROM：说明从哪张表取数据。','例子：FROM 学生。和上句合起来就是“从学生表里查看姓名和年龄”。'),
('WHERE：只留下符合条件的记录。','例子：WHERE 年龄 >= 18。意思是只看年龄大于或等于 18 的学生。'),
('AS / 别名：给列起一个容易认的显示名称。','例子：SELECT 姓名 AS 学生姓名。结果里的这一列会显示为“学生姓名”。'),
('JOIN：按共同信息把两张表接起来。','例子：学生表有“班级编号”，班级表也有“班级编号”；按编号连接后，就能在学生名单旁显示班级名称。'),
('LEFT JOIN：尽量保留左边表里的所有记录。','例子：左边有 3 名学生，右边只有 2 人找到班级资料；连接后仍保留 3 名学生，没找到的班级名称为空。'),
('CASE WHEN：按条件生成一个分类结果。','例子：CASE WHEN 分数 >= 60 THEN \'及格\' ELSE \'需要补考\' END。意思是按分数显示不同结果。'),
('UNION ALL：把列顺序相同的两份名单上下接起来。','例子：把“本班学生名单”和“转入学生名单”追加成一张名单；原有重复行也会保留。'),
('ORDER BY：给结果排序。','例子：ORDER BY 年龄 DESC。意思是年龄从大到小排列；ASC 则是从小到大。'),
('NVL：如果内容为空，就显示备用内容。','例子：NVL(家长电话, \'未填写\')。电话为空时显示“未填写”。')]
for a,b in items:
    p=d.add_paragraph(style='List Bullet'); p.add_run(a+' ').bold=True; p.add_run(b)
para('可以把几句连起来读：SELECT 姓名 FROM 学生 WHERE 年龄 >= 18 ORDER BY 年龄 DESC；就是“从学生表里挑出成年学生的姓名，并按年龄从大到小排”。')

d.add_heading('三 按执行思路读懂查询', level=1)
steps=[
('1. 找业务记录','主查询分别从人员异动、借调、借调归还的业务明细表开始。可以先把每段 SELECT 当成一份独立清单。'),
('2. 检查单据状态','每段都关联对应单据主表，并限制单据状态为 3。字段含义需要查系统字典确认；从写法只能确定它是在筛选特定状态。'),
('3. 补齐人员与组织信息','通过人员编号、组织编号、岗位编号等关联人员、组织、岗位和原因资料。LEFT JOIN 表示主记录尽量保留，即使某张补充资料表暂时没有匹配项。'),
('4. 选列并设置名称','SELECT 列出报表需要的字段；部分字段转成 yyyy-mm-dd 日期文本，或通过 NVL / CASE 生成更易读的结果。'),
('5. 加上筛选条件','业务日期必须落在开始和结束日期之间；员工编号和组织范围可由参数决定。参数为空时，查询会采用另一套分支逻辑。'),
('6. 合并并排序','UNION ALL 将三类业务结果拼在一起；最外层按业务日期降序排列。')]
for h,b in steps:
    p=d.add_paragraph(); p.paragraph_format.space_after=Pt(6); p.add_run(h+'：').bold=True; p.add_run(b)

d.add_heading('四 小白最容易混淆的地方', level=1)
bullet('LEFT JOIN 和 WHERE 不是一回事：JOIN 负责把资料接上，WHERE 负责过滤整行。')
bullet('UNION ALL 是纵向追加记录，不是把新列拼到旁边；每段 SELECT 的列数和顺序要对应。')
bullet('NULL 表示缺失或未知，不等同于空字符串或数字 0。NVL 可以提供替代显示值。')
bullet('参数写法（${...}）和 IF/LEN/replace 看起来属于报表平台的模板语法，不是通用 Oracle SQL 的标准写法；平台会先处理参数，再执行 SQL。')
bullet('CASE 的分类依赖“前后值是否不同”。如果比较字段存在 NULL，或映射资料缺失，分类结果可能需要结合数据库规则和业务口径核实。')

d.add_heading('五 学习问卷', level=1)
para('请先不看答案。每题 1 分；第 9、10 题写出自己的理解即可。总分 10 分。')
question(1,'SELECT 的作用是什么？')
question(2,'这条查询大致要生成什么内容？写出两类展示信息。')
question(3,'JOIN 在这段查询中主要解决什么问题？')
question(4,'WHERE 日期条件的作用是什么？')
question(5,'LEFT JOIN 与普通“只保留匹配项”的关联相比，有什么直观区别？')
question(6,'UNION ALL 在这里把什么合在一起？')
question(7,'ORDER BY bizDate DESC 表示什么排序？')
question(8,'NVL(原因字段, 默认值) 在原因为空时会怎样？')
question(9,'如果只想查看某位员工，可能会用哪个字段作为筛选条件？')
question(10,'用自己的话写出这条 SQL 的处理顺序，至少写出“取数据、补资料、筛选、合并”中的三步。')

d.add_heading('六 参考答案与自我检查', level=1)
answers=[
'选择要输出的列。',
'人员异动明细；可写人员姓名、原/新部门、岗位、业务日期等。',
'用共同编号把业务记录与人员、组织、岗位等资料连接起来。',
'只留下开始日期到结束日期范围内的业务记录。',
'LEFT JOIN 尽量保留左侧主记录，即使右侧资料找不到；只保留匹配项的关联会丢掉未匹配记录。',
'把人员异动、借调、借调归还三类结构相同的结果纵向追加。',
'按业务日期从新到旧排列。',
'显示预设的默认值。',
'员工编号 psncode（底层字段为人员编号 FNUMBER）。',
'示例：从三类业务表取记录，关联人员和组织等资料，按日期/员工/组织筛选，UNION ALL 合并，最后按日期倒序。']
for i,a in enumerate(answers,1):
    p=d.add_paragraph(); p.paragraph_format.space_after=Pt(4); p.add_run(f'{i}. ').bold=True; p.add_run(a)
para('得分建议：9–10 分：已经抓住主线；7–8 分：重点复习 JOIN、UNION ALL 和筛选条件；0–6 分：再读第三部分，然后遮住答案重做一次。第 10 题表达不同也可以得分，只要顺序和含义正确。')

d.add_heading('七 一句话记忆', level=1)
para('SELECT 选列，FROM 找起点，JOIN 补资料，WHERE 做筛选，UNION ALL 接清单，ORDER BY 排顺序。')
d.save(out)
print(out)
