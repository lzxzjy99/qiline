import assert from 'node:assert/strict';
import {DEFAULT_RULES,createMatch,applyAction,activePlayer,parsePoint,exportRecord,replayRecord} from '../dist/core/src/index.js';
export function value(r) {assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
export function error(r,code) {assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code);return r.error;}
export const rules=(patch={})=>({...DEFAULT_RULES,...patch});
export const create=(patch={})=>value(createMatch(rules(patch)));
export const p=(m,s)=>value(parsePoint(s,m.rules.boardSize));
export function act(m,kind,arg,actor=activePlayer(m)) {
 const a={kind,actor};if(kind==='place')a.point=typeof arg==='string'?p(m,arg):arg;
 if(kind==='choose-color')a.color=arg;
 if(kind==='cancel-opening')a.approvedBy=arg;
 return value(applyAction(m,a)).match;
}
export function ready(config) {
 let m=value(createMatch(config));
 if(config.swap3) {
  for(const s of ['I2','I4','I6'])m=act(m,'place',s);
  m=act(m,'choose-color','white');m=act(m,'pass');
 }
 return m;
}
export const sequence=(m,coords)=>{for(const s of coords){if(m.state.outcome)break;m=act(m,'place',s);}return m;};
export function fingerprint(m) {return JSON.stringify({rules:m.rules,state:m.state,positions:m.positions,actions:m.accepted});}
export function replayEqual(m) {assert.equal(fingerprint(value(replayRecord(exportRecord(m)))),fingerprint(m));}
export function finishByPass(m) {let count=0;while(!m.state.outcome){m=act(m,'pass');assert.ok(++count<=14);}return m;}
export const claimTimes=m=>Object.fromEntries(['black','white'].flatMap(c=>{
 const list=m.state.claims.filter(k=>k.color===c);return list.length?[[c,Math.min(...list.map(k=>k.formedAt))]]:[];
}));
export const handoff=['A1','E4','B2','D5','C3','F5','D4','A9','E1','C9','F2','E9','G3','G9','H4','I9','E5','A7','I5','E6'];
