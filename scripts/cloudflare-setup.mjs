import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const config='wrangler.cloudflare.json';
const current=JSON.parse(readFileSync(config,'utf8'));
if(current.d1_databases?.some(x=>x.binding==='DB'&&x.database_id)){
 console.log('Cloudflare D1 已配置，沿用现有数据库。');
}else{
 const r=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','create',current.name,'--config',config,'--binding','DB','--update-config'],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 if(r.status!==0)process.exit(r.status??1);
 const saved=JSON.parse(readFileSync(config,'utf8'));
 if(!saved.d1_databases?.some(x=>x.binding==='DB'&&x.database_id))throw Error('数据库已创建但配置尚未写入，请保留终端返回的数据库ID，勿重复创建。');
 console.log('D1 已创建并写入配置。请保存配置到 GitHub；下次发布会沿用同一数据库。');
}
const saved=JSON.parse(readFileSync(config,'utf8'));
saved.d1_databases=saved.d1_databases.map(x=>x.binding==='DB'?{...x,migrations_dir:'drizzle'}:x);
writeFileSync(config,JSON.stringify(saved,null,2)+'\n');
