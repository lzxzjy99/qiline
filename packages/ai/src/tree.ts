import type { PlayerId } from "../../core/src/types.js";

export interface TreeAdapter<N,M> {
  readonly check:()=>void;
  readonly terminal:(node:N)=>boolean;
  readonly player:(node:N)=>PlayerId|null;
  readonly evaluate:(node:N)=>number;
  readonly children:(node:N)=>Iterable<{readonly move:M;readonly node:N}>;
  readonly cutoff:()=>void;
}
export interface TreeValue<M> {readonly value:number;readonly variation:readonly M[]}
/** No negamax sign flipping: the same real player may act on consecutive commands. */
export function alphaBeta<N,M>(node:N,depth:number,root:PlayerId,tree:TreeAdapter<N,M>,
  alpha=-Infinity,beta=Infinity):TreeValue<M> {
  tree.check();
  if (depth===0 || tree.terminal(node)) return {value:tree.evaluate(node),variation:[]};
  const maximize=tree.player(node)===root;
  let value=maximize?-Infinity:Infinity,variation:readonly M[]=[],any=false;
  for (const child of tree.children(node)) {
    const result=alphaBeta(child.node,depth-1,root,tree,alpha,beta);
    if (!any || (maximize?result.value>value:result.value<value)) {
      value=result.value;variation=[child.move,...result.variation];
    }
    any=true;
    if (maximize) alpha=Math.max(alpha,value);else beta=Math.min(beta,value);
    if (alpha>=beta) {tree.cutoff();break;}
  }
  return any?{value,variation}:{value:tree.evaluate(node),variation:[]};
}
