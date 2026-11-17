"""Rebuild bundled CC0 motion data from a downloaded Hormelz MeleeCharacter folder.

Usage: python scripts/import-motion-templates.py /path/to/MeleeCharacter
Pillow is a development-only dependency. Runtime uses only node:zlib.
"""
from pathlib import Path
import gzip
import json
import sys
from PIL import Image

source=Path(sys.argv[1]).resolve()
target=Path(__file__).resolve().parents[1]/'assets'/'motion-templates'
target.mkdir(parents=True,exist_ok=True)
names={
 'Battlecry':'战吼','Combo':'组合连击','Die1':'死亡1','Die2':'死亡2','ElbowPunching':'肘击',
 'FightIdle':'战斗待机','Fireball':'火球施法','FlyingKick':'飞踢','ForwardRoll':'前滚翻',
 'FrontKick':'正踢1','FrontKick2':'正踢2','HighKick':'高踢','HitBody':'身体受击','HitHead':'头部受击',
 'HitHeadLight':'头部轻受击','Idle1':'普通待机','Jump1':'跳跃1','Jump2':'跳跃2',
 'left strafe':'左快速侧移','left strafe walking':'左侧移','LeftHook':'左勾拳','LeftJab':'左刺拳',
 'Pull':'拉','Push':'推','right strafe':'右快速侧移','right strafe walking':'右侧移',
 'RightHook':'右勾拳','RightJab':'右刺拳','Run1':'奔跑1','Run2':'奔跑2','RunBack':'后退奔跑',
 'RunForward':'向前奔跑','RunningJump':'跑跳','RunningSlide':'跑动滑铲','SideKick':'侧踢',
 'StandRoll':'原地翻滚','StompKick':'踩踏','StraightRight':'右直拳','WalkBack':'后退行走','WalkFoward':'向前行走'}
catalog=[]
for folder in sorted(source.iterdir()):
    if not folder.is_dir() or folder.name not in names:continue
    gif=Image.open(sorted(folder.glob('*.gif'))[0])
    timings=[]
    for i in range(gif.n_frames):gif.seek(i);timings.append(gif.info['duration'])
    frames=gif.n_frames
    payload=[]
    for d in [4,5,6,7,8,1,2,3]:
        sheet=Image.open(next(folder.glob(f'*_dir{d}.png'))).convert('RGBA')
        cols=sheet.width//126
        for i in range(frames):
            x,y=i%cols*126,i//cols*132
            payload.append(sheet.crop((x,y,x+126,y+132)).tobytes())
    key=folder.name.lower().replace(' ','-')
    data=gzip.compress(b''.join(payload),compresslevel=9,mtime=0)
    (target/f'{key}.rgba.gz').write_bytes(data)
    catalog.append({'key':key,'name':names[folder.name],'originalName':folder.name,'frames':frames,'durationMs':sum(timings),'frameDurationsMs':timings})
(target/'catalog.json').write_text(json.dumps({'source':'Hormelz','url':'https://hormelz.itch.io/8-directional-melee-character','license':'CC0-1.0','width':126,'height':132,'directions':['back','upRight','right','downRight','front','downLeft','left','upLeft'],'actions':catalog},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'actions':len(catalog),'compressedBytes':sum(p.stat().st_size for p in target.glob('*.gz'))}))
