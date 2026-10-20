import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join,dirname,relative,isAbsolute,sep} from 'node:path';
import {tmpdir} from 'node:os';

// Native fallback for a Windows runtime without Bash. Reuse Sites' build validator.
const [prepareHelper,archiveArg]=process.argv.slice(2);
if(!prepareHelper||!archiveArg)throw Error('Expected Sites prepare-site-build.cjs and an archive path.');
const root=realpathSync('.'),archive=resolve(archiveArg);
const stage=mkdtempSync(join(tmpdir(),'qiline-site-'));
const inside=relative(realpathSync(tmpdir()),realpathSync(stage));
if(!inside||inside==='..'||inside.startsWith('..'+sep)||isAbsolute(inside))throw Error('Invalid staging path.');
function run(command,args){
  const result=spawnSync(command,args,{encoding:'utf8'});
  if(result.error||result.status!==0)throw Error(result.stderr||result.error?.message||'Packaging failed.');
  return result.stdout.trim();
}
try{
  const source=JSON.parse(readFileSync('.openai/hosting.json','utf8'));
  if(source.project_id!=='appgprj_6ad6f590bd4881919921299fa305f236'||source.static?.directory!=='dist')throw Error('Unexpected site or build kind.');
  if(run(process.execPath,[resolve(prepareHelper),root,join(stage,'dist')])!=='static')throw Error('Expected static output.');
  const configDir=join(stage,'dist','.openai');mkdirSync(configDir,{recursive:true});
  writeFileSync(join(configDir,'hosting.json'),JSON.stringify(source,null,2)+'\n');
  mkdirSync(dirname(archive),{recursive:true});
  run('tar',['-C',stage,'-czf',archive,'dist']);
  const entries=run('tar',['-tzf',archive]).split(/\r?\n/);
  if(!entries.includes('dist/.openai/hosting.json')||!entries.includes('dist/index.html'))throw Error('Incomplete archive.');
  console.log(JSON.stringify({archive,files:entries.length,static:true}));
}finally{
  // The absolute staging target was verified to be a newly created temp child above.
  rmSync(stage,{recursive:true,force:true});
}
