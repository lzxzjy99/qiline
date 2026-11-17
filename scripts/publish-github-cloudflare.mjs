import {spawnSync,execFileSync} from 'node:child_process';
function run(file,args){
 const r=spawnSync(file,args,{stdio:'inherit'});
 if(r.status!==0)process.exit(r.status??1);
}
run(process.execPath,['scripts/build-hosted.mjs']);
run(process.execPath,['scripts/check-web.mjs']);
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('请先提交本次源码变更，再同步发布，以保证GitHub与网站来自同一版本。');
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
run('git',['push','https://github.com/lzxzjy99/qiline.git','HEAD:main']);
run(process.execPath,['scripts/cloudflare-deploy.mjs']);
console.log(`GitHub与Cloudflare已同步发布，源码提交：${commit}`);
