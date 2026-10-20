import {DEFAULT_RULES, activePlayer, formatPoint} from '../core/src/index.js';
import {restoreSession} from '../session/src/index.js';

export const SAVE_KEY = 'qiline.web.r3.current';
export const BACKUP_KEY = 'qiline.web.r3.previous';
export const other = p => p === 'A' ? 'B' : 'A';
export const colorName = c => c === 'black' ? '黑棋' : '白棋';
export const fail = code => ({ok:false,error:{code}});
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const playerName = (meta, p) => meta.names[p === 'A' ? meta.aIndex : 1-meta.aIndex];
export function validatePlayers(p) {
  return plain(p) && Object.keys(p).length===3 && Array.isArray(p.names) && p.names.length===2
    && p.names.every(n=>typeof n==='string' && n.trim().length>0 && n.length<=24)
    && (p.aIndex===0 || p.aIndex===1) && Number.isSafeInteger(p.round) && p.round>=1;
}
export function makeWebSave(session, players, snapshotId) {
  return {webSchemaVersion:1, snapshotId, players, session:session.exportSave()};
}
export function parseWebSave(input, matchId) {
  let raw;
  try {raw=typeof input==='string'?JSON.parse(input):input;} catch {return fail('INVALID_RECORD');}
  let players={names:['玩家A','玩家B'],aIndex:0,round:1};
  if (plain(raw) && Object.hasOwn(raw,'webSchemaVersion')) {
    if (raw.webSchemaVersion!==1) return fail('UNSUPPORTED_VERSION');
    if (Object.keys(raw).sort().join(',')!=='players,session,snapshotId,webSchemaVersion'
      || !validatePlayers(raw.players) || typeof raw.snapshotId!=='string') return fail('INVALID_RECORD');
    players=raw.players; raw=raw.session;
  } else if (plain(raw) && Object.hasOwn(raw,'schemaVersion')) {
    raw={sessionSchemaVersion:1,record:raw,controllers:{A:{kind:'human'},B:{kind:'human'}},competitive:false};
  }
  const result=restoreSession(matchId,raw);
  if (!result.ok) return result;
  if (Object.values(result.value.state.controllers).some(c=>c.kind!=='human')) return fail('AI_UNAVAILABLE');
  return {ok:true,value:{session:result.value,players}};
}
export function phaseView(match, meta) {
  if (!match) return {title:'准备好，下一手见。',detail:'围棋的提子，五连的胜负。两个人，一盘棋。',actor:null,color:null};
  const s=match.state,p=s.phase,actor=activePlayer(match);
  if (p.kind==='opening') {
    const color=p.placed===1?'white':'black';
    return {title:`${playerName(meta,'A')}摆${colorName(color)}`,detail:`三手换色 · 第 ${p.placed+1} / 3 子，摆局不能提子。`,actor,color};
  }
  if (p.kind==='choose') return {title:`${playerName(meta,'B')}选择执色`,detail:'看过三子布局后选黑或白；选定后，由白棋先行。',actor,color:null};
  if (p.kind==='playing') return {title:`${playerName(meta,actor)} · ${colorName(p.toMove)}行棋`,detail:s.passStreak?(s.claims.length?'上一手停手；仍有五连候选，继续计时。':'上一手停手，再停一手即和棋。'):'点击交叉点落子；也可以停手。',actor,color:p.toMove};
  const o=s.outcome;
  if (o.kind==='win') return {title:`${playerName(meta,o.winner)}获胜`,detail:`${colorName(o.color)} · ${o.reason==='line'?'五连已确认':'对方认输'}`,actor:null,color:o.color};
  return {title:o.kind==='draw'?'本局和棋':'开局已取消',detail:o.kind==='draw'?'无五连候选，双方连续停手。':'双方同意取消，不记录胜负。',actor:null,color:null};
}
export function rulesView(r=DEFAULT_RULES) {
  return [ `${r.boardSize} 路`,r.directions==='diagonal'?'仅对角线':'四方向',r.claimMode==='fixed-five'?'固定五子':'换线继承',`延迟 ${r.confirmationDelay} 手`,r.swap3?'三手换色':'直接开局',r.superko==='positional'?'全局禁重复':'允许重复' ];
}
export function claimsView(match) {
  return match.state.claims.map(c=>({...c,remaining:Math.max(0,c.dueAt-match.state.ply),coordinates:c.points.map(p=>formatPoint(p,match.rules.boardSize)).join(' · ')}));
}
export const ERROR_TEXT = {
  OCCUPIED:'这里已有棋子。',SUICIDE:'这手落子后没有气，不能下在这里。',REPETITION:'这手会重复历史棋盘，已被禁重复规则阻止。',
  OPENING_CAPTURE:'摆局三子不能提子，请换一个位置。',WRONG_PHASE:'请先完成当前对局；开局可双方同意取消，正式对局可认输。',
  WRONG_ACTOR:'现在应由另一位玩家操作。',PAUSED:'正在等待对方回应，请先处理同意请求。',FINISHED:'本局已经结束，请开始新局。',
  NO_UNDO:'当前没有可以撤回的操作。',COMPETITIVE:'竞技模式不允许悔棋或取消开局。',CONSENT_REQUIRED:'需要另一位玩家同意。',
  STALE_REQUEST:'这个请求已失效。',INVALID_RECORD:'文件格式或棋谱无效，当前对局已保留。',INVALID_SESSION:'存档不完整或格式不受支持，当前对局已保留。',
  UNSUPPORTED_VERSION:'不支持这个版本的存档，当前对局已保留。',AI_UNAVAILABLE:'此版仅支持本地双人，无法载入人机存档。',
  STORAGE_CONFLICT:'另一标签页已更新对局。请刷新载入最新存档；当前局仍可导出。',FILE_TOO_LARGE:'文件超过 5 MB，未读取。当前对局已保留。'
};
export function errorText(error) {return ERROR_TEXT[error.cause] || ERROR_TEXT[error.code] || '操作未生效，当前对局已保留。';}

/** Optimistic single-writer storage: a stale tab never overwrites a newer save. */
export class SafeStorage {
  constructor(storage) {this.storage=storage;this.raw=null;this.warning='';this.conflict=false;}
  read() {
    try {this.raw=this.storage.getItem(SAVE_KEY);return this.raw;}
    catch {this.warning='浏览器不允许自动保存。请使用“导出存档”保存进度。';return null;}
  }
  check() {
    if (this.conflict) return false;
    try {if (this.storage.getItem(SAVE_KEY)!==this.raw) {this.conflict=true;this.warning=ERROR_TEXT.STORAGE_CONFLICT;return false;}}
    catch {this.warning='自动保存不可用。对局可以继续，请导出存档。';}
    return true;
  }
  write(raw) {
    if (!this.check()) return false;
    try {
      // If the previous backup cannot be updated, keep the current save intact.
      if (this.raw!==null) this.storage.setItem(BACKUP_KEY,this.raw);
      this.storage.setItem(SAVE_KEY,raw);this.raw=raw;this.warning='';return true;
    } catch {this.warning='自动保存失败，旧存档已保留。请导出存档保存当前进度。';return false;}
  }
}
