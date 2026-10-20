// Deliberately uncooperative CPU load, isolated from the product bundle.
postMessage({protocolVersion:1,kind:'ready'});
onmessage=()=>{while(true){/* Only Worker.terminate() can stop this task. */}};
