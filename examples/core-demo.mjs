import assert from 'node:assert/strict';
import {DEFAULT_RULES,createMatch,activePlayer,applyAction,parsePoint,exportRecord,replayRecord} from '../dist/core/src/index.js';
const take=r=>{if(!r.ok)throw new Error(JSON.stringify(r.error));return r.value;};
const coordinates=['A1','E4','B2','D5','C3','F5','D4','A9','E1','C9','F2','E9','G3','G9','H4','I9','E5','A7','I5','E6'];
const results=[];
for(const claimMode of ['fixed-five','color-pressure']){
 let match=take(createMatch({...DEFAULT_RULES,swap3:false,claimMode}));
 for(const coordinate of coordinates)match=take(applyAction(match,{kind:'place',actor:activePlayer(match),point:take(parsePoint(coordinate,9))})).match;
 while(!match.state.outcome)match=take(applyAction(match,{kind:'pass',actor:activePlayer(match)})).match;
 const replayed=take(replayRecord(JSON.parse(JSON.stringify(exportRecord(match)))));
 assert.deepEqual(replayed.state,match.state);
 assert.equal(match.state.ply,claimMode==='fixed-five'?23:21);
 results.push({玩法:claimMode==='fixed-five'?'标准：同组五子独立计时':'可选：换线继承计时',胜利动作数:match.state.ply,结果:match.state.outcome});
}
console.log(JSON.stringify({规则版本:DEFAULT_RULES.rulesVersion,说明:'这是P2核心演示；可玩界面在P3制作',演示:results},null,2));
