import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_RULES,activePlayer,parsePoint,exportRecord} from '../dist/core/src/index.js';
import {createSession} from '../dist/session/src/index.js';
import {SAVE_KEY,BACKUP_KEY,SafeStorage,parseWebSave,makeWebSave,claimsView,phaseView,rulesView,playerName} from '../dist/ui/model.mjs';
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
const meta={names:['张三','李四'],aIndex:1,round:2};
const make=(rules={})=>value(createSession({matchId:'test',rules:{...DEFAULT_RULES,...rules}}));
function place(s,c){const m=s.state.match,actor=activePlayer(m);value(s.submit(actor,{kind:'place',actor,point:value(parsePoint(c,m.rules.boardSize))}));}
const memory=()=>{const data=new Map();return {data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};};

test('web save restores real player mapping, configuration, actions and candidates',()=>{
 const s=make({swap3:false});for(const c of ['A1','I1','B2','I3','C3','I5','D4','I7','E5'])place(s,c);
 const save=makeWebSave(s,meta,'one'),restored=value(parseWebSave(JSON.stringify(save),'restored'));
 assert.deepEqual(restored.players,meta);assert.deepEqual(restored.session.state.match.state,s.state.match.state);
 assert.equal(playerName(meta,'A'),'李四');assert.equal(claimsView(restored.session.state.match)[0].remaining,4);
 assert.match(phaseView(restored.session.state.match,meta).title,/张三.*白棋/);
 assert.match(rulesView(s.state.match.rules).join(','),/固定五子.*延迟 4 手/);
});
test('session and core record imports work without a web wrapper',()=>{
 const s=make({swap3:false});place(s,'E5');
 assert.equal(value(parseWebSave(s.exportSave(),'s')).session.state.match.state.placements,1);
 assert.equal(value(parseWebSave(exportRecord(s.state.match),'r')).session.state.match.state.placements,1);
});
test('malformed, unknown and tampered imports are rejected; practice saves restore',()=>{
 const s=make();const good=makeWebSave(s,meta,'s');
 const cases=['{',null,{}, {...good,webSchemaVersion:2},{...good,players:{...meta,aIndex:5}}, {...good,extra:1}, {...good,session:{...s.exportSave(),record:{...s.exportSave().record,rulesVersion:'2.0.0'}}}];
 for(const bad of cases)assert.equal(parseWebSave(bad,'x').ok,false);
 const ai={...s.exportSave(),controllers:{A:{kind:'ai',level:'easy',seed:1},B:{kind:'human'}}};
 assert.equal(value(parseWebSave(ai,'x')).mode,'practice');
 const before=JSON.stringify(s.exportSave());assert.equal(parseWebSave({...good,session:{...s.exportSave(),record:{...s.exportSave().record,actions:[{kind:'place',actor:'B',point:0}]}}},'z').ok,false);
 assert.equal(JSON.stringify(s.exportSave()),before);
});
test('live human games cannot be replaced through session newGame or loadSave',()=>{
 const s=make({swap3:false});place(s,'E5');const before=s.state;
 assert.equal(s.newGame('new').error.code,'WRONG_PHASE');assert.equal(s.loadSave('load',s.exportSave()).error.code,'WRONG_PHASE');assert.equal(s.state,before);
});
test('pending consent and permissions never resume from a saved snapshot',()=>{
 const s=make();place(s,'E5');value(s.requestUndo('A'));
 const restored=value(parseWebSave(makeWebSave(s,meta,'s'),'resume')).session;
 assert.equal(restored.state.consent,null);assert.equal(restored.state.paused,false);assert.equal(restored.state.match.state.placements,1);
});
test('safe storage preserves previous save before accepting the next',()=>{
 const mem=memory(),store=new SafeStorage(mem);assert.equal(store.read(),null);assert.equal(store.write('first'),true);assert.equal(store.write('second'),true);
 assert.equal(mem.data.get(SAVE_KEY),'second');assert.equal(mem.data.get(BACKUP_KEY),'first');
});
test('two tabs reject stale writes and preserve both snapshots',()=>{
 const mem=memory(),a=new SafeStorage(mem),b=new SafeStorage(mem);a.read();b.read();a.write('a');
 assert.equal(b.write('b'),false);assert.equal(b.conflict,true);assert.equal(mem.data.get(SAVE_KEY),'a');assert.equal(b.raw,null);
});
test('quota and denied access do not replace the current save',()=>{
 const mem=memory();mem.setItem(SAVE_KEY,'old');const store=new SafeStorage(mem);store.read();
 mem.setItem=()=>{throw Error('quota');};assert.equal(store.write('new'),false);assert.equal(mem.data.get(SAVE_KEY),'old');assert.match(store.warning,/导出/);
 const denied=new SafeStorage({getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
 assert.equal(denied.read(),null);assert.equal(denied.check(),true);assert.equal(denied.write('new'),false);assert.match(denied.warning,/导出/);
});
test('backup failure leaves current data untouched; failed current write retains old bytes',()=>{
 for(const failure of [BACKUP_KEY,SAVE_KEY]){
  const mem=memory();mem.setItem(SAVE_KEY,'old');const store=new SafeStorage(mem);store.read();const set=mem.setItem;mem.setItem=(k,v)=>{if(k===failure)throw Error('fail');set(k,v);};
  assert.equal(store.write('new'),false);assert.equal(mem.data.get(SAVE_KEY),'old');assert.equal(store.raw,'old');
 }
});
test('each color and every fixed-five candidate remains in the presentation',()=>{
 const s=make({swap3:false,confirmationDelay:12});for(const c of ['A1','I2','B2','H3','C3','G4','D4','F5','E5','E6','F6'])place(s,c);
 const cs=claimsView(s.state.match);assert.equal(cs.length,3);assert.equal(cs.filter(c=>c.color==='black').length,2);assert.equal(cs.filter(c=>c.color==='white').length,1);
 assert.deepEqual(cs.filter(c=>c.color==='black').map(c=>c.remaining).sort((a,b)=>a-b),[10,12]);
});
