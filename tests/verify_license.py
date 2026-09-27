import re
import sys
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/licenses/license-templates/master/templates/mit.txt"

# 项目根目录 = 本文件所在目录的上一级，避免硬编码本机路径
ROOT = Path(__file__).resolve().parent.parent
LICENSE = ROOT / "LICENSE"

if not LICENSE.exists():
    print(f"找不到 LICENSE 文件: {LICENSE}")
    sys.exit(1)

mine = LICENSE.read_text(encoding="utf-8")

try:
    ref = urllib.request.urlopen(URL, timeout=15).read().decode("utf-8")
except Exception as e:
    print("下载官方模板失败:", e)
    raise SystemExit(1)

# 官方模板用 {{ year }} / {{ organization }} 占位符，且不含 "MIT License" 标题行
# 年份与署名从本项目的 LICENSE 中读取，避免脚本与文件脱节
m = re.search(r"Copyright \(c\) (\d{4})\s+(.+)", mine)
if not m:
    print("无法从 LICENSE 中解析版权行")
    sys.exit(1)
year, holder = m.group(1).strip(), m.group(2).strip()

ref_body = ref.replace("{{ year }}", year).replace("{{ organization }}", holder)
mine_body = mine.replace("MIT License", "", 1)

norm = lambda s: re.sub(r"\s+", " ", s).strip()

print("正文（标题与版权行之外）与官方模板一致:", norm(ref_body) == norm(mine_body))
print()
lines = mine.splitlines()
print("首行:", lines[0])
print("版权行:", lines[2])
print("行数:", len(lines))
print("总字符数:", len(mine))
print("末尾换行:", mine.endswith("\n"))
print("使用 UTF-8 且纯 ASCII:", mine.isascii())

# 必需条款关键词
for kw in [
    "Permission is hereby granted, free of charge",
    "without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "The above copyright notice and this permission notice shall be included",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE",
]:
    print(f"  条款存在: {'OK' if kw in norm(mine_body).replace(' ,', ',') or kw in mine else '缺失'}  <- {kw[:45]}...")

if norm(ref_body) != norm(mine_body):
    a, b = norm(ref_body), norm(mine_body)
    print("\n--- 差异片段 ---")
    for i in range(max(len(a), len(b))):
        if i >= len(a) or i >= len(b) or a[i] != b[i]:
            print("首个差异位置:", i)
            print("官方:", repr(a[max(0, i - 70):i + 70]))
            print("本文件:", repr(b[max(0, i - 70):i + 70]))
            break
