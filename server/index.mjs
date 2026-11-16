import assets from './assets.generated.mjs';
import {roomsFetch} from './rooms.mjs';
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname.startsWith('/api/rooms'))return roomsFetch(request,env);
 if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
 const pathname=url.pathname==='/'?'/index.html':url.pathname,item=assets[pathname];
 if(!item)return new Response('页面不存在',{status:404,headers:{'content-type':'text/plain;charset=utf-8'}});
 const headers={'content-type':item.type,'cache-control':'public,max-age=0,must-revalidate','etag':item.etag,'x-content-type-options':'nosniff'};
 if(request.headers.get('if-none-match')===item.etag)return new Response(null,{status:304,headers});
 const body=request.method==='HEAD'?null:Uint8Array.from(atob(item.body),c=>c.charCodeAt(0));
 return new Response(body,{headers});
}};
