'use strict';
let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{
  process.stdout.write(JSON.stringify({continue:false,stopReason:'host should stop here'})+String.fromCharCode(10));
});
