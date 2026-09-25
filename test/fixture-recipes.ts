/**
 * Builder recipes for every committed fixture under test/fixtures/kosmo-trace/ and
 * test/fixtures/frameworks/ (spec 13.1). test/format/fixtures.test.ts proves that each
 * recipe builds exactly the committed file, so tests may use either form.
 */
import { fileURLToPath } from "node:url";
import { dataset, masked, notRecorded, recorded, truncated, type RawDocument } from "./trace-builder.js";

const node = { runtime: "node" } as const;
const browser = { runtime: "browser" } as const;

function http(method: string, route: string, status?: number): Record<string, string | number> {
  return {
    "http.request.method": method,
    "http.route": route,
    ...(status !== undefined ? { "http.response.status_code": status } : {})
  };
}

function numberedAttrs(prefix: string, count: number, value: (index: number) => string | number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`${prefix}${String(index + 1).padStart(2, "0")}`, value(index)])
  );
}

export const RECIPES: Readonly<Record<string, () => RawDocument>> = {
  "kosmo-trace/basic": () =>
    dataset("ds_basic", {
      producer: { name: "kosmo-tui-fixtures", version: "1.0.0" },
      createdAt: "2026-09-24T10:00:00Z",
      title: "checkout bug repro"
    })
      .trace("t_cart", "GET /cart")
      .span("sp_1", "GET /cart", {
        kind: "http.server",
        status: "errored",
        durationMs: 14.2,
        ...node,
        location: { file: "src/server.ts", line: 10, column: 1 },
        area: { module: "src/server", feature: "cart" },
        attrs: http("GET", "/cart", 500)
      })
      .span("sp_2", "loadCart", {
        parent: "sp_1",
        durationMs: 3.1,
        ...node,
        location: { file: "src/cart.ts", line: 3 },
        area: { module: "src/cart", feature: "cart" },
        args: recorded(["u_42"]),
        return: recorded({ items: [{ id: 7, qty: 2 }] })
      })
      .span("sp_3", "calculateLineTotal", {
        parent: "sp_1",
        status: "errored",
        durationMs: 1.8,
        ...node,
        location: {
          file: "src/cart.ts",
          line: 12,
          column: 3,
          endLine: 20,
          snippet: "export async function calculateLineTotal(item, qty) {"
        },
        area: { module: "src/cart", feature: "cart" },
        attrs: { "code.function": "calculateLineTotal" },
        args: recorded([{ id: 7 }, 2]),
        return: notRecorded("threw"),
        error: recorded({ name: "RangeError", message: "discount > 100%" })
      })
      .span("sp_4", "price", {
        parent: "sp_3",
        durationMs: 0.4,
        ...node,
        location: { file: "src/pricing.ts", line: 5 },
        args: recorded([7]),
        return: recorded(12.5)
      })
      .build(),

  "kosmo-trace/multi-session": () =>
    dataset("ds_multi", { producer: { name: "kosmo-tui-fixtures" } })
      .trace("t_checkout", "checkout click")
      .session("browser")
      .span("b1", "onCheckoutClick", { ...browser, location: { file: "app/components/Checkout.tsx", line: 21 } })
      .span("b2", "fetch /api/checkout", {
        parent: "b1",
        kind: "http.client",
        ...browser,
        location: { file: "app/lib/api.ts", line: 8 },
        attrs: { "http.request.method": "POST" }
      })
      .span("x1", "hydrateCart", { parent: "b1", ...browser })
      .session("node")
      // parent "b2" is not in session node: exactly one other session has it (spec 4.3 rule 3.2)
      .span("n1", "POST /api/checkout", {
        parent: "b2",
        kind: "http.server",
        ...node,
        location: { file: "server/routes/checkout.ts", line: 4 },
        attrs: http("POST", "/api/checkout", 201)
      })
      // the same id "x1" as in session browser: a different span (full identity is the triple)
      .span("x1", "validateCart", { parent: "n1", ...node, location: { file: "server/cart/validate.ts", line: 2 } })
      // resolves to node's x1 (rule 3.1), never to browser's x1
      .span("n2", "createOrder", { parent: "x1", ...node, location: { file: "server/orders/create.ts", line: 9 } })
      .span("n3", "notifyBrowser", { parent: "b1", parentSession: "browser", ...node })
      .trace("t_health", "GET /health")
      .span("h1", "GET /health", { kind: "http.server", ...node, attrs: http("GET", "/health", 200) })
      .inTrace("t_orphan")
      .span("o1", "backgroundJob", { status: "running", ...node })
      .build(),

  "kosmo-trace/parents-unknown": () =>
    dataset("ds_parents")
      .trace("t_parents", "parent resolution")
      .span("r1", "root")
      .span("m1", "missingParent", { parent: "ghost" })
      .span("a1", "ambiguousParent", { parent: "dup" })
      .span("ps1", "explicitMissing", { parent: "r1", parentSession: "s9" })
      .span("ps3", "explicitSameSession", { parent: "r1", parentSession: "s1" })
      .session("s2")
      .span("dup", "dupInS2")
      .span("ps2", "explicitOtherSession", { parent: "r1", parentSession: "s1" })
      .span("ps4", "explicitNoFallback", { parent: "dup", parentSession: "s1" })
      .span("ps5", "explicitOwnSessionMissing", { parent: "r1", parentSession: "s2" })
      .span("c1", "childOfMissing", { parent: "m1", parentSession: "s1" })
      .session("s3")
      .span("dup", "dupInS3")
      .build(),

  "kosmo-trace/cycles": () =>
    dataset("ds_cycles")
      .trace("t_cycles", "cycles")
      .span("n0", "realRoot", { order: 0 })
      .span("c1", "cycleA", { parent: "c2", order: 5 })
      .span("c2", "cycleB", { parent: "c1", order: 3 })
      .span("d1", "hangsOffCycle", { parent: "c1", order: 6 })
      .span("self1", "selfParent", { parent: "self1", order: 7 })
      .span("k2", "ringB", { parent: "k1", order: 10 })
      .span("k3", "ringC", { parent: "k2", order: 11 })
      .session("s2")
      .span("k1", "ringA", { parent: "k3", order: 0 })
      .build(),

  "kosmo-trace/statuses-values": () =>
    dataset("ds_status")
      .trace("t_status", "all statuses and values")
      .span("st_complete", "completeCall", { args: recorded(null), return: recorded({ $type: "undefined" }) })
      .span("st_errored", "erroredCall", {
        parent: "st_complete",
        status: "errored",
        error: recorded({
          $type: "class",
          name: "RangeError",
          value: { name: "RangeError", message: "boom", stack: "RangeError: boom\n    at erroredCall (src/a.ts:3:9)" }
        })
      })
      .span("st_running", "runningCall", { parent: "st_complete", status: "running" })
      .span("st_suspended", "suspendedRender", {
        parent: "st_complete",
        kind: "react.render",
        status: "suspended",
        ...browser
      })
      .span("st_aborted", "GET /slow", {
        kind: "http.server",
        status: "unknown",
        statusReason: "aborted",
        attrs: { ...http("GET", "/slow"), "http.response.completion": "aborted" }
      })
      .span("st_unknown", "unknownCall", { status: "unknown" })
      .span("v_tags", "allTags", {
        parent: "st_complete",
        args: recorded([
          { $type: "undefined" },
          { $type: "number", value: "NaN" },
          { $type: "number", value: "Infinity" },
          { $type: "number", value: "-Infinity" },
          { $type: "number", value: "-0" },
          { $type: "bigint", value: "123456789012345678901234567890" },
          { $type: "function", name: "handler" },
          { $type: "symbol", description: "token" },
          { $type: "date", value: "2026-09-24T10:00:00.000Z" },
          {
            $type: "map",
            entries: [
              ["k", 1],
              [{ $type: "symbol", description: "s" }, { $type: "undefined" }]
            ]
          },
          { $type: "set", values: [1, "two"] },
          { $type: "class", name: "Cart", value: { items: 2 } },
          { $type: "class", name: "RegExp", value: { source: "^a+$", flags: "gi" } },
          { $type: "class", name: "Promise", value: { state: "pending" } },
          { $type: "class", name: "Buffer", value: { length: 16 } },
          { $type: "accessor", get: true, set: false },
          [1, { $type: "hole" }, 3],
          { $type: "cycle", path: "$.a.b" },
          { password: { $type: "masked" }, user: "ann" },
          { $type: "object", entries: { $type: "literal key", plain: 1 } }
        ])
      })
      .span("v_truncated", "truncatedValues", {
        parent: "st_complete",
        args: truncated([1, 2, { $type: "more", count: 120 }], "producer-cap"),
        return: truncated({ $type: "object", entries: { a: { $type: "deeper" } }, more: 7 }),
        error: truncated({ $type: "string-cut", value: "very long mess", length: 40000 })
      })
      .span("v_masked", "maskedValues", {
        parent: "st_complete",
        args: masked("policy"),
        return: masked(),
        error: notRecorded()
      })
      .span("v_not_recorded", "notRecordedValues", {
        parent: "st_complete",
        args: notRecorded("level"),
        return: notRecorded("threw")
      })
      .build(),

  "kosmo-trace/areas": () =>
    dataset("ds_areas")
      .trace("t_areas", "areas")
      .span("ar_explicit", "explicitBoth", {
        location: { file: "src/cart/total.ts", line: 4 },
        area: { module: "src/cart", feature: "cart" }
      })
      .span("ar_module", "explicitModule", {
        parent: "ar_explicit",
        location: { file: "src/cart/tax.ts", line: 1 },
        area: { module: "src/cart" }
      })
      .span("ar_feature", "explicitFeature", { parent: "ar_explicit", area: { feature: "checkout" } })
      .span("ar_empty", "emptyAreaObject", {
        parent: "ar_explicit",
        location: { file: "src/cart/index.ts", line: 2 },
        area: {}
      })
      .span("ar_derived", "derivedFromFile", {
        parent: "ar_explicit",
        status: "errored",
        location: { file: "src/cart/discount.ts", line: 9 }
      })
      .span("ar_rootfile", "rootFile", { parent: "ar_explicit", location: { file: "main.ts", line: 1 } })
      .span("ar_nm", "expressRouter", {
        parent: "ar_explicit",
        kind: "express.router",
        location: { file: "node_modules/express/lib/router/index.js", line: 280 }
      })
      .span("ar_scoped", "nestRouterExplorer", {
        parent: "ar_explicit",
        location: { file: "node_modules/@nestjs/core/router/router-explorer.js", line: 40 }
      })
      .span("ar_pnpm", "cors", {
        parent: "ar_explicit",
        kind: "express.middleware",
        location: { file: "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js", line: 188 }
      })
      .span("ar_unknown", "noLocationNoArea", { parent: "ar_explicit" })
      .build(),

  "kosmo-trace/links": () =>
    dataset("ds_links")
      .trace("t_links", "effect → fetch")
      .session("browser")
      .span("e1", "useCartEffect", {
        kind: "react.effect",
        ...browser,
        attrs: { "react.effect.type": "passive", "react.effect.phase": "setup" }
      })
      .span("f1", "fetch /api/cart", { kind: "http.client", ...browser, attrs: { "http.request.method": "GET" } })
      .span("f2", "fetch /api/prices", { kind: "http.client", ...browser })
      .link("f1", "e1", "caused-by")
      .link("f2", "f1", "follows-from")
      .link("f2", "gone", "caused-by")
      .trace("t_links_server", "GET /api/cart")
      .session("node")
      .span("srv1", "GET /api/cart", { kind: "http.server", ...node, attrs: http("GET", "/api/cart", 200) })
      .link("srv1", { trace: "t_links", session: "browser", id: "f1" }, "caused-by")
      .build(),

  "frameworks/express-chain": () =>
    dataset("ds_express", { producer: { name: "kosmo-express-recorder", version: "0.1.0" } })
      .trace("t_express", "orders API")
      .span("req1", "GET /api/orders/:id", {
        kind: "http.server",
        status: "errored",
        durationMs: 9.5,
        ...node,
        attrs: { ...http("GET", "/api/orders/:id", 500), "http.response.completion": "finish" }
      })
      .span("router1", "router", {
        parent: "req1",
        kind: "express.router",
        ...node,
        location: { file: "src/app.ts", line: 12 },
        attrs: { "express.mount_path": "/api" }
      })
      .span("mw_cors", "corsMiddleware", {
        parent: "router1",
        kind: "express.middleware",
        durationMs: 0.2,
        ...node,
        location: { file: "node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js", line: 188 },
        attrs: { "express.handoff": "next" }
      })
      .span("mw_json", "jsonParser", {
        parent: "router1",
        kind: "express.middleware",
        durationMs: 0.6,
        ...node,
        location: { file: "node_modules/body-parser/lib/types/json.js", line: 101 },
        attrs: { "express.handoff": "next" }
      })
      .span("h_get", "getOrder", {
        parent: "router1",
        kind: "express.handler",
        status: "errored",
        durationMs: 4.1,
        ...node,
        location: { file: "src/routes/orders.ts", line: 14, snippet: 'router.get("/:id", async (req, res, next) => {' },
        area: { module: "src/routes", feature: "orders" },
        attrs: { "express.handoff": "next-error" },
        args: recorded([{ params: { id: "42" } }]),
        error: recorded({
          $type: "class",
          name: "Error",
          value: { name: "Error", message: "order 42 not found in cache" }
        })
      })
      .span("eh", "errorHandler", {
        parent: "router1",
        kind: "express.error-handler",
        durationMs: 0.3,
        ...node,
        location: { file: "src/middleware/errors.ts", line: 5 },
        area: { module: "src/middleware", feature: "orders" },
        attrs: { "express.handoff": "response", "error.type": "Error" }
      })
      .span("req2", "POST /api/orders", {
        kind: "http.server",
        status: "running",
        ...node,
        attrs: http("POST", "/api/orders")
      })
      .span("router2", "router", {
        parent: "req2",
        kind: "express.router",
        status: "running",
        ...node,
        location: { file: "src/app.ts", line: 12 },
        attrs: { "express.mount_path": "/api" }
      })
      .span("mw_auth", "authenticate", {
        parent: "router2",
        kind: "express.middleware",
        status: "running",
        ...node,
        location: { file: "src/middleware/auth.ts", line: 3 },
        area: { module: "src/middleware", feature: "auth" }
      })
      .build(),

  "frameworks/nest-pipeline": () =>
    dataset("ds_nest", { producer: { name: "kosmo-nest-recorder", version: "0.1.0" } })
      .trace("t_nest", "nest pipeline")
      .span("r1", "GET /orders/:id", {
        kind: "http.server",
        durationMs: 6.2,
        ...node,
        attrs: http("GET", "/orders/:id", 200)
      })
      .span("r1_helmet", "helmet", {
        parent: "r1",
        kind: "express.middleware",
        ...node,
        location: { file: "node_modules/helmet/index.cjs", line: 530 },
        attrs: { "express.handoff": "next" }
      })
      .span("r1_logger", "LoggerMiddleware.use", {
        parent: "r1",
        kind: "nest.middleware",
        ...node,
        location: { file: "src/common/logger.middleware.ts", line: 6 },
        attrs: { "express.handoff": "next" }
      })
      .span("r1_guard", "AuthGuard.canActivate", {
        parent: "r1",
        kind: "nest.guard",
        ...node,
        location: { file: "src/auth/auth.guard.ts", line: 9 },
        attrs: { "nest.binding": "global" },
        return: recorded(true)
      })
      .span("r1_icpt", "LoggingInterceptor.intercept", {
        parent: "r1",
        kind: "nest.interceptor",
        ...node,
        location: { file: "src/common/logging.interceptor.ts", line: 11 },
        attrs: { "nest.binding": "controller" }
      })
      .span("r1_pipe", "ParseIntPipe.transform", {
        parent: "r1_icpt",
        kind: "nest.pipe",
        ...node,
        location: { file: "node_modules/@nestjs/common/pipes/parse-int.pipe.js", line: 58 },
        attrs: { "nest.binding": "param", "nest.pipe.arg_type": "param", "nest.pipe.arg_data": "id" },
        args: recorded(["42"]),
        return: recorded(42)
      })
      .span("r1_handler", "OrdersController.findOne", {
        parent: "r1_icpt",
        kind: "nest.handler",
        ...node,
        location: { file: "src/orders/orders.controller.ts", line: 18 },
        area: { module: "src/orders", feature: "orders" },
        attrs: { "nest.handler": "OrdersController.findOne" },
        args: recorded([42]),
        return: recorded({ id: 42, total: 99.5 })
      })
      .span("r2", "GET /admin/stats", { kind: "http.server", ...node, attrs: http("GET", "/admin/stats", 403) })
      .span("r2_guard", "RolesGuard.canActivate", {
        parent: "r2",
        kind: "nest.guard",
        ...node,
        location: { file: "src/auth/roles.guard.ts", line: 14 },
        attrs: { "nest.binding": "method" },
        return: recorded(false)
      })
      .span("r2_filter", "HttpExceptionFilter.catch", {
        parent: "r2",
        kind: "nest.filter",
        ...node,
        location: { file: "src/common/http-exception.filter.ts", line: 8 },
        args: recorded([
          {
            $type: "class",
            name: "ForbiddenException",
            value: { name: "ForbiddenException", message: "Forbidden resource" }
          }
        ])
      })
      .span("r3", "POST /orders", { kind: "http.server", ...node, attrs: http("POST", "/orders", 400) })
      .span("r3_pipe", "ValidationPipe.transform", {
        parent: "r3",
        kind: "nest.pipe",
        status: "errored",
        ...node,
        location: { file: "node_modules/@nestjs/common/pipes/validation.pipe.js", line: 74 },
        attrs: { "nest.binding": "global", "nest.pipe.arg_type": "body" },
        args: recorded([{ qty: -1 }]),
        error: recorded({
          $type: "class",
          name: "BadRequestException",
          value: { name: "BadRequestException", message: "qty must be a positive number" }
        })
      })
      .span("r3_filter", "HttpExceptionFilter.catch", {
        parent: "r3",
        kind: "nest.filter",
        ...node,
        location: { file: "src/common/http-exception.filter.ts", line: 8 }
      })
      .build(),

  "frameworks/react-strict": () =>
    dataset("ds_react", { producer: { name: "kosmo-react-recorder", version: "0.1.0" } })
      .trace("t_react", "cart page render")
      .session("browser")
      .span("rd_app", "App", { kind: "react.render", ...browser, location: { file: "src/App.tsx", line: 5 } })
      .span("rd_cart", "CartView", {
        parent: "rd_app",
        kind: "react.render",
        ...browser,
        location: { file: "src/cart/CartView.tsx", line: 12 },
        area: { module: "src/cart", feature: "cart" },
        args: recorded([{ items: 2 }])
      })
      .span("rd_cart_dup", "CartView", {
        parent: "rd_app",
        kind: "react.render",
        ...browser,
        location: { file: "src/cart/CartView.tsx", line: 12 },
        area: { module: "src/cart", feature: "cart" },
        attrs: { "react.strict_mode.duplicate": true },
        args: recorded([{ items: 2 }])
      })
      .span("ef_setup1", "useCartSync", {
        parent: "rd_cart",
        kind: "react.effect",
        ...browser,
        location: { file: "src/cart/useCartSync.ts", line: 7 },
        attrs: { "react.effect.type": "passive", "react.effect.phase": "setup" }
      })
      .span("ef_cleanup", "useCartSync", {
        parent: "rd_cart",
        kind: "react.effect",
        ...browser,
        location: { file: "src/cart/useCartSync.ts", line: 7 },
        attrs: { "react.effect.type": "passive", "react.effect.phase": "cleanup", "react.strict_mode.duplicate": true }
      })
      .span("ef_setup2", "useCartSync", {
        parent: "rd_cart",
        kind: "react.effect",
        ...browser,
        location: { file: "src/cart/useCartSync.ts", line: 7 },
        attrs: { "react.effect.type": "passive", "react.effect.phase": "setup", "react.strict_mode.duplicate": true }
      })
      .span("rd_list", "ProductList", {
        parent: "rd_app",
        kind: "react.render",
        status: "suspended",
        statusReason: "SuspenseException",
        ...browser,
        location: { file: "src/products/ProductList.tsx", line: 20 }
      })
      .span("ef_layout", "useMeasure", {
        parent: "rd_app",
        kind: "react.effect",
        ...browser,
        location: { file: "src/hooks/useMeasure.ts", line: 3 },
        attrs: { "react.effect.type": "layout", "react.effect.phase": "setup" }
      })
      .build(),

  "frameworks/next-action": () =>
    dataset("ds_next", { producer: { name: "kosmo-next-recorder", version: "0.1.0" } })
      .trace("t_next_action", "add to cart (next dev)")
      .session("browser")
      .span("b1", "onSubmit", { ...browser, location: { file: "app/cart/AddToCart.tsx", line: 14 } })
      .span("b2", "addToCart", {
        parent: "b1",
        kind: "next.server-action",
        ...browser,
        location: { file: "app/cart/actions.ts", line: 3 },
        attrs: { "next.action.id": "7f3a9c" }
      })
      .session("node")
      .span("n1", "POST /cart", {
        parent: "b2",
        parentSession: "browser",
        kind: "http.server",
        ...node,
        attrs: { ...http("POST", "/cart", 200), "next.request.type": "action" }
      })
      .span("n_mw", "middleware", {
        parent: "n1",
        kind: "next.middleware",
        runtime: "edge",
        location: { file: "middleware.ts", line: 4 }
      })
      .span("n2", "addToCart", {
        parent: "n1",
        kind: "next.server-action",
        ...node,
        location: { file: "app/cart/actions.ts", line: 3 },
        attrs: { "next.action.id": "7f3a9c" },
        args: recorded([{ productId: "p1", qty: 1 }]),
        return: recorded({ ok: true })
      })
      .span("n3", "render /cart", {
        parent: "n1",
        kind: "next.render",
        ...node,
        location: { file: "app/cart/page.tsx", line: 1 }
      })
      .trace("t_next_deployed", "GET /products (deployed edge)")
      .session("edge")
      .span("e1", "middleware", {
        kind: "next.middleware",
        runtime: "edge",
        location: { file: "middleware.ts", line: 4 }
      })
      .session("node")
      .span("n4", "GET /products", {
        parent: "e1",
        parentSession: "edge",
        kind: "http.server",
        ...node,
        attrs: { ...http("GET", "/products", 200), "next.request.type": "document" }
      })
      .span("n5", "render /products", {
        parent: "n4",
        kind: "next.render",
        ...node,
        location: { file: "app/products/page.tsx", line: 1 }
      })
      .span("n6", "GET /api/products", {
        parent: "n4",
        kind: "next.route-handler",
        ...node,
        location: { file: "app/api/products/route.ts", line: 5 }
      })
      .build(),

  "frameworks/attrs-hostile": () =>
    dataset("ds_attrs")
      .trace("t_attrs", "hostile attrs")
      .span("at_mixed", "mixedAttrs", {
        attrs: {
          "Bad Key": "x",
          "ok.first": "kept",
          "null.value": null,
          "array.value": [1, 2],
          "object.value": { a: 1 },
          "long.value": "x".repeat(513),
          "http.request.header.authorization": "Bearer abc.def",
          "c1.value": "\u009b31mred",
          "bidi.value": "\u202eevil.txt",
          "esc.value": "\u001b]8;;file:///etc/passwd\u0007x"
        }
      })
      .span("at_many", "thirtyThreeKeys", { attrs: numberedAttrs("attr.k", 33, (index) => index + 1) })
      .span("at_not_object", "attrsNotObject", { attrs: "oops" })
      .span("at_bytes", "overEightKiB", { attrs: numberedAttrs("blob.k", 17, () => "y".repeat(500)) })
      .span("at_long_key", "longKey", { attrs: { ["a".repeat(129)]: 1, "ok.second": true } })
      .build()
};

export const FIXTURE_NAMES: readonly string[] = Object.keys(RECIPES);

/** Absolute path of a committed fixture, e.g. fixtureFile("kosmo-trace/basic"). */
export function fixtureFile(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}.kosmo-trace.json`, import.meta.url));
}
