import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,restoreSession} from '../dist/session/src/index.js';
import {DEFAULT_RULES} from '../dist/core/src/index.js';
import {value,error,fingerprint} from './helpers.mjs';

test('startup restore works for PvP and task handles cannot cross session instances or serialization',()=>{
 const options={matchId:'same-id',rules:{...DEFAULT_RULES,swap3:false}};
 const original=value(createSession(options));
 value(original.submit('A',{kind:'place',actor:'A',point:40}));
 const restored=value(restoreSession('RESTORED',original.exportSave()));
 assert.equal(fingerprint(restored.state.match),fingerprint(original.state.match));
 assert.equal(restored.state.task,null);assert.equal(restored.state.consent,null);assert.equal(restored.state.hintsEnabled,false);
 const bad=JSON.parse(JSON.stringify(original.exportSave()));bad.record.actions[0].point=81;
 assert.equal(restoreSession('BAD',bad).ok,false);
 const aiOptions={...options,controllers:{A:{kind:'ai',level:'easy',seed:1},B:{kind:'human'}}};
 const old=value(createSession(aiOptions)),oldToken=value(old.beginTask('ai','A','reused-task'));
 const fresh=value(restoreSession('same-id',old.exportSave())),freshToken=value(fresh.beginTask('ai','A','reused-task'));
 assert.deepEqual({...oldToken},{...freshToken});
 error(fresh.commitAIResult(oldToken,{kind:'pass',actor:'A'}),'STALE_TASK');
 error(fresh.commitAIResult(JSON.parse(JSON.stringify(freshToken)),{kind:'pass',actor:'A'}),'STALE_TASK');
 value(fresh.commitAIResult(freshToken,{kind:'pass',actor:'A'}));assert.equal(fresh.state.match.state.ply,1);
});
