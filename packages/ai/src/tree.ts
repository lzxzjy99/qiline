import type { PlayerId } from "../../core/src/types.js";

export interface TreeAdapter<N,M> {
  readonly check:()=>void;
  readonly terminal:(node:N)=>boolean;
  readonly player:(node:N)=>PlayerId|null;
  readonly evaluate:(node:N)=>number;
  readonly children:(node:N)=>Iterable<{readonly move:M;readonly node:N}>;
  readonly cutoff:(node:N,move:M,depth:number)=>void;
  readonly extend?:(node:N)=>boolean;
  readonly principalVariation?:boolean;
  readonly remember?:((node:N,move:M)=>void)|undefined;
  /** Entries require the same root, full state history, depth and candidate set. */
  readonly lookup?:((node:N,depth:number)=>TreeEntry<M>|undefined)|undefined;
  readonly store?:((node:N,depth:number,entry:TreeEntry<M>)=>void)|undefined;
}
export interface TreeValue<M> {readonly value:number;readonly variation:readonly M[]}
export interface TreeEntry<M> extends TreeValue<M> {readonly bound:"exact"|"lower"|"upper"}
/** No negamax sign flipping: the same real player may act on consecutive commands. */
export function alphaBeta<N,M>(node:N,depth:number,root:PlayerId,tree:TreeAdapter<N,M>,
  alpha=-Infinity,beta=Infinity):TreeValue<M> {
  tree.check();
  if (tree.terminal(node)) return {value:tree.evaluate(node),variation:[]};
  if (depth===0) {
    if(!tree.extend?.(node))return {value:tree.evaluate(node),variation:[]};
    depth=1;
  }
  const startAlpha=alpha,startBeta=beta,cached=tree.lookup?.(node,depth);
  if(cached){
    const result={value:cached.value,variation:cached.variation};
    if(cached.bound==="exact")return result;
    if(cached.bound==="lower")alpha=Math.max(alpha,cached.value);else beta=Math.min(beta,cached.value);
    if(alpha>=beta)return result;
  }
  const maximize=tree.player(node)===root;
  let value=maximize?-Infinity:Infinity,variation:readonly M[]=[],any=false;
  for (const child of tree.children(node)) {
    let result:TreeValue<M>;
    if(tree.principalVariation&&any&&Number.isFinite(maximize?alpha:beta)){
        result=maximize?alphaBeta(child.node,depth-1,root,tree,alpha,Math.min(beta,alpha+0.000001))
          :alphaBeta(child.node,depth-1,root,tree,Math.max(alpha,beta-0.000001),beta);
        if(result.value>alpha&&result.value<beta)result=alphaBeta(child.node,depth-1,root,tree,alpha,beta);
    }else result=alphaBeta(child.node,depth-1,root,tree,alpha,beta);
    if (!any || (maximize?result.value>value:result.value<value)) {
      value=result.value;variation=[child.move,...result.variation];tree.remember?.(node,child.move);
    }
    any=true;
    if (maximize) alpha=Math.max(alpha,value);else beta=Math.min(beta,value);
    if (alpha>=beta) {tree.cutoff(node,child.move,depth);break;}
  }
  const result=any?{value,variation}:{value:tree.evaluate(node),variation:[]};
  tree.store?.(node,depth,{...result,bound:result.value<=startAlpha?"upper":result.value>=startBeta?"lower":"exact"});
  return result;
}
