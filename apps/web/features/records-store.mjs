export async function openRecords(){
 return new Promise((resolve,reject)=>{
  const r=indexedDB.open('qiline-test-records',1);r.onupgradeneeded=()=>r.result.createObjectStore('games',{keyPath:'id'});
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('浏览器未能打开记录库。文件仍可临时回放。'));
 });
}
export function readAll(db){return new Promise((resolve,reject)=>{const r=db.transaction('games').objectStore('games').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export function saveAll(db,games){return new Promise((resolve,reject)=>{const t=db.transaction('games','readwrite');for(const g of games)t.objectStore('games').put(g);t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});}
export function removeRecord(db,id){return new Promise((resolve,reject)=>{const t=db.transaction('games','readwrite');t.objectStore('games').delete(id);t.oncomplete=resolve;t.onerror=()=>reject(t.error);});}
