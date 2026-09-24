let ticks = 0; setInterval(() => ticks++, 10);
setInterval(() => console.log("TICKS " + ticks), 100);
console.log("READY " + process.pid);
