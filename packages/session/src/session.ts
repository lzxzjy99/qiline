import type { Action, Match, PlayerId, Result } from "../../core/src/types.js";
import { activePlayer, applyAction, createMatch, exportRecord, undoLastCommand, validateAction, validateRecord } from "../../core/src/engine.js";
import { DEFAULT_RULES } from "../../core/src/rules.js";
import { fail, freeze, keysAre, ok, plain } from "../../core/src/result.js";
import type { ConsentRequest, Controllers, SessionSave, SessionState, TaskToken } from "./types.js";

const HUMANS:Controllers=freeze({A:{kind:"human"},B:{kind:"human"}});
const validPlayer=(p:unknown):p is PlayerId=>p==="A"||p==="B";
const otherPlayer=(p:PlayerId):PlayerId=>p==="A"?"B":"A";
const validId=(s:unknown):s is string=>typeof s==="string" && s.trim().length>0;
function controllersOf(input:unknown):Result<Controllers> {
  if (!plain(input) || !keysAre(input,["A","B"])) return fail("INVALID_SESSION");
  const result:Record<string,Controllers[PlayerId]>={};
  for (const actor of ["A","B"] as const) {
    const c=input[actor];if (!plain(c)) return fail("INVALID_SESSION");
    if (c.kind==="human" && keysAre(c,["kind"])) result[actor]={kind:"human"};
    else if (c.kind==="ai" && keysAre(c,["kind","level","seed"]) && (c.level==="easy"||c.level==="standard"||c.level==="hard")
      && typeof c.seed==="number" && Number.isInteger(c.seed) && c.seed>=0 && c.seed<=0xffffffff)
      result[actor]={kind:"ai",level:c.level,seed:c.seed};
    else return fail("INVALID_SESSION");
  }
  return ok(freeze(result as unknown as Controllers));
}

/** No DOM, timers, storage or AI search. Hosts supply unique ids and schedule work. */
export class GameSession {
  #state:SessionState;
  readonly #seenIds=new Set<string>();
  readonly #issuedTokens=new WeakSet<object>();
  private constructor(matchId:string,match:Match,controllers:Controllers,competitive:boolean) {
    this.#seenIds.add(matchId);
    this.#state=Object.freeze({matchId,revision:0,match,controllers,competitive,paused:false,closed:false,
      hintsEnabled:false,consent:null,task:null});
  }
  static create(input:unknown):Result<GameSession> {
    if (!plain(input) || !validId(input.matchId) || !Object.keys(input).every(k=>["matchId","rules","controllers","competitive"].includes(k))
      || (Object.hasOwn(input,"competitive") && typeof input.competitive!=="boolean")) return fail("INVALID_SESSION");
    const m=createMatch(Object.hasOwn(input,"rules")?input.rules:DEFAULT_RULES);if (!m.ok) return m;
    const c=controllersOf(Object.hasOwn(input,"controllers")?input.controllers:HUMANS);if (!c.ok) return c;
    return ok(new GameSession(input.matchId,m.value,c.value,input.competitive===true));
  }
  static restore(matchId:unknown,input:unknown):Result<GameSession> {
    if (!validId(matchId) || !plain(input) || !keysAre(input,["sessionSchemaVersion","record","controllers","competitive"])
      || input.sessionSchemaVersion!==1 || typeof input.competitive!=="boolean") return fail("INVALID_SESSION");
    const c=controllersOf(input.controllers);if (!c.ok) return c;
    const m=validateRecord(input.record);if (!m.ok) return m;
    return ok(new GameSession(matchId,m.value.match,c.value,input.competitive));
  }
  get state():SessionState {return this.#state;}
  #change(patch:Partial<SessionState>):void {
    this.#state=Object.freeze({...this.#state,...patch,revision:this.#state.revision+1});
  }
  #isHuman(actor:unknown):actor is PlayerId {return validPlayer(actor)&&this.#state.controllers[actor].kind==="human";}
  #replace(match:Match):Result<SessionState> {
    this.#change({match,task:null,consent:null,paused:false});return ok(this.#state);
  }
  submit(actor:PlayerId,input:unknown):Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (this.#state.match.state.outcome) return fail("FINISHED");
    if (!this.#isHuman(actor)) return fail("WRONG_ACTOR");
    const a=validateAction(input);if (!a.ok) return a;
    if (a.value.actor!==actor) return fail("WRONG_ACTOR");
    // An approvedBy array from a caller is not a live consent workflow.
    if (a.value.kind==="cancel-opening") return fail("CONSENT_REQUIRED");
    // Resignation remains available during a dialog, consent request or AI thinking.
    if (this.#state.paused && a.value.kind!=="resign") return fail("PAUSED");
    const r=applyAction(this.#state.match,a.value);return r.ok?this.#replace(r.value.match):r;
  }
  #performConsent(kind:ConsentRequest["kind"],requester:PlayerId):Result<SessionState> {
    if (kind==="enable-hints") {
      this.#change({hintsEnabled:true,task:null,consent:null,paused:false});return ok(this.#state);
    }
    const r=kind==="undo"?undoLastCommand(this.#state.match)
      :applyAction(this.#state.match,{kind:"cancel-opening",actor:requester,approvedBy:["A","B"]});
    if (!r.ok) return r;
    return this.#replace(kind==="undo"?r.value as Match:(r.value as {match:Match}).match);
  }
  #request(actor:PlayerId,kind:ConsentRequest["kind"]):Result<SessionState> {
    const s=this.#state;
    if (s.closed) return fail("CLOSED");
    if (s.match.state.outcome) return fail("FINISHED");
    if (!this.#isHuman(actor)) return fail("WRONG_ACTOR");
    if (s.competitive) return fail("COMPETITIVE");
    if (s.consent) return fail("CONSENT_REQUIRED");
    if (s.paused) return fail("PAUSED");
    if (kind==="undo") {const r=undoLastCommand(s.match);if (!r.ok) return r;}
    if (kind==="cancel-opening" && !["opening","choose"].includes(s.match.state.phase.kind)) return fail("WRONG_PHASE");
    if (kind==="enable-hints" && s.hintsEnabled) return ok(s);
    // The computer is not a second human whose consent can be forged.
    if (s.controllers[otherPlayer(actor)].kind==="ai") return this.#performConsent(kind,actor);
    const revision=s.revision+1;
    this.#change({paused:true,task:null,consent:Object.freeze({id:`${s.matchId}/${revision}/${kind}`,requester:actor,kind,revision})});
    return ok(this.#state);
  }
  requestUndo(actor:PlayerId):Result<SessionState> {return this.#request(actor,"undo");}
  requestCancelOpening(actor:PlayerId):Result<SessionState> {return this.#request(actor,"cancel-opening");}
  requestHints(actor:PlayerId):Result<SessionState> {return this.#request(actor,"enable-hints");}
  respondToConsent(actor:PlayerId,id:string,accept:boolean):Result<SessionState> {
    const s=this.#state,c=s.consent;
    if (s.closed) return fail("CLOSED");
    if (!c || c.id!==id || c.revision!==s.revision) return fail("STALE_REQUEST");
    if (!this.#isHuman(actor) || actor===c.requester || typeof accept!=="boolean") return fail("WRONG_ACTOR");
    if (!accept) {this.#change({paused:false,consent:null,task:null});return ok(this.#state);}
    return this.#performConsent(c.kind,c.requester);
  }
  disableHints(actor:PlayerId):Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (!this.#isHuman(actor)) return fail("WRONG_ACTOR");
    if (this.#state.consent) return fail("CONSENT_REQUIRED");
    if (this.#state.hintsEnabled) this.#change({hintsEnabled:false,task:null});
    return ok(this.#state);
  }
  setPaused(paused:boolean):Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (typeof paused!=="boolean") return fail("INVALID_SESSION");
    if (this.#state.consent && !paused) return fail("CONSENT_REQUIRED");
    if (this.#state.paused!==paused) this.#change({paused,task:null});
    return ok(this.#state);
  }
  beginTask(kind:TaskToken["kind"],actor:PlayerId,taskId:string):Result<TaskToken> {
    const s=this.#state;
    if (s.closed) return fail("CLOSED");
    if (s.match.state.outcome) return fail("FINISHED");
    if (s.paused) return fail("PAUSED");
    if (s.task) return fail("TASK_BUSY");
    if (!validId(taskId) || !validPlayer(actor) || (kind!=="ai"&&kind!=="hint")) return fail("INVALID_SESSION");
    if (kind==="ai" && (s.controllers[actor].kind!=="ai" || activePlayer(s.match)!==actor)) return fail("WRONG_ACTOR");
    if (kind==="hint" && (s.competitive || !s.hintsEnabled)) return fail("HINTS_DISABLED");
    if (kind==="hint" && (!this.#isHuman(actor) || s.match.state.phase.kind!=="playing")) return fail("WRONG_PHASE");
    const token=Object.freeze({kind,actor,taskId,matchId:s.matchId,revision:s.revision+1});
    this.#issuedTokens.add(token);
    this.#change({task:token});return ok(token);
  }
  isTaskCurrent(input:unknown):input is TaskToken {
    const s=this.#state,t=s.task;
    return !s.closed && !s.paused && !s.match.state.outcome && !!t && plain(input) && this.#issuedTokens.has(input)
      && keysAre(input,["kind","actor","taskId","matchId","revision"])
      && input.kind===t.kind && input.actor===t.actor && input.taskId===t.taskId
      && input.matchId===s.matchId && input.revision===s.revision;
  }
  commitAIResult(token:unknown,input:unknown):Result<SessionState> {
    if (!this.isTaskCurrent(token) || token.kind!=="ai") return fail("STALE_TASK");
    const a=validateAction(input);if (!a.ok) return a;
    if (a.value.actor!==token.actor || a.value.kind==="cancel-opening") return fail("WRONG_ACTOR");
    const r=applyAction(this.#state.match,a.value);return r.ok?this.#replace(r.value.match):r;
  }
  completeHint(token:unknown):Result<SessionState> {
    if (!this.isTaskCurrent(token) || token.kind!=="hint") return fail("STALE_TASK");
    this.#change({task:null});return ok(this.#state);
  }
  cancelTask():Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (this.#state.task) this.#change({task:null});return ok(this.#state);
  }
  #newId(id:unknown):Result<string> {
    return validId(id)&&!this.#seenIds.has(id)?ok(id):fail("INVALID_SESSION");
  }
  newGame(matchId:string,rules:unknown=this.#state.match.rules):Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (!this.#state.match.state.outcome && (this.#state.competitive
      || Object.values(this.#state.controllers).every(c=>c.kind==="human"))) return fail("WRONG_PHASE");
    const id=this.#newId(matchId);if (!id.ok) return id;
    const m=createMatch(rules);if (!m.ok) return m;
    this.#seenIds.add(id.value);
    this.#change({matchId:id.value,match:m.value,task:null,consent:null,paused:false,hintsEnabled:false});return ok(this.#state);
  }
  exportSave():SessionSave {
    return freeze({sessionSchemaVersion:1,record:exportRecord(this.#state.match),controllers:this.#state.controllers,competitive:this.#state.competitive});
  }
  loadSave(matchId:string,input:unknown):Result<SessionState> {
    if (this.#state.closed) return fail("CLOSED");
    if (!this.#state.match.state.outcome && (this.#state.competitive
      || Object.values(this.#state.controllers).every(c=>c.kind==="human"))) return fail("WRONG_PHASE");
    const id=this.#newId(matchId);if (!id.ok) return id;
    if (!plain(input) || !keysAre(input,["sessionSchemaVersion","record","controllers","competitive"])
      || input.sessionSchemaVersion!==1 || input.competitive!==this.#state.competitive) return fail("INVALID_SESSION");
    const c=controllersOf(input.controllers);if (!c.ok) return c;
    const m=validateRecord(input.record);if (!m.ok) return m;
    this.#seenIds.add(id.value);
    this.#change({matchId:id.value,match:m.value.match,controllers:c.value,hintsEnabled:false,task:null,consent:null,paused:false});return ok(this.#state);
  }
  close():void {
    if (!this.#state.closed) this.#change({closed:true,paused:true,task:null,consent:null});
  }
}
export const createSession=(input:unknown):Result<GameSession>=>GameSession.create(input);
/** Startup restoration: no live human game is discarded. Old task handles are not restored. */
export const restoreSession=(matchId:unknown,input:unknown):Result<GameSession>=>GameSession.restore(matchId,input);
