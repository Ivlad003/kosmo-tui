const inspector = require('node:inspector');
const s = new inspector.Session(); s.connect();
const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => e ? rej(e) : res(r)));
let sid;
s.on('Debugger.scriptParsed', (e) => { if (e.params.url.endsWith('target.cjs')) sid = e.params.scriptId; });
(async () => {
  await post('Debugger.enable');
  require('./target.cjs');
  // CJS wrapper does not shift lines in node >= 12 (wrapper on same line)? print
  for (const [line, col] of [[0, 0], [0, 6], [0, 15], [0, 21], [0, 31], [1,0], [4,0], [4,15], [4,17]]) {
    const r = await post('Debugger.getPossibleBreakpoints', { start: { scriptId: sid, lineNumber: line, columnNumber: col }, restrictToFunction: true });
    console.log(line, col, JSON.stringify(r.locations.map(l => [l.lineNumber, l.columnNumber, l.type || ''])));
  }
  // duplicate breakpoint test
  const {hash} = await new Promise(r=>r({}));
  const src = await post('Debugger.getScriptSource',{scriptId:sid});
  const p1 = await post('Debugger.setBreakpoint', {location:{scriptId:sid,lineNumber:1,columnNumber:12}, condition:'false'}).catch(e=>'ERR '+e.message);
  const p2 = await post('Debugger.setBreakpoint', {location:{scriptId:sid,lineNumber:1,columnNumber:12}, condition:'1===2'}).catch(e=>'ERR '+e.message);
  console.log('setBreakpoint x2', JSON.stringify(p1), JSON.stringify(p2));
})();
