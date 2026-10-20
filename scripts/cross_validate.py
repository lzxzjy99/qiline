"""Compare the real TypeScript core with the separately audited Python model.

No snapshots are injected into the production core; all games begin empty.
"""
from pathlib import Path
from itertools import product
from collections import Counter
import hashlib,json,random,subprocess,sys,time,traceback

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'tests/reference'))
from model import Config,Match,SIZES,DELAYS,MODES,COLORS

def rules(cfg):
    return {'rulesVersion':'2.1.0-r3','boardSize':cfg.size,'confirmationDelay':cfg.delay,'swap3':cfg.swap,
            'superko':'positional' if cfg.ko else 'off','directions':'four' if cfg.four else 'diagonal','claimMode':cfg.claim_mode}

def action(a):
    z=dict(a)
    if z['kind']=='choose':z['kind']='choose-color';z['color']='black' if z['color']==1 else 'white'
    if 'approved_by' in z:z['approvedBy']=z.pop('approved_by')
    return z

def expected(m):
    claims=[{'color':c,'points':list(w),'formedAt':t,'dueAt':t+m.config.delay} for (c,w),t in sorted(m.claims.items())]
    key=lambda b:''.join('2' if c==-1 else str(c) for c in b)
    return {'board':list(m.board),'phase':m.phase,'opened':m.opened,'toMove':m.to_move if m.phase=='playing' else None,
      'owners':None if m.owners is None else {'black':m.owners[1],'white':m.owners[-1]},'ply':m.ply,'placements':m.placements,
      'captures':{'black':m.captures[1],'white':m.captures[-1]},'claims':claims,'passStreak':m.pass_streak,
      'outcome':list(m.outcome) if m.outcome else None,'positionCount':len(m.positions),
      'historyHash':hashlib.sha256(''.join(key(b) for b in m.positions).encode()).hexdigest(),'commandCount':len(m.log)}

def main():
    start=time.perf_counter();stats=Counter();failed=None;cfg=None;m=None;last_request=None
    worker=subprocess.Popen(['node',str(ROOT/'scripts/cross-server.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,cwd=ROOT)
    def rpc(req):
        nonlocal last_request
        last_request=req;worker.stdin.write(json.dumps(req,separators=(',',':'))+'\n');worker.stdin.flush()
        line=worker.stdout.readline()
        if not line:raise RuntimeError('TypeScript test adapter closed: '+worker.stderr.read())
        r=json.loads(line)
        if 'fatal' in r:raise RuntimeError(r['fatal'])
        return r
    def compare(r,model):
        want=expected(model)
        if r.get('state')!=want:
            diff={k:{'typescript':r.get('state',{}).get(k),'python':v} for k,v in want.items() if r.get('state',{}).get(k)!=v}
            raise AssertionError(json.dumps(diff,ensure_ascii=False))
        stats['state_comparisons']+=1
    try:
        for index,(n,delay,swap,four,ko,mode) in enumerate(product(SIZES,DELAYS,(False,True),(False,True),(False,True),MODES),1):
            cfg=Config(n,delay,swap,four,ko,mode)
            for seed in range(2):
                rng=random.Random(0xC0DE+100003*n+1009*delay+101*swap+37*four+11*ko+seed)
                m=Match(cfg);compare(rpc({'op':'new','rules':rules(cfg)}),m)
                while m.outcome is None and len(m.log)<120:
                    if m.phase=='choose':
                        a={'kind':'choose','actor':'B','color':rng.choice(COLORS)}
                    else:
                        actor='A' if m.phase=='opening' else m.owners[m.to_move]
                        if m.phase=='playing' and rng.random()<0.07:a={'kind':'pass','actor':actor}
                        else:
                            empty=[p for p,v in enumerate(m.board) if not v];rng.shuffle(empty)
                            color=(1,-1,1)[m.opened] if m.phase=='opening' else m.to_move
                            p=next((p for p in empty if m.can_place(p,color,m.phase=='opening')),None)
                            assert p is not None or m.phase=='playing'
                            a={'kind':'pass','actor':actor} if p is None else {'kind':'place','actor':actor,'point':p}
                    before=m;m=m.apply(a);r=rpc({'op':'action','action':action(a)})
                    assert r['ok'],r;compare(r,m);stats['accepted_commands']+=1
                    # Invalid occupied points and actors must preserve both models.
                    if m.phase=='playing' and len(m.log) in (9,47):
                        occupied=next((p for p,v in enumerate(m.board) if v),None)
                        if occupied is not None:
                            bad={'kind':'place','actor':m.owners[m.to_move],'point':occupied}
                            try:m.apply(bad)
                            except ValueError as e:assert str(e)=='OCCUPIED'
                            else:raise AssertionError('reference accepted occupied point')
                            z=rpc({'op':'action','action':bad});assert not z['ok'] and z['error']['code']=='OCCUPIED';compare(z,m)
                            stats['illegal_atomicity_checks']+=1
                    if m.phase=='playing' and seed==0 and len(m.log) in (10,43):
                        z=rpc({'op':'legal'});assert z['points']==m.legal_points();stats['legal_set_checks']+=1
                    if len(m.log) in (7,43) and not m.outcome:
                        z=rpc({'op':'undo'});assert z['ok'];compare(z,before);stats['undo_checks']+=1
                        z=rpc({'op':'action','action':action(a)});assert z['ok'];compare(z,m);stats['branch_redo_checks']+=1
                    if len(m.log)==31:
                        z=rpc({'op':'replay'});assert z['ok'];compare(z,m);stats['replay_checks']+=1
                z=rpc({'op':'replay'});assert z['ok'];compare(z,m);stats['replay_checks']+=1
                stats['games']+=1;stats['terminated' if m.outcome else 'truncated_at_120_commands']+=1
            stats['configurations']+=1
            if index%56==0:print('Cross-language configurations completed:',index,'of 448',flush=True)
    except Exception as e:
        failed={'error':str(e),'traceback':traceback.format_exc(),'rules':None if cfg is None else rules(cfg),
                'actions':[] if m is None else [action(a) for a in m.log],'request':last_request}
    finally:
        worker.stdin.close()
        try:worker.wait(timeout=10)
        except subprocess.TimeoutExpired:worker.terminate();worker.wait(timeout=5)
    result={'rulesVersion':'2.1.0-r3','reference_sha256':hashlib.sha256((ROOT/'tests/reference/model.py').read_bytes()).hexdigest(),
        'statistics':dict(stats),'failure':failed,'elapsed_seconds':round(time.perf_counter()-start,3),
        'scope':'Independent Python and TypeScript engines; all matches start empty; truncated games are not draws.'}
    (ROOT/'reports').mkdir(exist_ok=True)
    (ROOT/'reports/cross-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='failure'},ensure_ascii=False),flush=True)
    if failed:
        print(failed['error'],flush=True);raise SystemExit(1)

if __name__=='__main__':main()
