# 落地页标题字体
来源：@fontsource/noto-serif-sc，固定版本 5.3.1（npm 官方 registry）。
源包：https://registry.npmjs.org/@fontsource/noto-serif-sc/-/noto-serif-sc-5.3.1.tgz
源包 SHA-256：938988283819a7143a2625673266b6ce9d811deec61576cd3bf9f70d7dd32d70
输出 SHA-256：eb256066db348b7149a4619de065a76c1f004157a24b52e617aa199bf89c3739
大小：2176 bytes。静态 900；SIL OFL 1.1，原许可证见 OFL.txt。
cmap：U+3002 。, U+4E0D 不, U+53E5 句, U+54EA 哪, U+61C2 懂, U+70B9 点, U+FF0C ，。
仅保留这些字符及必要内部字形；没有可变字体表。
工具：fonttools 4.68.0、brotli 1.2.1，临时 Python 虚拟环境，不改变项目依赖。
重建命令（仓库工作副本目录）：`tmp-g73b-font/venv/Scripts/python tmp-g73b-font/subset-title.py`。
重建算法：依文件名排序遍历源包 *-900-normal.woff2；对未收集的标题码点使用 fontTools.subset.Subsetter.populate(unicodes=...)；先保存无 flavor 的 TTF，再用 fontTools.merge.Merger 合并，设置 flavor=woff2 保存；最后断言 cmap 与 weight。
源分片 SHA-256：
- noto-serif-sc-112-900-normal.woff2: 13c374013e0a57de9340c106099f9ed9a0c32766d84da239421e5c72cc3d415d
- noto-serif-sc-113-900-normal.woff2: e23bc4a8c420bde949598746df12562bbcf8ea83f9307d14c5fb0d1952682d4f
- noto-serif-sc-115-900-normal.woff2: 30af11acb53e7e0016f79524d9ce2c51b65bf74e301b4325360e62d3583ad8ec
- noto-serif-sc-118-900-normal.woff2: 9c03713647a18d5e4ebc04a11f67029170833687f3cfb51ab8d68bd13d8d65ec
- noto-serif-sc-119-900-normal.woff2: 078306ba1f3e9ccc6a1f8c1fc3688e672f9cfc50593cdd6cf48023cdb69d03f2

## 可复现裁剪脚本

源包解压到 `tmp-g73b-font/package`，虚拟环境安装上述固定工具版本，将下列脚本保存为 `tmp-g73b-font/subset-title.py`，再执行前述命令。

```python
from pathlib import Path
import hashlib, shutil
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger
root=Path('tmp-g73b-font');out=Path('components/landing/fonts');out.mkdir(parents=True,exist_ok=True)
chars=set(map(ord,'哪句不懂，点。')); remaining=set(chars); inputs=[];sources=[]
for p in sorted((root/'package/files').glob('*-900-normal.woff2')):
 f=TTFont(p); selected=remaining & set(f.getBestCmap())
 if not selected: continue
 opt=subset.Options(); sub=subset.Subsetter(options=opt);sub.populate(unicodes=selected);sub.subset(f);f.flavor=None
 part=root/f'part{len(inputs)}.ttf';f.save(part);inputs.append(str(part));remaining-=selected
 sources.append((p.name,hashlib.sha256(p.read_bytes()).hexdigest()))
 if not remaining:break
assert not remaining,remaining
f=Merger().merge(inputs);f.flavor='woff2';target=out/'noto-serif-sc-title-900.woff2';f.save(target)
f=TTFont(target); assert set(f.getBestCmap())==chars; assert f['OS/2'].usWeightClass==900
license=next((root/'package').glob('*LICENSE*'));shutil.copyfile(license,out/'OFL.txt')
archivehash=hashlib.sha256((root/'source.tgz').read_bytes()).hexdigest();outputhash=hashlib.sha256(target.read_bytes()).hexdigest()
report=f'''# 落地页标题字体
来源：@fontsource/noto-serif-sc，固定版本 5.3.1（npm 官方 registry）。
源包：https://registry.npmjs.org/@fontsource/noto-serif-sc/-/noto-serif-sc-5.3.1.tgz
源包 SHA-256：{archivehash}
输出 SHA-256：{outputhash}
大小：{target.stat().st_size} bytes。静态 900；SIL OFL 1.1，原许可证见 OFL.txt。
cmap：{', '.join(f'U+{cp:04X} {chr(cp)}' for cp in sorted(chars))}。
仅保留这些字符及必要内部字形；没有可变字体表。
工具：fonttools 4.68.0、brotli 1.2.1，临时 Python 虚拟环境，不改变项目依赖。
重建命令（仓库工作副本目录）：`tmp-g73b-font/venv/Scripts/python tmp-g73b-font/subset-title.py`。
重建算法：依文件名排序遍历源包 *-900-normal.woff2；对未收集的标题码点使用 fontTools.subset.Subsetter.populate(unicodes=...)；先保存无 flavor 的 TTF，再用 fontTools.merge.Merger 合并，设置 flavor=woff2 保存；最后断言 cmap 与 weight。
源分片 SHA-256：
'''+ '\n'.join(f'- {n}: {h}' for n,h in sources)
(out/'README.md').write_text(report,encoding='utf-8')
print(report)

```
