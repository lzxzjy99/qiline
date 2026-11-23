import type { Match, PlayerId, Result, Transition } from "../../core/src/types.js";
import { activePlayer, applyAction, validateRecord } from "../../core/src/engine.js";
import { freeze, keysAre, plain } from "../../core/src/result.js";
import type { AIAction, AILevel, AIResult, SearchBudget, SearchReply } from "./types.js";
import { AI_PROTOCOL_VERSION, aiFail, aiOK, readSearchEnvelope } from "./protocol.js";
import type { SearchEnvelope } from "./protocol.js";
import { alphaBeta } from "./tree.js";
import type { TreeAdapter, TreeEntry } from "./tree.js";
import { evaluatePosition, evaluateHardPosition, SECURED_LINE_VALUE, WIN_VALUE } from "./evaluation.js";
import { securedClaim } from "./claim-proof.js";
import { actionKey, orderActions, retainActions, tieRank } from "./ordering.js";
import { claimTacticalPoints, featuresOf, liveLinesOf, otherColor, playerColor, rescuedStones, shareFeaturePool } from "./features.js";
import type { FeaturePool } from "./features.js";
import { isV21Profile, runV21Search } from "./v21-engine.js";
import type { V21RuntimeOptions } from "./v21-engine.js";
import { runV27LiteSearch } from "./v27-lite-kernel.js";

export const SEARCH_POLICIES:Readonly<Record<AILevel,{readonly quietWidth:number;readonly rootWidth:number}>>=freeze({
  easy:{quietWidth:6,rootWidth:12},standard:{quietWidth:12,rootWidth:24},
  hard:{quietWidth:12,rootWidth:24},
});
export interface SearchHost {readonly now?:()=>number;readonly isCancelled?:()=>boolean}
export type SearchStop="max-depth"|"terminal-win"|"secured-line"|"time"|"nodes"|"cancelled"|"internal";
export interface SearchOutcome {
  readonly reply:SearchReply;
  readonly details:{readonly stop:SearchStop;readonly quietWidth:number;readonly maxVisitedDepth:number;
    readonly cutoffs:number;readonly rootCandidates:number;readonly score:number|null;readonly variation:readonly AIAction[]};
}
class Stopped {constructor(readonly reason:"time"|"nodes"|"cancelled") {}}
class Control {
  readonly start:number;last:number;nodes=0;maxVisitedDepth=0;
  // Request-local identity cache: distinct ko histories/claim clocks never share entries.
  private readonly transitions=new WeakMap<Match,Map<string,Result<Transition>>>();
  private cachedTransitions=0;
  readonly featurePool:FeaturePool|null;
  constructor(readonly budget:SearchBudget,readonly now:()=>number,readonly cancelled:()=>boolean,started:number,hard:boolean) {
    this.start=started;this.last=this.start;if(!Number.isFinite(this.start)||this.start<0)throw Error("invalid clock");
    this.featurePool=hard?new Map():null;
  }
  time():number {
    const now=this.now();if(!Number.isFinite(now)||now<this.last)throw Error("clock must be monotonic");this.last=now;
    return Math.min(Number.MAX_SAFE_INTEGER,now-this.start);
  }
  check():void {if(this.cancelled())throw new Stopped("cancelled");if(this.time()>=this.budget.timeMs)throw new Stopped("time");}
  simulate(match:Match,action:AIAction,depth:number):Result<Transition> {
    this.check();if(this.nodes>=this.budget.maxNodes)throw new Stopped("nodes");
    // Revisited probes still spend a node; memoization saves computation, not budget checks.
    this.nodes++;this.maxVisitedDepth=Math.max(this.maxVisitedDepth,depth);
    const key=actionKey(action),cached=this.transitions.get(match)?.get(key);if(cached)return cached;
    const result=applyAction(match,action);
    if(result.ok&&this.featurePool)shareFeaturePool(result.value.match,this.featurePool);
    if(this.cachedTransitions<2048){
      let entries=this.transitions.get(match);if(!entries){entries=new Map();this.transitions.set(match,entries);}
      entries.set(key,result);this.cachedTransitions++;
    }
    return result;
  }
}
interface RootMove {readonly action:AIAction;readonly next:Match;readonly critical:boolean;readonly order:number}
interface Node {readonly match:Match;readonly pathDepth:number;readonly onPV:boolean;readonly path:string}
const defaultNow=():number=>(globalThis as typeof globalThis&{performance:{now:()=>number}}).performance.now();

/** Replays every explicit command under the clock, without changing any core rule or restoring a raw board. */
function hydrate(header:SearchEnvelope,control:Control):AIResult<Match> {
  control.check();const raw=header.record;
  if (!plain(raw) || !keysAre(raw,["schemaVersion","rulesVersion","rules","actions"]) || !Array.isArray(raw.actions))
    return aiFail("INVALID_AI_REQUEST","record");
  const start=validateRecord({...raw,actions:[]});
  if (!start.ok) return aiFail("INVALID_AI_REQUEST",start.error.path,start.error.code);
  let match=start.value.match;
  for (let i=0;i<raw.actions.length;i++) {
    control.check();const next=applyAction(match,raw.actions[i]);
    if (!next.ok) return aiFail("INVALID_AI_REQUEST",`actions[${i}]`,next.error.code);
    match=next.value.match;
  }
  control.check();
  if (match.state.outcome) return aiFail("FINISHED");
  if (activePlayer(match)!==header.context.actor) return aiFail("WRONG_ACTOR");
  return aiOK(match);
}
function isCritical(before:Match,after:Match,action:AIAction,transition:Transition,hinted:boolean):boolean {
  if (hinted || action.kind!=="place" || after.state.outcome) return true;
  if (transition.events.some(e=>e.kind==="captured"||e.kind==="claim-started"||e.kind==="claim-cancelled")) return true;
  const color=playerColor(before,action.actor);if (!color) return false;
  return rescuedStones(before,after,color)>0 || featuresOf(after)[otherColor(color)].completions.length<featuresOf(before)[otherColor(color)].completions.length;
}
/** Only an actually legal, core-confirmed winning reply proves a direct tactical loss. */
function losingReply(match:Match,justMoved:PlayerId,control:Control,depth:number,proveDelayed=false):boolean {
  if(match.state.outcome || match.state.phase.kind!=="playing")return false;
  const actor=activePlayer(match);if(!actor || actor===justMoved)return false;
  const color=match.state.phase.toMove;
  if(proveDelayed&&securedClaim(match)?.color===color)return true;
  const probes:AIAction[]=match.rules.confirmationDelay===0||proveDelayed
    ?featuresOf(match)[color].completions.map(point=>({kind:"place",actor,point})):[];
  if(match.state.claims.some(c=>c.color===color&&c.dueAt<=match.state.ply+1))probes.push({kind:"pass",actor});
  for(const action of probes){
    const result=control.simulate(match,action,depth);
    if(result.ok && result.value.match.state.outcome?.kind==="win" && result.value.match.state.outcome!.winner===actor)return true;
    if(proveDelayed&&result.ok&&securedClaim(result.value.match)?.color===color)return true;
  }
  return false;
}
/** Timed local search. It returns a serialized reply, not an authorization token or a live move. */
export function runSearch(raw:unknown,host:SearchHost={}):AIResult<SearchOutcome> {
  return runSearchWithRuntime(raw,host,undefined);
}
/** Extended runtime entry allowing persistent/shared TT & multi-core SMP without changing the protocol contract. */
export function runSearchWithRuntime(raw:unknown,host:SearchHost={},v21Opts?:V21RuntimeOptions):AIResult<SearchOutcome> {
  if (!plain(host) || !Object.keys(host).every(k=>k==="now"||k==="isCancelled")
    || (host.now!==undefined&&typeof host.now!=="function") || (host.isCancelled!==undefined&&typeof host.isCancelled!=="function"))
    return aiFail("INVALID_AI_REQUEST","host");
  const now=host.now===undefined?defaultNow:host.now as ()=>number;
  const cancelled=host.isCancelled===undefined?()=>false:host.isCancelled as ()=>boolean;
  let started:number;
  try {started=now();}catch{return aiFail("AI_WORKER_FAILED");}
  const parsed=readSearchEnvelope(raw);if (!parsed.ok) return parsed;
  const header=parsed.value;
  let control:Control;
  try {control=new Control(header.budget,now,cancelled,started,header.level==="hard");}
  catch {return aiFail("AI_WORKER_FAILED");}
  const width=SEARCH_POLICIES[header.level].quietWidth,actor=header.context.actor;
  let best:AIAction|null=null,bestScore:number|null=null,variation:readonly AIAction[]=[],completedDepth=0,cutoffs=0,rootCount=0,bestOrder=-Infinity,bestProofTie=-Infinity;
  function finish(stop:SearchStop):AIResult<SearchOutcome> {
    let elapsed=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,control.last-control.start));
    try {elapsed=control.time();if(control.cancelled())stop="cancelled";else if(elapsed>=header.budget.timeMs&&stop!=="internal"&&stop!=="cancelled")stop="time";}
    catch {stop="internal";}
    const common={protocolVersion:AI_PROTOCOL_VERSION,kind:"result",context:header.context,
      stats:{elapsedMs:elapsed,nodes:control.nodes,completedDepth}} as const;
    let reply:SearchReply;
    if(stop==="cancelled")reply={...common,status:"cancelled"};
    else if(stop==="internal")reply={...common,status:"failed",reason:"internal"};
    else if(best)reply={...common,status:stop==="time"||stop==="nodes"?"timeout":"move",action:best};
    else reply={...common,status:"failed",reason:"no-action"};
    return aiOK(freeze({reply,details:{stop,quietWidth:width,maxVisitedDepth:control.maxVisitedDepth,cutoffs,
      rootCandidates:rootCount,score:bestScore,variation}}));
  }
  try {
    const restored=hydrate(header,control);if(!restored.ok)return restored;
    const match=restored.value;control.nodes=1;
    if(header.level==="hard"&&isV21Profile(match)){
      return runV21Search(header,match,now,cancelled,started,control.last,v21Opts);
    }
    if((header.level==="easy"||header.level==="standard")&&isV21Profile(match)&&host.isCancelled===undefined){
      const lite=runV27LiteSearch(header,match,now,cancelled,started,control.last);
      if(lite)return lite;
    }
    if(control.featurePool)shareFeaturePool(match,control.featurePool);
    if(header.level==="hard"&&securedClaim(match)?.color===playerColor(match,actor)){
      const action:AIAction={kind:"pass",actor},result=control.simulate(match,action,1);
      if(result.ok){
        best=action;variation=[action];rootCount=1;completedDepth=1;
        const won=result.value.match.state.outcome?.kind==="win"&&result.value.match.state.outcome.winner===actor;
        bestScore=won?WIN_VALUE:SECURED_LINE_VALUE;return finish(won?"terminal-win":"secured-line");
      }
    }
    control.check();const ordered=orderActions(match,header.seed);control.check();
    const roots:RootMove[]=[];
    const orders=new WeakMap<Match,ReturnType<typeof orderActions>>();
    // Full command paths preserve different PSK histories; these hints are ordering only, not cached scores.
    const localBest=new Map<string,AIAction>(),evaluations=new WeakMap<Match,number>();
    const evaluate=(match:Match)=>{
      let value=evaluations.get(match);if(value===undefined){
        value=header.level==="hard"?evaluateHardPosition(match,actor):evaluatePosition(match,actor);
        // Future actual and certified wins have the same game value. Immediate root wins still use WIN_VALUE.
        if(header.level==="hard")value=Math.max(-SECURED_LINE_VALUE,Math.min(SECURED_LINE_VALUE,value));
        evaluations.set(match,value);
      }return value;
    };
    const history=new Map<string,number>(),killers=new Map<number,readonly string[]>();
    const historyKey=(match:Match,action:AIAction)=>`${action.actor}/${match.state.phase.kind}/${playerColor(match,action.actor)}/${actionKey(action)}`;
    const proposalsFor=(match:Match,preferred:AIAction|null,pathDepth:number,quietWidth:number)=>{
      let proposals=orders.get(match);if(!proposals){proposals=orderActions(match,header.seed);orders.set(match,proposals);}
      if(header.level==="hard"){
        const key=preferred?actionKey(preferred):null,killer=killers.get(pathDepth)??[];
        const score=(p:(typeof proposals)[number])=>p.order+(history.get(historyKey(match,p.action))??0)+(killer.includes(historyKey(match,p.action))?8000:0);
        const selected=retainActions(proposals,preferred,quietWidth);
        return selected.map(p=>({p,preferred:actionKey(p.action)===key,score:score(p),tie:tieRank(p.action,header.seed)}))
          .sort((a,b)=>Number(b.preferred)-Number(a.preferred)||Number(b.p.critical)-Number(a.p.critical)||b.score-a.score||b.tie-a.tie).map(x=>x.p);
      }
      if(!preferred)return proposals;
      const key=actionKey(preferred);
      return [...proposals.filter(p=>actionKey(p.action)===key),...proposals.filter(p=>actionKey(p.action)!==key)];
    };
    let values=new Map<string,number>();
    const rootAllowance=header.level==="hard"&&match.state.phase.kind==="opening"&&match.state.phase.placed===2
      ?match.state.board.length:SEARCH_POLICIES[header.level].rootWidth;
    let quietRoots=0;
    for(const proposal of ordered){
      control.check();
      if(!proposal.critical && quietRoots>=rootAllowance)continue;
      const result=control.simulate(match,proposal.action,1);if(!result.ok)continue;
      if(!proposal.critical)quietRoots++;
      const next=result.value.match;rootCount++;
      // Retain a known-legal root even if the next clock check interrupts its evaluation.
      if(!best){best=proposal.action;variation=[best];}
      if(next.state.outcome?.kind==="win"&&next.state.outcome.winner===actor){
        best=proposal.action;bestScore=WIN_VALUE;variation=[best];completedDepth=1;return finish("terminal-win");
      }
      control.check();const value=evaluate(next);control.check();
      const critical=isCritical(match,next,proposal.action,result.value,proposal.critical);
      roots.push({action:proposal.action,next,critical,order:proposal.order});
      values.set(actionKey(proposal.action),value);
      const solvedLoss=header.level==="hard"&&value===-SECURED_LINE_VALUE&&bestScore===value;
      const proofTie=header.level==="hard"&&value===SECURED_LINE_VALUE?evaluatePosition(next,actor):-Infinity;
      if(bestScore===null||value>bestScore||(value===bestScore&&(solvedLoss?proposal.order>bestOrder
        :value===SECURED_LINE_VALUE&&header.level==="hard"?proofTie>bestProofTie:tieRank(proposal.action,header.seed)>tieRank(best,header.seed)))){
        best=proposal.action;bestScore=value;bestOrder=proposal.order;bestProofTie=proofTie;variation=[best];
      }
    }
    if(!roots.length)return finish("nodes");
    completedDepth=1;
    if(header.level==="hard"&&bestScore===SECURED_LINE_VALUE)return finish("secured-line");
    for(let depth=2;depth<=header.budget.maxDepth;depth++){
      control.check();const preferred=variation,previousValues=values;
      const sorted=roots.slice().sort((a,b)=>(previousValues.get(actionKey(b.action))??-Infinity)-(previousValues.get(actionKey(a.action))??-Infinity)
        || b.order-a.order || tieRank(b.action,header.seed)-tieRank(a.action,header.seed));
      let quiet=0;
      const candidates=sorted.filter(r=>r.critical || quiet++<(header.level==="hard"?SEARCH_POLICIES.hard.rootWidth:width)),safe:RootMove[]=[];
      for(const root of candidates){
        if(losingReply(root.next,actor,control,2,header.level==="hard"))cutoffs++;else safe.push(root);
      }
      const selected=safe.length?safe:candidates;
      // A scout and re-search get the same preferred move even when transition memoization is full.
      const previousHints=new Map(localBest);
      // Cache only this iteration's exact command paths/depths and fixed candidate membership.
      const bounds=new Map<string,TreeEntry<AIAction>>();
      const tree:TreeAdapter<Node,AIAction>={
        check:()=>control.check(),terminal:n=>!!n.match.state.outcome||header.level==="hard"&&!!securedClaim(n.match),player:n=>activePlayer(n.match),
        evaluate:n=>{control.check();return evaluate(n.match);},
        principalVariation:header.level==="hard",
        lookup:header.level==="hard"?(node,remaining)=>bounds.get(`${remaining}:${node.path}`):undefined,
        store:header.level==="hard"?(node,remaining,entry)=>{
          const key=`${remaining}:${node.path}`;if(bounds.size<16384||bounds.has(key))bounds.set(key,entry);
        }:undefined,
        remember:header.level==="hard"?(node,move)=>{
          if(localBest.size<16384||localBest.has(node.path))localBest.set(node.path,move);
        }:undefined,
        cutoff:(node,move,remaining)=>{
          cutoffs++;
          if(header.level==="hard"){
            const key=historyKey(node.match,move);
            history.set(key,Math.min(4000,(history.get(key)??0)+remaining*remaining*20));
            killers.set(node.pathDepth,[key,...(killers.get(node.pathDepth)??[]).filter(k=>k!==key)].slice(0,2));
          }
        },
        extend:node=>{
          if(header.level!=="hard" || node.pathDepth>=Math.min(header.budget.maxDepth,depth+2)
            || node.match.state.phase.kind!=="playing")return false;
          control.check();const f=featuresOf(node.match);
          return (node.match.rules.confirmationDelay===0&&(f.black.completions.length>0||f.white.completions.length>0))
            ||node.match.state.claims.some(c=>c.dueAt<=node.match.state.ply+2)
            ||liveLinesOf(node.match).some(l=>l.groups.some(g=>g.liberties.size<=2));
        },
        children:function*(node){
          control.check();
          const pref=(node.onPV?preferred[node.pathDepth]:null)??(header.level==="hard"?previousHints.get(node.path):null)??null;
          const quietWidth=header.level==="hard"&&node.match.state.phase.kind==="opening"&&node.match.state.phase.placed===2
            ?node.match.state.board.length:header.level==="hard"&&activePlayer(node.match)!==actor?width
            :header.level==="easy"?width:Math.max(4,width-node.pathDepth*2);
          const proposals=proposalsFor(node.match,pref,node.pathDepth,quietWidth);control.check();let quietLegal=0;
          const moving=activePlayer(node.match)!;
          let forcing:Set<number>|null=null;
          if(header.level==="hard"&&node.pathDepth>=depth){
            const f=featuresOf(node.match);forcing=new Set([...f.black.completions,...f.white.completions]);
            for(const point of claimTacticalPoints(node.match).keys())forcing.add(point);
            for(const group of f.groups.groups)if(group.liberties.size===1
              ||group.liberties.size===2&&group.stones.some(p=>f[group.color===1?'black':'white'].lineStones.has(p)))
              for(const point of group.liberties)forcing.add(point);
          }
          let losingChild:{move:AIAction;node:Node}|null=null,losingOrder=-Infinity,losingTie=-Infinity,any=false;
          for(const proposal of proposals){
            if(forcing&&proposal.action.kind==='place'&&!forcing.has(proposal.action.point))continue;
            control.check();if(!proposal.critical&&quietLegal>=quietWidth)continue;
            const result=control.simulate(node.match,proposal.action,node.pathDepth+1);if(!result.ok)continue;
            if(!proposal.critical)quietLegal++;
            const child={move:proposal.action,node:{match:result.value.match,pathDepth:node.pathDepth+1,
              onPV:node.onPV&&!!pref&&actionKey(proposal.action)===actionKey(pref),path:node.path+'/'+actionKey(proposal.action)}};
            if(node.pathDepth+2<=depth && losingReply(child.node.match,moving,control,node.pathDepth+2,header.level==="hard")){
              const tie=tieRank(proposal.action,header.seed);
              if(!losingChild||proposal.order>losingOrder||proposal.order===losingOrder&&tie>losingTie){
                losingChild=child;losingOrder=proposal.order;losingTie=tie;
              }
              cutoffs++;continue;
            }
            any=true;yield child;
            const outcome=child.node.match.state.outcome;
            if(outcome?.kind==="win"&&outcome.winner===moving)return;
          }
          // If all searched moves lose, retain a legal branch instead of inventing a pass or score.
          if(!any&&losingChild)yield losingChild;
        },
      };
      let iterationBest:AIAction|null=null,iterationValue=-Infinity,iterationRank=-Infinity,iterationOrder=-Infinity,iterationPV:readonly AIAction[]=[];
      const nextValues=new Map<string,number>();
      for(const root of selected){
        control.check();const result=alphaBeta({match:root.next,pathDepth:1,onPV:!!preferred[0]&&actionKey(root.action)===actionKey(preferred[0]),path:actionKey(root.action)},
          depth-1,actor,tree,iterationRank,Infinity);
        nextValues.set(actionKey(root.action),result.value);
        const rank=result.value;
        // Fail-low values are bounds, so equal bounds never replace the exact first best.
        // At the absolute losing floor an equal bound is exact. Still prefer attacking/saving the live five.
        // Other fail-low ties remain bounds and must not replace the exact first best.
        if(iterationBest===null||rank>iterationRank
          ||(rank===-WIN_VALUE||header.level==="hard"&&rank===-SECURED_LINE_VALUE)&&rank===iterationRank&&root.order>iterationOrder){
          iterationBest=root.action;iterationValue=result.value;iterationRank=rank;iterationOrder=root.order;iterationPV=[root.action,...result.variation];
        }
        if(iterationValue===WIN_VALUE||header.level==="hard"&&iterationValue===SECURED_LINE_VALUE)break;
      }
      if(iterationBest){best=iterationBest;bestScore=iterationValue;variation=iterationPV;completedDepth=depth;values=nextValues;}
    }
    return finish("max-depth");
  }catch(e){return finish(e instanceof Stopped?e.reason:"internal");}
}
