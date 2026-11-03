# 句下品牌字体
来源：@fontsource/noto-serif-sc 5.3.1，SIL OFL 1.1，许可证见 OFL.txt。
源包：https://registry.npmjs.org/@fontsource/noto-serif-sc/-/noto-serif-sc-5.3.1.tgz
工具：临时虚拟环境 fonttools 4.68.0、brotli 1.2.1；不增加项目依赖。
输出：noto-serif-sc-brand-500.woff2，964 bytes；仅 U+53E5、U+4E0B，静态500。
输出 SHA-256：609c6cba5166253d79d92ab8dd753a258b8252d884714d5130f9e07585b7c9ec
复现：下载源包至 %TEMP%/gloss-g75-font/source.tgz，并解压出 package；安装上述工具。在实现副本根目录用虚拟环境 Python 执行下列脚本。

```python
from pathlib import Path
import os,shutil,hashlib
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger
root=Path(os.environ['TEMP'])/'gloss-g75-font'; out=Path.cwd()/'components/brand/fonts'; chars={0x53e5,0x4e0b}; remaining=set(chars);inputs=[];sources=[]
for p in sorted((root/'package/files').glob('*-500-normal.woff2')):
 f=TTFont(p); selected=remaining & set(f.getBestCmap())
 if not selected:continue
 sub=subset.Subsetter(options=subset.Options());sub.populate(unicodes=selected);sub.subset(f);f.flavor=None
 part=root/f'part{len(inputs)}.ttf';f.save(part);inputs.append(str(part));remaining-=selected;sources.append((p.name,hashlib.sha256(p.read_bytes()).hexdigest()))
 if not remaining:break
assert not remaining
f=Merger().merge(inputs);f.flavor='woff2';target=out/'noto-serif-sc-brand-500.woff2';f.save(target)
f=TTFont(target);assert set(f.getBestCmap())==chars;assert f['OS/2'].usWeightClass==500
shutil.copyfile(next((root/'package').glob('*LICENSE*')),out/'OFL.txt')
print(target.stat().st_size,hashlib.sha256(target.read_bytes()).hexdigest(),sources)

```