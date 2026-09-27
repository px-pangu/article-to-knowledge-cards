import re
import sys
from pathlib import Path

# 项目根目录 = 本文件所在目录的上一级，避免硬编码本机路径
root = Path(__file__).resolve().parent.parent
skill = root / "skills" / "make-knowledge-cards"

if not (skill / "SKILL.md").exists():
    print(f"找不到 Skill 目录: {skill}")
    print("请在项目根目录下运行，或将本脚本保留在 tests/ 内。")
    sys.exit(1)

c = (skill / "SKILL.md").read_text(encoding="utf-8")
m = re.match(r"^---\n(.*?)\n---", c, re.DOTALL)
fm = m.group(1)

print("=== SKILL.md frontmatter ===")
print(fm.strip())
print()
print("agent_created: true 存在 =", "agent_created: true" in fm)
print("name 与目录名一致 =", f"name: {skill.name}" in fm)

desc = re.search(r"description:\s*(.+)", fm).group(1).strip()
print("description 长度 =", len(desc), "字符")
print("description 含尖括号 =", ("<" in desc or ">" in desc))
print("SKILL.md 总字符数 =", len(c))
print("正文章节 =", re.findall(r"^## .+", c, re.M))
print()

print("=== 目录结构 ===")
for p in sorted(skill.rglob("*")):
    if p.is_file():
        print(f"  {p.relative_to(root)}  ({p.stat().st_size} bytes)")

print()
print("=== 质量红线 / 步骤 完整性 ===")
for token in [
    "第 1 步", "第 2 步", "第 3 步", "第 4 步", "第 5 步", "第 6 步", "第 7 步",
    "质量红线", "覆盖说明", "能力边界", "观点型文章",
]:
    print(f"  {token}: {'OK' if token in c else '缺失'}")

# 校验 openai.yaml
try:
    import yaml
except ImportError:
    print("\n[skip] pyyaml 未安装，跳过 YAML 解析检查")
    sys.exit(0)

print()
print("=== agents/openai.yaml ===")
d = yaml.safe_load((skill / "agents" / "openai.yaml").read_text(encoding="utf-8"))
print("YAML 解析: OK")
print("顶层键 =", list(d.keys()))
print("display_name =", d["interface"]["display_name"])
print("input.required =", d["input"]["required"])
print("constraints 条数 =", len(d["constraints"]))
print("limitations 条数 =", len(d["limitations"]))
