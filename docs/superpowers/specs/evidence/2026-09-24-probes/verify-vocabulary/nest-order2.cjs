// Throwaway: Nest 11.2.5 enhancer order, param pipe order, filter, retry under an interceptor.
const C = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/";
require(C + "reflect-metadata");
const common = require(C + "@nestjs/common");
const { NestFactory } = require(C + "@nestjs/core");
const { tap, retry } = require(C + "rxjs");
const { Module, Controller, Get, UseGuards, UseInterceptors, UsePipes, UseFilters, Param, Catch, ForbiddenException } = common;
const log = [];
const guard = (n, ok = true) => class { canActivate() { log.push("guard:" + n); return ok; } };
const icpt = (n, extra) => class { intercept(ctx, next) { log.push("icpt:" + n + ":pre"); let o = next.handle(); if (extra) o = o.pipe(extra); return o.pipe(tap({ next: () => log.push("icpt:" + n + ":post"), error: () => log.push("icpt:" + n + ":error") })); } };
const pipe = (n) => class { transform(v, m) { log.push("pipe:" + n + ":" + m.type + ":" + (m.data ?? "")); return v; } };
const filter = (n) => { const F = class { catch(e, host) { log.push("filter:" + n); host.switchToHttp().getResponse().status(e.getStatus ? e.getStatus() : 500).json({ f: n }); } }; Catch()(F); return F; };
let calls = 0;
class Ctl {
  get(a, b) { log.push("handler"); return { a, b }; }
  flaky() { log.push("handler:flaky#" + (++calls)); if (calls === 1) throw new Error("first"); return { ok: calls }; }
  deny() { log.push("handler:deny"); return {}; }
}
const m = (name, decs) => { const d = Object.getOwnPropertyDescriptor(Ctl.prototype, name); for (const dec of decs) dec(Ctl.prototype, name, d); Object.defineProperty(Ctl.prototype, name, d); };
Reflect.defineMetadata("design:paramtypes", [String, String], Ctl.prototype, "get");
m("get", [Get("x/:a/:b"), UseGuards(new (guard("route"))()), UseInterceptors(new (icpt("route"))()), UsePipes(new (pipe("route"))()), UseFilters(new (filter("route"))())]);
Param("a", new (pipe("param-a"))())(Ctl.prototype, "get", 0);
Param("b", new (pipe("param-b"))())(Ctl.prototype, "get", 1);
m("flaky", [Get("flaky"), UseInterceptors(new (icpt("retry", retry(1)))())]);
m("deny", [Get("deny"), UseGuards(new (guard("route-deny", false))())]);
Controller("t")(Ctl); UseGuards(new (guard("controller"))())(Ctl); UseInterceptors(new (icpt("controller"))())(Ctl); UsePipes(new (pipe("controller"))())(Ctl); UseFilters(new (filter("controller"))())(Ctl);
class AppModule {}
Module({ controllers: [Ctl] })(AppModule);
(async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(function expressMw(req, res, next) { log.push("app.use(expressMw)"); next(); });
  app.useGlobalGuards(new (guard("global"))()); app.useGlobalInterceptors(new (icpt("global"))()); app.useGlobalPipes(new (pipe("global"))()); app.useGlobalFilters(new (filter("global"))());
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  for (const p of ["/t/x/1/2", "/t/flaky", "/t/deny"]) {
    log.length = 0; const r = await fetch(url.replace("[::1]", "127.0.0.1") + p);
    console.log(p, r.status, await r.text()); console.log("  " + log.join("\n  "));
  }
  await app.close();
})();
