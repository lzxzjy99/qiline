import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {SAVE_KEY} from '../dist/ui/model.mjs';
import {FakeWorker,VirtualHost} from './worker-fakes.mjs';

// Execute the shipped entry module and its actual scheduler/model imports. Only browser
// surfaces are substituted; these checks complement actual-browser layout/Worker QA.
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const appURL=new URL('../dist/app.mjs',import.meta.url);
const app=(await readFile(appURL,'utf8')).replace(/from\s+(['"])(\.[^'"]+)\1/g,
  (_all,quote,specifier)=>`from ${quote}${new URL(specifier,appURL).href}${quote}`);
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
async function harness(startup=null,{at=null}={}){
  const clock=new VirtualHost(),document=documentSurface(),data=new Map(),writes=[];
  if(startup!==null)data.set(SAVE_KEY,typeof startup==='string'?startup:JSON.stringify(startup));
  const listeners=new Map(),workers=[],downloads=[];let reloads=0,sequence=0;
  const originalCreate=document.createElement;
  document.createElement=tag=>{
    const node=originalCreate.call(document,tag);
    if(tag==='a')node.click=()=>downloads.push({name:node.download,url:node.href});
    return node;
  };
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
  if(at){const RealDate=Date;replacements.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[at]));}};}
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
  return {$,form,change,start,point,current,commits,workers,clock,data,writes,dispatch,document,downloads,
    reloads:()=>reloads,async import(raw){const file=$('import-file');file.files=[{size:JSON.stringify(raw).length,text:async()=>JSON.stringify(raw)}];await file.onchange({target:file});},
    close(){try{dispatch('pagehide');}finally{restore();}}};
}
test('all board sizes navigate visually up/down and retain edge focus without writing a command',async()=>{
  for(const n of [9,13,15,19]){
    const h=await harness();try{
      h.start({mode:'pvp',boardSize:n,swap3:false});
      const board=h.$('board'),center=Math.floor(n*n/2),cell=board.querySelector(`[data-point="${center}"]`);
      cell.focus();cell.dispatch('keydown',{key:'ArrowUp'});
      assert.equal(Number(h.document.activeElement.dataset.point),center+n);
      h.document.activeElement.dispatch('keydown',{key:'ArrowDown'});
      assert.equal(Number(h.document.activeElement.dataset.point),center);
      const top=board.querySelector(`[data-point="${n*(n-1)}"]`);top.focus();top.dispatch('keydown',{key:'ArrowUp'});
      assert.equal(Number(h.document.activeElement.dataset.point),n*(n-1));
      h.document.activeElement.dispatch('keydown',{key:'ArrowLeft'});assert.equal(Number(h.document.activeElement.dataset.point),n*(n-1));
      const bottom=board.querySelector('[data-point="0"]');bottom.focus();bottom.dispatch('keydown',{key:'ArrowDown'});
      assert.equal(Number(h.document.activeElement.dataset.point),0);
      assert.equal(h.current().session.record.actions.length,0,'navigation must not change the position');
      assert.equal(h.commits(),1,'focus movement must not replace the autosave');
    }finally{h.close();}
  }
});

test('export filename uses the local calendar day during the eight hours after China midnight',async()=>{
  const previous=process.env.TZ;process.env.TZ='Asia/Shanghai';
  const h=await harness(null,{at:'2026-10-20T16:30:00.000Z'});try{
    h.start({mode:'pvp',swap3:false});h.$('export-btn').click();
    assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].name,'弈合_第1局_2026-10-21.json');
  }finally{h.close();if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test('local calendar export date remains correct on both sides of UTC and at year rollover',()=>{
  const model=new URL('../dist/ui/model.mjs',import.meta.url).href;
  for(const [timezone,instant,expected]of [
    ['Asia/Shanghai','2026-12-31T16:01:00.000Z','2027-01-01'],
    ['America/Los_Angeles','2026-10-21T03:30:00.000Z','2026-10-20'],
    ['UTC','2026-10-21T03:30:00.000Z','2026-10-21'],
  ]){
    const script=`import {localCalendarDate} from ${JSON.stringify(model)};process.stdout.write(localCalendarDate(new Date(${JSON.stringify(instant)})));`;
    const output=execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:timezone},encoding:'utf8'});
    assert.equal(output,expected,`${timezone}: the export date must follow the user's local calendar`);
  }
});

