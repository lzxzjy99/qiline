import {DEFAULT_RULES,activePlayer,exportRecord,parsePoint} from '../dist/core/src/index.js';
import {createSession,restoreSession} from '../dist/session/src/index.js';
import {beginAITurn} from '../dist/ai/src/index.js';
import {value} from './helpers.mjs';
export const controllers=(actor='A',level='standard',seed=37)=>({
 A:actor==='A'?{kind:'ai',level,seed}:{kind:'human'},
 B:actor==='B'?{kind:'ai',level,seed}:{kind:'human'},
});
export const practice=(actor='A',patch={},level='standard',seed=37)=>value(createSession({
 matchId:'M',rules:{...DEFAULT_RULES,swap3:false,...patch},controllers:controllers(actor,level,seed),
}));
export const fromMatch=(match,actor=activePlayer(match))=>value(restoreSession('M',{
 sessionSchemaVersion:1,record:exportRecord(match),controllers:controllers(actor),competitive:false,
}));
export const point=(s,coord)=>value(parsePoint(coord,s.state.match.rules.boardSize));
export const reply=(turn,action,status='move',stats={elapsedMs:1,nodes:1,completedDepth:0})=>({
 protocolVersion:1,kind:'result',context:structuredClone(turn.request.context),status,
 ...(action?{action}:{}),stats,
});
/** Supplied test actions only. Tactical decision tests use recommendBasicAction separately. */
export function command(s,action){
 if(s.state.controllers[action.actor].kind==='human')return value(s.submit(action.actor,action));
 const turn=value(beginAITurn(s));return value(turn.accept(reply(turn,action)));
}
export function place(s,coord){return command(s,{kind:'place',actor:activePlayer(s.state.match),point:point(s,coord)});}
