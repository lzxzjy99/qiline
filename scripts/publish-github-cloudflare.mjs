import {spawnSync,execFileSync} from 'node:child_process';
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('请先提交本次源码变更，再同步发布，以保证GitHub与网站来自同一版本。');
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const result=spawnSync('git',['push','https://github.com/lzxzjy99/qiline.git','HEAD:main'],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
console.log(`已推送源码提交：${commit}。Cloudflare将自动检查、构建和发布，请以控制台构建结果为准。`);
