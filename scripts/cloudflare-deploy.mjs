import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const config='wrangler.cloudflare.json',data=JSON.parse(readFileSync(config,'utf8'));
if(!data.d1_databases?.some(x=>x.binding==='DB'&&x.database_id))throw Error('请先运行 npm run cloudflare:setup 创建并绑定在线对战数据库。');
function run(args){
 const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:'inherit',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
 if(r.status!==0)process.exit(r.status??1);
}
run(['d1','migrations','apply','DB','--remote','--config',config]);
run(['deploy','--config',config,'--keep-vars','--autoconfig=false']);
