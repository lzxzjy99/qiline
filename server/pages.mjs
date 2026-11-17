import {roomsFetch} from './rooms.mjs';

export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname.startsWith('/api/rooms'))return roomsFetch(request,env);
 return env.ASSETS.fetch(request);
}};
