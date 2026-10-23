import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSession} from '../dist/session/src/index.js';
import {DEFAULT_RULES} from '../dist/core/src/index.js';
import {SAVE_KEY,BACKUP_KEY,makeWebSave} from '../dist/ui/model.mjs';
import {FakeWorker,VirtualHost} from './worker-fakes.mjs';

// Execute the shipped entry module and its actual scheduler/model imports. Only browser
// surfaces are substituted; these checks complement actual-browser layout/Worker QA.
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const appURL=new URL('../dist/app.mjs',import.meta.url);
const app=(await readFile(appURL,'utf8')).replace(/from\s+(['"])(\.[^'"]+)\1/g,
  (_all,quote,specifier)=>`from ${quote}${new URL(specifier,appURL).href}${quote}`);
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
let instance=0;

class Surface {
  constructor(document,id=''){
    this.document=document;this.id=id;this.dataset={};this.listeners=new Map();this.attributes=new Map();
    this.hidden=false;this.disabled=false;this.open=false;this.value='';this.checked=false;this.children=[];
    this.style={setProperty(){}};this.classList={toggle(){}};this._html='';this._text='';this.cells=[];this.htmlWrites=0;
  }
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text;}
  set innerHTML(value){
    this._html=String(value);this.cells=[];this.htmlWrites++;
    for(const m of this._html.matchAll(/\bid="([^"]+)"/g))this.document.add(m[1]);
    if(this.id==='board')for(const m of this._html.matchAll(/<button\b([^>]*\bdata-point="(\d+)"[^>]*)>/g)){
      const cell=new Surface(this.document);cell.dataset.point=m[2];cell.parent=this;
      cell.disabled=/\bdisabled\b/.test(m[1]);this.cells.push(cell);
    }
  }
  get innerHTML(){return this._html;}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
  dispatch(name,detail={}){
    const event={target:this,currentTarget:this,preventDefault(){},...detail};
    this[`on${name}`]?.(event);for(const fn of this.listeners.get(name)??[])fn(event);
    if(this.parent)this.parent.dispatch(name,{...event,currentTarget:this.parent});
    return event;
  }
  click(){if(!this.disabled)this.dispatch('click');}
  showModal(){assert.equal(this.open,false,'dialog already open');this.open=true;}
  close(){if(this.open){this.open=false;this.dispatch('close');}}
  focus(){this.document.activeElement=this;}
  closest(selector){
    if(selector==='#board')return this.id==='board'?this:this.parent?.closest(selector)??null;
    const m=selector.match(/^\[data-(\w+)\]$/);if(m&&this.dataset[m[1]]!==undefined)return this;
    return this.parent?.closest(selector)??null;
  }
  querySelectorAll(selector){return selector==='[data-point]'?this.cells:[];}
  querySelector(selector){const m=selector.match(/^\[data-point="(\d+)"\]$/);return m?this.cells.find(c=>c.dataset.point===m[1])??null:null;}
  append(child){this.children.push(child);}
  remove(){}
}
class RadioList extends Array {
  get value(){return this.find(r=>r.checked)?.value??'';}
  set value(value){for(const r of this)r.checked=r.value===String(value);}
}
function documentSurface(){
  const document={nodes:new Map(),activeElement:null,add(id){
    if(!this.nodes.has(id))this.nodes.set(id,new Surface(this,id));return this.nodes.get(id);
  },getElementById(id){assert.ok(this.nodes.has(id),`unknown UI element ${id}`);return this.nodes.get(id);},
  createElement(){return new Surface(this);},querySelectorAll(){return [];}};
  for(const m of html.matchAll(/\bid="([^"]+)"/g))document.add(m[1]);
  document.body=new Surface(document,'body');
  const form=document.getElementById('settings-form');form.elements={};
  const body=html.match(/<form id="settings-form">([\s\S]*?)<\/form>/)[1];
  for(const m of body.matchAll(/<input\b([^>]*\bname="([^"]+)"[^>]*)>/g)){
    const control=new Surface(document);control.name=m[2];control.parent=form;
    control.value=m[1].match(/\bvalue="([^"]*)"/)?.[1]??'';
    control.checked=/\bchecked\b/.test(m[1]);control.required=/\brequired\b/.test(m[1]);
    if(/\btype="radio"/.test(m[1]))(form.elements[control.name]??=new RadioList()).push(control);
    else form.elements[control.name]=control;
  }
  for(const m of body.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
    const control=new Surface(document);control.name=m[1];control.parent=form;
    const options=[...m[2].matchAll(/<option\b([^>]*)>/g)];
    const selected=options.find(o=>/\bselected\b/.test(o[1]))??options[0];
    control.value=selected[1].match(/\bvalue="([^"]*)"/)[1];form.elements[control.name]=control;
  }
  return document;
}
async function harness(startup=null){
  const clock=new VirtualHost(),document=documentSurface(),data=new Map(),writes=[];
  if(startup!==null)data.set(SAVE_KEY,typeof startup==='string'?startup:JSON.stringify(startup));
  const listeners=new Map(),workers=[];let reloads=0,sequence=0;
  const localStorage={getItem:key=>data.get(key)??null,setItem(key,raw){writes.push({key,raw});data.set(key,raw);}};
  const window={localStorage,location:{reload(){reloads++;}},addEventListener(name,fn){
    if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);
  }};
  const dispatch=(name,event={})=>{for(const fn of listeners.get(name)??[])fn(event);};
  const replacements={document,window,performance:{now:()=>clock.time},
    setTimeout:clock.host.setTimer,clearTimeout:clock.host.clearTimer,
    crypto:{randomUUID:()=>`app-test-${instance}-${++sequence}`,getRandomValues(array){array.fill(17);return array;}},
    Worker:class extends FakeWorker {constructor(url,options){super();this.url=url;this.options=options;workers.push(this);}},
  };
  const originals=new Map();for(const [name,replacement]of Object.entries(replacements)){
    originals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{value:replacement,writable:true,configurable:true});
  }
  const restore=()=>{for(const [name,descriptor]of originals)descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name];};
  try{await import(`data:text/javascript;base64,${Buffer.from(`${app}\n// app fixture ${++instance}`).toString('base64')}`);}
  catch(error){restore();throw error;}
  const $=id=>document.getElementById(id),form=$('settings-form');
  const change=(name,next)=>{
    const controls=form.elements[name];
    if(controls instanceof RadioList){controls.value=next;controls.find(r=>r.checked).dispatch('change');}
    else{if(typeof next==='boolean')controls.checked=next;else controls.value=String(next);controls.dispatch('change');}
  };
  const start=(options={})=>{
    $('settings-open').click();
    for(const [name,next]of Object.entries({mode:'practice',humanActor:'B',level:'easy',...options}))change(name,next);
    form.dispatch('submit');
  };
  const point=(n,keyboard=false)=>{
    const cell=$('board').querySelector(`[data-point="${n}"]`);assert.ok(cell);
    keyboard?cell.dispatch('keydown',{key:'Enter'}):cell.click();
  };
  const current=()=>JSON.parse(data.get(SAVE_KEY));
  const commits=()=>writes.filter(w=>w.key===SAVE_KEY).length;
  return {$,form,change,start,point,current,commits,workers,clock,data,writes,dispatch,
    reloads:()=>reloads,async import(raw){const file=$('import-file');file.files=[{size:JSON.stringify(raw).length,text:async()=>JSON.stringify(raw)}];await file.onchange({target:file});},
    close(){try{dispatch('pagehide');}finally{restore();}}};
}
function savedPractice(aiActor='A',rules={}){
  const session=value(createSession({matchId:'before-refresh',rules:{...DEFAULT_RULES,...rules},
    controllers:{[aiActor]:{kind:'ai',level:'easy',seed:31},[aiActor==='A'?'B':'A']:{kind:'human'}}}));
  return makeWebSave(session,{names:['林','弈合 AI'],aIndex:aiActor==='A'?1:0,round:3},'before-refresh');
}
const answer=(worker,action)=>{worker.ready();worker.emit(worker.result(action));};

test('thinking time updates live without board renders or saves, excludes preparation and retains the completed move',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false,level:'hard'});h.point(40);h.clock.tick();
    const worker=h.workers.at(-1);h.clock.tick(500);
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.0 秒');
    worker.ready();const writes=h.commits(),renders=h.$('board').htmlWrites;
    h.clock.tick(61100);
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 1 分 1.1 秒');
    assert.match(h.$('mobile-ai-elapsed').textContent,/1 分 1.1 秒/);
    assert.equal(h.commits(),writes);assert.equal(h.$('board').htmlWrites,renders);
    worker.emit(worker.result({kind:'place',actor:'B',point:0}));
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 1 分 1.1 秒');
    h.clock.tick(5000);assert.equal(h.$('ai-elapsed').textContent,'上一手用时 1 分 1.1 秒');
    assert.equal(h.workers.length,1);
  }finally{h.close();}
});

test('thinking time freezes during pause and resumes cumulative actual work on the same move',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    h.workers.at(-1).ready();h.clock.tick(650);h.$('ai-pause').click();
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.6 秒');
    h.clock.tick(5000);assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.6 秒');
    h.$('ai-resume').click();h.clock.tick();const worker=h.workers.at(-1);
    h.clock.tick(300);assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.6 秒');
    worker.ready();h.clock.tick(450);worker.emit(worker.result({kind:'place',actor:'B',point:0}));
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 1.1 秒');
  }finally{h.close();}
});

test('thinking time sums automatic attempts but excludes retry and worker startup waits',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    const old=h.workers.at(-1);old.ready();h.clock.tick(100);
    const obsolete=old.onmessage,reply=old.result({kind:'place',actor:'B',point:0});old.onerror({});
    h.clock.tick(250);const worker=h.workers.at(-1);h.clock.tick(400);
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.1 秒');
    worker.ready();h.clock.tick(200);worker.emit(worker.result({kind:'place',actor:'B',point:0}));
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 0.3 秒');
    obsolete({data:reply});assert.equal(h.$('ai-elapsed').textContent,'上一手用时 0.3 秒');
  }finally{h.close();}
});

test('rewinding a completed move clears its time and the next AI move starts fresh',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    const first=h.workers.at(-1);first.ready();h.clock.tick(200);first.emit(first.result({kind:'place',actor:'B',point:0}));
    h.$('undo-btn').click();assert.equal(h.$('ai-elapsed').hidden,true);
    h.point(40);h.clock.tick();const worker=h.workers.at(-1);worker.ready();
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.0 秒');
    h.clock.tick(100);worker.emit(worker.result({kind:'place',actor:'B',point:0}));
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 0.1 秒');
  }finally{h.close();}
});

test('restored saves start new timing only after continue and do not add timing fields to saves',async()=>{
  let saved;
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    h.workers.at(-1).ready();h.clock.tick(200);h.$('ai-pause').click();saved=h.current();
    assert.equal(JSON.stringify(saved).includes('elapsedMs'),false);
  }finally{h.close();}
  const restored=await harness(saved);try{
    restored.clock.tick(10000);assert.equal(restored.$('ai-elapsed').hidden,true);
    restored.$('ai-resume').click();restored.clock.tick();const worker=restored.workers.at(-1);worker.ready();
    assert.equal(restored.$('ai-elapsed').textContent,'本手已思考 0.0 秒');
    restored.clock.tick(100);worker.emit(worker.result({kind:'place',actor:'B',point:0}));
    assert.equal(restored.$('ai-elapsed').textContent,'上一手用时 0.1 秒');
  }finally{restored.close();}
});

test('consecutive AI opening commands get separate times and ended games retain the last completed time',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const first=h.workers.at(-1);first.ready();h.clock.tick(200);
    first.emit(first.result({kind:'place',actor:'A',point:40}));
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 0.2 秒');
    h.clock.tick();const second=h.workers.at(-1);second.ready();
    assert.equal(h.$('ai-elapsed').textContent,'本手已思考 0.0 秒');
    h.clock.tick(100);second.emit(second.result({kind:'place',actor:'A',point:42}));
    h.clock.tick();answer(h.workers.at(-1),{kind:'place',actor:'A',point:44});
    h.$('choose-white').click();h.$('end-btn').click();h.$('practice-end').click();
    assert.equal(h.$('ai-panel').hidden,false);assert.equal(h.$('ai-controls').hidden,true);
    assert.equal(h.$('ai-status').textContent,'本局已结束');
    assert.equal(h.$('ai-elapsed').textContent,'上一手用时 0.0 秒');
  }finally{h.close();}
});

test('hard selection uses its long budget and restores paused with difficulty and identity intact',async()=>{
  let saved;
  const h=await harness();try{
    h.start({humanActor:'A',level:'hard',swap3:false});
    assert.deepEqual([...h.form.elements.level].map(r=>r.value),['easy','standard','hard']);
    assert.match(h.$('mode-label').textContent,/困难/);
    h.point(40);h.clock.tick();const worker=h.workers.at(-1);worker.ready();
    assert.equal(worker.sent[0].level,'hard');assert.equal(worker.sent[0].budget.timeMs,120000);
    h.clock.tick(3000);assert.match(h.$('ai-status').textContent,/思考/);
    h.$('ai-pause').click();assert.equal(worker.terminated,1);
    saved=h.current();assert.equal(saved.session.controllers.B.level,'hard');
  }finally{h.close();}
  const restored=await harness(saved);try{
    restored.clock.tick(30000);assert.equal(restored.workers.length,0);
    assert.match(restored.$('mode-label').textContent,/困难/);
    assert.equal(restored.$('ai-resume').hidden,false);
    restored.$('ai-resume').click();restored.clock.tick();const worker=restored.workers.at(-1);
    answer(worker,{kind:'place',actor:'B',point:0});
    assert.equal(worker.sent[0].level,'hard');assert.equal(restored.current().session.record.actions.length,2);
    assert.equal(restored.current().session.controllers.B.level,'hard');
    restored.$('undo-btn').click();assert.equal(restored.current().session.record.actions.length,0);
  }finally{restored.close();}
});

test('product settings react to radio changes and practice assigns the selected identity/difficulty',async()=>{
  const h=await harness();try{
    h.$('first-start').click();h.change('mode','practice');
    assert.equal(h.$('practice-settings').hidden,false);
    assert.equal(h.$('player2-label').hidden,true);
    assert.equal(h.form.elements.competitive.disabled,true);
    h.change('humanActor','A');h.change('level','standard');h.form.elements.player1.value='林';h.form.dispatch('submit');
    assert.equal(h.current().session.controllers.A.kind,'human');
    assert.deepEqual(h.current().session.controllers.B,{kind:'ai',level:'standard',seed:17});
    assert.match(h.$('play-context').textContent,/你是 A/);assert.match(h.$('players').innerHTML,/林/);
    assert.equal(h.$('ai-panel').hidden,false);assert.equal(h.$('pass-btn').disabled,true);
    h.clock.tick();assert.equal(h.workers.length,0,'human opening must not start a worker');
  }finally{h.close();}
});

test('AI A places three opening stones with fresh workers, saves each once and cannot be impersonated',async()=>{
  const h=await harness();try{
    h.start({humanActor:'B'});assert.equal(h.commits(),1);h.clock.tick();
    for(const [i,point]of [40,42,44].entries()){
      const w=h.workers.at(-1);assert.equal(w.options.type,'module');assert.match(w.url.pathname,/ai\/src\/worker-entry\.js$/);
      assert.equal(h.$('board').cells.every(c=>c.disabled),true);h.point(0,true);
      assert.equal(h.current().session.record.actions.length,i,'keyboard cannot act for AI');
      const before=h.commits();w.ready();assert.equal(h.commits(),before,'ready/task state is not a new save');
      w.emit(w.result({kind:'place',actor:'A',point}));
      assert.equal(w.terminated,1);assert.equal(h.commits(),before+1);assert.equal(h.current().session.record.actions.length,i+1);
      if(i<2){assert.equal(h.workers.length,i+1);h.clock.tick();}
    }
    assert.equal(h.workers.length,3);assert.equal(h.$('choice-actions').hidden,false);
    const previous=h.data.get(SAVE_KEY),before=h.commits();h.$('choose-white').click();
    assert.equal(h.commits(),before+1,'one human command produces one save');
    assert.equal(h.data.get(BACKUP_KEY),previous,'backup retains the preceding command');
    assert.equal(h.current().session.controllers.A.kind,'ai');assert.equal(h.current().session.controllers.B.kind,'human');
    assert.equal(h.$('pass-btn').disabled,false);h.point(0);assert.equal(h.current().session.record.actions.at(-1).actor,'B');
  }finally{h.close();}
});

test('AI B choosing white continues with B; pair undo removes the choice and preceding opening stone',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A'});for(const point of [40,42,44])h.point(point);h.clock.tick();
    const choice=h.workers.at(-1);answer(choice,{kind:'choose-color',actor:'B',color:'white'});
    assert.equal(h.$('choice-actions').hidden,true);assert.equal(h.$('pass-btn').disabled,true);h.clock.tick();
    const move=h.workers.at(-1);assert.notEqual(move,choice);move.ready();
    assert.equal(move.sent[0].context.actor,'B');const before=h.commits();h.$('undo-btn').click();
    assert.equal(move.terminated,1);assert.equal(h.current().session.record.actions.length,2);
    assert.equal(h.$('ai-resume').hidden,true);assert.equal(h.$('board').cells.some(c=>!c.disabled),true);
    assert.equal(h.commits(),before+1);h.clock.tick(1000);assert.equal(h.workers.length,2);
    h.point(44);h.clock.tick();assert.equal(h.workers.length,3);
    answer(h.workers.at(-1),{kind:'choose-color',actor:'B',color:'white'});
    h.clock.tick();answer(h.workers.at(-1),{kind:'place',actor:'B',point:0});
    assert.equal(h.$('pass-btn').disabled,false);assert.equal(h.current().session.record.actions.at(-1).actor,'B');
  }finally{h.close();}
});

test('pause stops AI while bounded automatic recovery retries twice before a visible final failure',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const first=h.workers.at(-1);first.ready();const raw=h.data.get(SAVE_KEY),count=h.commits();
    h.$('ai-pause').click();assert.equal(first.terminated,1);assert.equal(h.commits(),count);
    assert.equal(h.$('ai-resume').hidden,false);assert.equal(h.$('board').cells.every(c=>c.disabled),true);
    h.$('ai-resume').click();h.clock.tick();const second=h.workers.at(-1);assert.notEqual(first,second);
    second.ready();const precedingNotice=h.$('notice').textContent;second.onerror({});
    assert.equal(second.terminated,1);assert.equal(h.$('ai-retry').hidden,true);
    assert.match(h.$('ai-status').textContent,/思考|重试|尝试/);assert.equal(h.$('notice').textContent,precedingNotice);
    assert.equal(h.data.get(SAVE_KEY),raw);h.clock.tick(249);assert.equal(h.workers.length,2);
    h.clock.tick(1);const third=h.workers.at(-1);assert.equal(h.workers.length,3);
    third.ready();assert.notEqual(third.sent[0].context.requestId,second.sent[0].context.requestId);third.onerror({});
    h.clock.tick(749);assert.equal(h.workers.length,3);h.clock.tick(1);const fourth=h.workers.at(-1);
    fourth.ready();fourth.onerror({});assert.equal(h.$('ai-retry').hidden,false);
    assert.equal(h.$('notice').hidden,false);assert.match(h.$('notice').textContent,/重试|失败|未能|中断/);
    assert.match(h.$('ai-detail').textContent,/重试/);h.clock.tick(10000);
    assert.equal(h.workers.length,4,'three attempts exhaust one recovery cycle');assert.equal(h.data.get(SAVE_KEY),raw);
    h.$('ai-retry').click();h.clock.tick();const fifth=h.workers.at(-1);answer(fifth,{kind:'place',actor:'A',point:40});
    assert.equal(h.current().session.record.actions.length,1);assert.equal(h.$('ai-retry').hidden,true);
  }finally{h.close();}
});

test('thinking status updates preserve the board DOM and a successful move resets recovery allowance',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();const first=h.workers.at(-1);
    const boardWrites=h.$('board').htmlWrites;first.ready();
    assert.equal(h.$('board').htmlWrites,boardWrites,'ready must not reconstruct the board before sending the request');
    assert.match(h.$('ai-status').textContent,/思考/);first.onerror({});h.clock.tick(250);
    answer(h.workers.at(-1),{kind:'place',actor:'B',point:0});h.point(42);h.clock.tick();
    const nextPosition=h.workers.at(-1);nextPosition.ready();nextPosition.onerror({});
    assert.match(h.$('ai-status').textContent,/思考|重试|尝试/);assert.equal(h.$('ai-retry').hidden,true);
    h.clock.tick(249);assert.equal(h.workers.length,3);h.clock.tick(1);assert.equal(h.workers.length,4);
  }finally{h.close();}
});

test('one practice undo removes a complete human/AI pair and restores the human turn',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    answer(h.workers.at(-1),{kind:'place',actor:'B',point:0});
    assert.equal(h.current().session.record.actions.length,2);assert.match(h.$('undo-btn').textContent,/两手/);
    const writes=h.commits();h.$('undo-btn').click();assert.equal(h.current().session.record.actions.length,0);
    assert.equal(h.commits(),writes+1);assert.equal(h.$('board').cells.some(c=>!c.disabled),true);
    assert.equal(h.$('ai-resume').hidden,true);h.clock.tick(10000);assert.equal(h.workers.length,1);
  }finally{h.close();}
});

test('undoing two AI opening stones stops the next worker and holds until explicit continue',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();answer(h.workers.at(-1),{kind:'place',actor:'A',point:40});h.clock.tick();
    answer(h.workers.at(-1),{kind:'place',actor:'A',point:42});h.clock.tick();const third=h.workers.at(-1);third.ready();
    h.$('undo-btn').click();assert.equal(third.terminated,1);assert.equal(h.current().session.record.actions.length,0);
    assert.match(h.$('ai-status').textContent,/悔棋.*继续/);assert.equal(h.$('ai-resume').hidden,false);
    assert.equal(h.$('undo-btn').disabled,true);h.clock.tick(10000);assert.equal(h.workers.length,3);
    h.$('ai-resume').click();h.clock.tick();assert.equal(h.workers.length,4);
  }finally{h.close();}
});

test('pending automatic recovery is cancelled by pause, replacement, load, conflict, undo and page close',async()=>{
  for(const action of ['pause','replace','load','conflict','undo','close']){
    const h=await harness();try{
      h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();const worker=h.workers.at(-1);
      worker.ready();const callback=worker.onmessage,reply=worker.result({kind:'place',actor:'B',point:0});worker.onerror({});
      assert.match(h.$('ai-status').textContent,/思考|重试|尝试/);
      if(action==='pause')h.$('ai-pause').click();
      if(action==='replace'){h.start({humanActor:'A',swap3:false});h.$('replace-confirm').click();}
      if(action==='load'){await h.import(savedPractice('B',{swap3:false}));h.$('replace-confirm').click();}
      if(action==='conflict'){h.data.set(SAVE_KEY,'latest-tab');h.dispatch('storage',{key:SAVE_KEY,newValue:'latest-tab'});}
      if(action==='undo'){
        assert.equal(h.$('undo-btn').disabled,false,'undo is available while automatic recovery waits');
        h.$('undo-btn').click();assert.equal(h.current().session.record.actions.length,0);
        assert.equal(h.$('board').cells.some(c=>!c.disabled),true);
      }
      if(action==='close')h.dispatch('pagehide');
      const raw=h.data.get(SAVE_KEY);callback({data:reply});h.clock.tick(10000);
      assert.equal(h.workers.length,1,`${action} must cancel pending retries`);assert.equal(h.data.get(SAVE_KEY),raw);
      if(action==='pause')assert.equal(h.$('ai-resume').hidden,false);
    }finally{h.close();}
  }
});

test('a final AI failure can be escaped with a one-command fallback undo without restarting AI',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    for(const delay of [250,750,0]){
      const worker=h.workers.at(-1);worker.ready();worker.onerror({});if(delay)h.clock.tick(delay);
    }
    assert.equal(h.$('ai-retry').hidden,false);assert.equal(h.$('undo-btn').disabled,false);
    h.$('undo-btn').click();assert.equal(h.current().session.record.actions.length,0);
    assert.equal(h.$('board').cells.some(c=>!c.disabled),true);assert.equal(h.$('ai-retry').hidden,true);
    h.clock.tick(10000);assert.equal(h.workers.length,3);
  }finally{h.close();}
});

test('startup AI restore waits for continue for either real-player identity',async()=>{
  for(const aiActor of ['A','B']){
    const h=await harness(savedPractice(aiActor));try{
      h.clock.tick(10000);assert.equal(h.workers.length,0);assert.equal(h.commits(),0);
      assert.match(h.$('ai-status').textContent,/恢复.*等待/);assert.equal(h.$('ai-resume').hidden,false);
      assert.equal(h.$('board').cells.every(c=>c.disabled),true);h.$('ai-resume').click();h.clock.tick();
      assert.equal(h.workers.length,aiActor==='A'?1:0);
      assert.equal(h.$('board').cells.every(c=>c.disabled),aiActor==='A');
    }finally{h.close();}
  }
});

test('new game replacement closes old work and ignores old results; live PvP remains protected',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const old=h.workers.at(-1);old.ready();
    const oldCallback=old.onmessage,reply=old.result({kind:'place',actor:'A',point:40});
    h.start({humanActor:'A',level:'standard'});assert.equal(h.$('replace-dialog').open,true);
    assert.equal(old.terminated,0,'reviewing replacement retains the current job');h.$('replace-confirm').click();
    assert.equal(old.terminated,1);const raw=h.data.get(SAVE_KEY);oldCallback({data:reply});h.clock.tick();
    assert.equal(h.data.get(SAVE_KEY),raw);assert.equal(h.current().session.controllers.A.kind,'human');
    h.start({mode:'pvp'});h.$('replace-confirm').click();h.$('settings-open').click();
    assert.equal(h.$('start-game').disabled,true);assert.equal(h.$('import-btn').disabled,true);
    assert.equal(h.$('ai-panel').hidden,true);
  }finally{h.close();}
});

test('import replacement terminates old work and restored AI waits before creating a fresh task',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const old=h.workers.at(-1);old.ready();
    const callback=old.onmessage,reply=old.result({kind:'place',actor:'A',point:40});
    await h.import(savedPractice('A',{swap3:false}));assert.equal(h.$('replace-dialog').open,true);
    h.$('replace-confirm').click();assert.equal(old.terminated,1);h.clock.tick();assert.equal(h.workers.length,1);
    const raw=h.data.get(SAVE_KEY);callback({data:reply});assert.equal(h.data.get(SAVE_KEY),raw);
    assert.equal(h.$('ai-resume').hidden,false);h.$('ai-resume').click();h.clock.tick();
    const fresh=h.workers.at(-1);fresh.ready();assert.notEqual(fresh.sent[0].context.requestId,old.sent[0].context.requestId);
    fresh.emit(fresh.result({kind:'place',actor:'A',point:0}));assert.equal(h.current().session.record.actions.length,1);
  }finally{h.close();}
});

test('storage events stop current AI work, preserve newer bytes and leave export available',async()=>{
  for(const key of [SAVE_KEY,null]){
    const h=await harness();try{
      h.start();h.clock.tick();const worker=h.workers.at(-1);worker.ready();
      const callback=worker.onmessage,reply=worker.result({kind:'place',actor:'A',point:40});
      h.data.set(SAVE_KEY,'newer-tab');h.dispatch('storage',{key,newValue:key===null?null:'newer-tab'});
      assert.equal(worker.terminated,1);assert.match(h.$('ai-status').textContent,/冲突/);
      assert.equal(h.$('ai-resume').disabled,true);assert.equal(h.$('export-btn').disabled,false);
      callback({data:reply});h.clock.tick(10000);assert.equal(h.data.get(SAVE_KEY),'newer-tab');assert.equal(h.workers.length,1);
    }finally{h.close();}
  }
});

test('a missed storage event is detected at readiness and stops work before sending a request',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const worker=h.workers.at(-1);h.data.set(SAVE_KEY,'newer-unannounced');
    worker.ready();assert.equal(worker.terminated,1);assert.equal(worker.sent.length,0);
    assert.match(h.$('ai-status').textContent,/冲突/);h.clock.tick(10000);
    assert.equal(h.workers.length,1);assert.equal(h.data.get(SAVE_KEY),'newer-unannounced');
  }finally{h.close();}
});

test('a missed storage update after readiness rejects replies and failures before the active position changes',async()=>{
  for(const event of ['reply','error','messageerror']){
    const h=await harness();try{
      h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();const worker=h.workers.at(-1);worker.ready();
      const beforeCount=h.$('move-count').textContent,beforeBoard=h.$('board').innerHTML,writes=h.commits();
      const obsolete=worker.onmessage,reply=worker.result({kind:'place',actor:'B',point:0});
      const external=JSON.stringify({...h.current(),snapshotId:'newer-other-tab'});h.data.set(SAVE_KEY,external);
      if(event==='reply')worker.emit(reply);
      else worker[event==='error'?'onerror':'onmessageerror']({});
      assert.equal(worker.terminated,1,`${event}: conflict must stop the current Worker`);
      assert.equal(h.$('move-count').textContent,beforeCount,`${event}: no command may commit into stale memory`);
      assert.equal(h.$('board').innerHTML,beforeBoard,`${event}: stale result must not change the displayed position`);
      assert.equal(h.commits(),writes,`${event}: no autosave may overwrite or back up stale bytes`);
      assert.equal(h.data.get(SAVE_KEY),external);assert.match(h.$('ai-status').textContent,/冲突/);
      assert.equal(h.$('ai-resume').disabled,true);assert.equal(h.$('export-btn').disabled,false);
      obsolete({data:reply});h.clock.tick(10000);
      assert.equal(h.workers.length,1);assert.equal(h.$('move-count').textContent,beforeCount);
      assert.equal(h.data.get(SAVE_KEY),external);
    }finally{h.close();}
  }
});

test('invalid imports preserve active work and paused opening cancellation never briefly resumes AI',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const worker=h.workers.at(-1);worker.ready();const raw=h.data.get(SAVE_KEY);
    await h.import({broken:true});assert.equal(worker.terminated,0);assert.equal(h.data.get(SAVE_KEY),raw);
    assert.equal(h.$('replace-dialog').open,false);h.$('ai-pause').click();assert.equal(worker.terminated,1);
    h.$('end-btn').click();assert.equal(h.$('action-dialog').open,true);h.$('practice-end').click();
    assert.equal(h.$('ai-panel').hidden,true);assert.match(h.$('turn-title').textContent,/取消/);
    assert.equal(h.current().session.record.actions.at(-1).kind,'cancel-opening');
    h.clock.tick(10000);assert.equal(h.workers.length,1);assert.equal(h.$('first-start').hidden,false);
  }finally{h.close();}
});

test('practice resignation on an AI turn closes work using the human identity',async()=>{
  const h=await harness();try{
    h.start({humanActor:'A',swap3:false});h.point(40);h.clock.tick();
    const worker=h.workers.at(-1);worker.ready();h.$('end-btn').click();h.$('practice-end').click();
    assert.equal(worker.terminated,1);const last=h.current().session.record.actions.at(-1);
    assert.deepEqual(last,{kind:'resign',actor:'A'});assert.equal(h.$('ai-panel').hidden,true);
    assert.match(h.$('turn-title').textContent,/弈合 AI.*获胜/);h.clock.tick(10000);assert.equal(h.workers.length,1);
  }finally{h.close();}
});

test('one local two-player consent removes two commands and never creates AI work',async()=>{
  const h=await harness();try{
    h.start({mode:'pvp'});h.point(40);h.point(42);h.$('undo-btn').click();
    assert.match(h.$('action-body').innerHTML,/data-actor="A"/);
    const actor=new Surface(h.$('board').document);actor.dataset.actor='A';
    h.$('action-body').dispatch('click',{target:actor});assert.equal(h.$('consent-panel').hidden,false);
    assert.equal(h.$('board').cells.every(c=>c.disabled),true);
    const consent=new Surface(h.$('board').document);consent.dataset.consent='yes';
    h.$('consent-panel').dispatch('click',{target:consent});
    assert.equal(h.current().session.record.actions.length,0);assert.equal(h.$('consent-panel').hidden,true);
    assert.equal(h.$('board').cells.some(c=>!c.disabled),true);h.clock.tick(10000);assert.equal(h.workers.length,0);
  }finally{h.close();}
});

test('pagehide closes active work and a cached pageshow requests a fresh document',async()=>{
  const h=await harness();try{
    h.start();h.clock.tick();const worker=h.workers.at(-1);worker.ready();
    const callback=worker.onmessage,reply=worker.result({kind:'place',actor:'A',point:40}),raw=h.data.get(SAVE_KEY);
    h.dispatch('pagehide');assert.equal(worker.terminated,1);callback({data:reply});h.clock.tick(10000);
    assert.equal(h.data.get(SAVE_KEY),raw);assert.equal(h.workers.length,1);
    h.dispatch('pageshow',{persisted:false});assert.equal(h.reloads(),0);
    h.dispatch('pageshow',{persisted:true});assert.equal(h.reloads(),1);
  }finally{h.close();}
});
