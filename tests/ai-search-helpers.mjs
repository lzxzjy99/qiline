import {beginAITurn} from '../dist/ai/src/index.js';
import {fromMatch} from './ai-helpers.mjs';
import {value} from './helpers.mjs';
export function searchRequest(match,budget={},level='standard'){
 const turn=value(beginAITurn(fromMatch(match)));
 return {...turn.request,level,budget:{timeMs:10000,maxNodes:15000,maxDepth:4,...budget}};
}
export const frozenClock={now:()=>0};
