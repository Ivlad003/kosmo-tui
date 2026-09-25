# kosmo-tui без kosmo-callflow: власний формат трейсу і live-дебагер

- Дата: 2026-09-24
- Статус: чернетка v3 на рев'ю. Внесено знахідки самоперевірки v1 (чотири боки) і дослідження
  фреймворків (Next, Express, Nest, React у браузері, словник kind'ів)
- Гілка: `design/standalone-kosmo-trace`

## 1. Мета

kosmo-tui стає самостійним терміналом для перегляду трейсів викликів. Він не залежить від коду
kosmo-callflow: немає жодного пакета `@kosmo-callflow/*`, tarball-посилання на сусідній checkout чи
API daemon'а. Формат даних kosmo-tui визначає сам (`kosmo-trace/v1`). Будь-який продюсер, а згодом і
kosmo-callflow через конвертер, записує трейси в цей формат.

Головне питання, на яке має відповідати інструмент: **до якої логіки і до якого шматка коду
належить кожен виклик**. Тому span несе точне місце в коді, фрагмент коду видно прямо в терміналі,
виклики групуються за модулями й фічами, а виклики фреймворків (middleware Express, enhancer'и Nest,
render/effect React, server/client-межа Next) мають зрозумілі назви.

Етап 2 додає live-дебагер для Node: kosmo-tui під'єднується до Node Inspector запущеного процесу,
ставить tracepoint (без зупинки) або breakpoint (з паузою) у місці вибраного span'а і показує живі
значення поруч із записаними. Етап 3 робить те саме для коду React у браузері.

Цільові фреймворки: Node.js, Express, NestJS, Next.js, React.

### Критерії успіху

1. `npm ci && npm test` проходить у CI-job'і без сусіднього checkout'а kosmo-callflow, зі
   згенерованим заново `package-lock.json`. `grep -rn kosmo-callflow src test .github
package.json package-lock.json` нічого не знаходить.
2. `kosmo-tui ./x.kosmo-trace.json`, `kosmo-tui ./x.kosmo-trace.sqlite` і `producer | kosmo-tui -`
   відкривають трейс у форматі `kosmo-trace/v1`.
3. Для вибраного span'а detail-панель показує `file:line`, область (module/feature) і фрагмент коду
   з диска. Підсвічений рядок видно навіть у терміналі 80×24.
4. `kosmo-tui` без аргументів відкриває стартовий екран зі списком трейсів.
5. Етап 2, перевірка на `storefront-next-template@1a5b952b` (Node ≥ 24):
   - **5a (обов'язково):** tracepoint на loader'і `src/routes/_app.cart.tsx:116` (route без
     `<UITarget>`) дає хіти зі шляхом виклику і значеннями. За весь час — 0 подій `Debugger.paused`.
     В інтеграційному тесті найбільший проміжок між тіками процесу-джерела ≤ 50 мс.
   - **5b (обов'язково):** tracepoint на loader'і `src/routes/_app.product.$productId.tsx:137` (файл із
     `<UITarget>`, карта недостовірна) має статус `re-anchored` і дає хіти саме на цьому рядку. Хіт на
     іншому рядку неприпустимий за жодних умов. `failed(map-mismatch)` — лише запобіжник, а не
     проходження критерію. Якщо 5b виконати не вдається, це окреме рішення про обсяг, яке ухвалює
     користувач; критерій тихо не переписується.
6. Етап 3: tracepoint на обробнику кліку React-компонента в браузері (Vite + React), запущеному
   kosmo-tui, дає хіти зі шляхом і props. За весь час — 0 подій `Debugger.paused` будь-якої причини, а
   найбільший проміжок головного потоку сторінки при інтервалі 10 мс ≤ 50 мс.
7. Для кожного з Node.js, Express, NestJS, Next.js і React (Vite, React Router 7, клієнт Next) у
   `test/apps/` є тестовий застосунок. Інтеграційні тести дебагера на ньому проходять у CI: `node` і
   `browser-basic` — в основному job'і, решта — в job'і фреймворків (13.6).

## 2. Журнал рішень

| #   | Рішення                 | Обране                                                                                                                                                                                                                                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Що означає «незалежний» | Не залежить від коду callflow взагалі                                                                                                                                                                                                                                                                 |
| D2  | Хто володіє форматом    | kosmo-tui (власний формат). Конвертер callflow → kosmo-trace буде пізніше, не в цьому обсязі                                                                                                                                                                                                          |
| D3  | Джерела даних           | JSON-файл, NDJSON (файл або stdin), власний SQLite-формат                                                                                                                                                                                                                                             |
| D4  | Обсяг функцій v1        | Мінімум: перегляд, навігація, print, sanitize                                                                                                                                                                                                                                                         |
| D5  | Стратегія міграції      | Вирізати на місці з новим доменним ядром (не новий пакет, не адаптер старих типів)                                                                                                                                                                                                                    |
| D6  | Невикористаний код      | Видаляємо (лишається в git-історії)                                                                                                                                                                                                                                                                   |
| D7  | «Яка логіка і який код» | `file:line` + фрагмент коду в detail + області (module/feature)                                                                                                                                                                                                                                       |
| D8  | Дебагер                 | Власний CDP-клієнт (не vscode-js-debug)                                                                                                                                                                                                                                                               |
| D9  | Вибір target'а          | Інтерактивно в TUI (панель Targets), без CLI-прапорця `--attach`                                                                                                                                                                                                                                      |
| D10 | Клавіші дебагера        | `b` — tracepoint (без паузи), `B` — breakpoint (з паузою)                                                                                                                                                                                                                                             |
| D11 | Запуск без аргументів   | Стартовий екран зі знайденими і нещодавніми трейсами                                                                                                                                                                                                                                                  |
| D12 | Node                    | `engines` ≥ 22.13.0 (18 і 20 мають EOL; дає глобальний `WebSocket` і `node:sqlite` без прапорця)                                                                                                                                                                                                      |
| D13 | Етапи                   | Одна spec, три етапи в плані: ядро v1, дебагер Node, дебагер браузера                                                                                                                                                                                                                                 |
| D14 | Фреймворки              | Node.js, Express, NestJS, Next.js, React: словник `kind`/`attrs` у форматі, розпізнавання в discovery, тестовий застосунок на кожен                                                                                                                                                                   |
| D15 | React у браузері        | Так, окремий етап 3 через Chrome/Edge CDP                                                                                                                                                                                                                                                             |
| D16 | NDJSON                  | Читається до EOF, модель будується один раз. Інкрементального показу у v1 немає                                                                                                                                                                                                                       |
| D17 | Браузер для етапу 3     | kosmo-tui сам запускає Chrome/Edge/Chromium з `--remote-debugging-pipe` і тимчасовим профілем (mkdtemp 0700, видаляється при виході). Під'єднання до браузера, запущеного користувачем, — лише `:attach-browser` з перевірками 10.2. Ніколи `--remote-allow-origins`, ніколи профіль за замовчуванням |
| D18 | Кілька target'ів        | Одночасно не більше одного Node-target'а і одного браузера (один route-файл виконується і в SSR, і в клієнті). Вибір target'а для точки — за `runtime` span'а (10.7)                                                                                                                                  |
| D19 | Kind'и фреймворків      | `kind` — рядок з крапками `<framework>.<role>` (4.13), атрибути — за іменами OpenTelemetry                                                                                                                                                                                                            |

## 3. Поза обсягом

- Конвертер kosmo-callflow → `kosmo-trace/v1` і будь-яка сумісність зі старими форматами callflow
  (canonical v1/v2, portable export, NDJSON stream v2, SQLite store callflow).
- Запис трейсів (SDK/інструментування застосунків). kosmo-tui лише читає трейси і дебажить живі процеси.
- Live daemon, replay, compare/diff, review (findings/todos), eval (`:js`, `kosmo-tui eval`), SQL
  (`kosmo-tui sql`, `:sql`), depth mappings, probes/aggregates, static/import graph (`:callers --static`).
- Інкрементальний показ NDJSON до EOF.
- Worker threads і service workers як окремі debug-target'и. Discovery процесів на Windows: там
  лише перевірка портів 9229–9239 і `:attach`.
- DAP-сервер («дебаг записаного трейсу» у VS Code). Це можливий майбутній етап, і формат не повинен
  йому заважати: стабільні refs, 1-based locations, типізовані значення.
- Колапс повторів `×N` у текстовій проєкції, timeline, тривалості з годинника різних процесів.
- Збереження хітів tracepoint'ів у файл трейсу.
- Автоматичне «слідування» за перезапусками (watch-режими, перезапуск Next): лише ручний reattach.
- Групування хітів за запитом (кореляція guard → interceptor → pipe → handler в одному запиті).
- Евристики React: позначка «StrictMode replay», шлях компонентів з owner stacks, тихий канал
  хітів через `Runtime.addBinding` у браузері.
- Instrumentation-breakpoint'и (`setInstrumentationBreakpoint`) для першого запуску ліниво
  завантажених скриптів; перший рендер ловиться через `:reload-armed` (10.5).
- Пояснення кешу Next, diff'и hydration mismatch, граф модулів/DI Nest, kind'и Fastify/Koa.
- Chrome approval-mode remote debugging (chrome://inspect) для повсякденного профілю.

## 4. Формат `kosmo-trace/v1`

Формат — це snapshot уже зібраних span'ів, а не журнал подій enter/exit. Парування подій, маскування
під час запису і обрізання значень — робота продюсера. Viewer ніколи не вигадує даних, яких немає:
відсутнє значення має власний стан, невідомий батько лишається невідомим.

### 4.1 Документ (JSON)

```jsonc
{
  "format": "kosmo-trace",
  "version": 1,
  "dataset": {
    "id": "ds_01J…",
    "producer": { "name": "my-recorder", "version": "1.2.0" },
    "createdAt": "2026-09-24T10:00:00Z",
    "root": "/Users/me/app",
    "title": "checkout bug repro"
  },
  "traces": [{ "id": "t_9f", "name": "GET /cart" }],
  "spans": [
    {
      "trace": "t_9f",
      "session": "s1",
      "id": "sp_3",
      "parent": "sp_1",
      "order": 17,
      "name": "calculateLineTotal",
      "kind": "function",
      "status": "errored",
      "durationMs": 1.8,
      "runtime": "node",
      "location": {
        "file": "src/cart.ts",
        "line": 12,
        "column": 3,
        "endLine": 20,
        "snippet": "export async function calculateLineTotal(item, qty) {"
      },
      "area": { "module": "src/cart", "feature": "cart" },
      "attrs": { "code.function": "calculateLineTotal" },
      "args": { "state": "recorded", "value": [{ "id": 7 }, 2] },
      "return": { "state": "not-recorded", "reason": "threw" },
      "error": { "state": "recorded", "value": { "name": "RangeError", "message": "discount > 100%" } }
    }
  ],
  "links": [
    {
      "from": { "trace": "t_9f", "session": "s1", "id": "sp_9" },
      "to": { "trace": "t_9f", "session": "s1", "id": "sp_3" },
      "kind": "caused-by"
    }
  ]
}
```

Обов'язковість полів:

| Об'єкт     | Обов'язкові                                                                                 | Опційні                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Документ   | `format` (`"kosmo-trace"`), `version` (`1`), `dataset`, `spans` (масив, може бути порожнім) | `traces`, `links`                                                                                                        |
| `dataset`  | `id`                                                                                        | `producer {name, version?}`, `createdAt` (ISO 8601), `root`, `title`                                                     |
| trace      | `id`                                                                                        | `name`                                                                                                                   |
| span       | `trace`, `session`, `id`, `parent` (рядок або `null`), `order`, `name`, `status`            | `parentSession`, `kind`, `statusReason`, `durationMs`, `runtime`, `location`, `area`, `attrs`, `args`, `return`, `error` |
| `location` | `file`, `line`                                                                              | `column`, `endLine`, `snippet`, `snippetCut`                                                                             |
| `area`     | —                                                                                           | `module`, `feature` (об'єкт без обох полів вважається відсутнім)                                                         |
| link       | `from`, `to` (SpanRef: `trace`, `session`, `id`), `kind`                                    | —                                                                                                                        |

Трейс може існувати лише через `span.trace`, без запису в `traces`; тоді його `name` дорівнює `null`.
Відсутнє поле `kind` показується як `function`.

`runtime` — де код **справді** виконався: `node`, `browser`, `edge` (edge runtime, зокрема Next
middleware у sandbox'і всередині процесу `next dev`), `other`. Компонент `'use client'`, відрендерений
на сервері, має `node`.

### 4.2 Значення (`Value`)

Кожне з `args`, `return`, `error` має один зі станів:

| Стан           | Поля               | Значення                                                                                                                                                                                            |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorded`     | `value`            | Повне значення. Може містити будь-які теги, крім `deeper`, `more`, `string-cut`, `more` в `object` і `unavailable`. `masked` усередині означає часткове маскування. `null` — справжнє значення null |
| `truncated`    | `value`, `reason?` | Значення обрізане. Може містити будь-які теги, крім `unavailable`                                                                                                                                   |
| `masked`       | `reason?`          | Значення приховане цілком                                                                                                                                                                           |
| `not-recorded` | `reason?`          | Не записувалось (рівень запису, виняток, продюсер не вміє)                                                                                                                                          |

Відсутнє поле `args`/`return`/`error` дорівнює `{ "state": "not-recorded" }`. Жодне відсутнє
значення не показується як `null` чи `undefined`. У файлі бувають тільки ці чотири стани. Viewer додає
ще три власні: `live` (значення з дебагера), `invalid-value(<позиція>)` (поле не пройшло
валідацію) і `truncated` з `reason: "viewer-cap"` (обрізав сам viewer, 4.9).

Усередині `value` — звичайний JSON плюс теговані об'єкти для того, чого JSON не вміє. Тегований
об'єкт має рівно перелічені ключі; інакше це `unknown-tag`.

| Тег           | Форма                                               | Сенс                                                                                                                                                                                               |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `undefined`   | `{"$type":"undefined"}`                             | JS undefined                                                                                                                                                                                       |
| `number`      | `{"$type":"number","value":"NaN"}`                  | `value` ∈ {`NaN`, `Infinity`, `-Infinity`, `-0`}                                                                                                                                                   |
| `bigint`      | `{"$type":"bigint","value":"123"}`                  | BigInt, десятковий рядок                                                                                                                                                                           |
| `function`    | `{"$type":"function","name":"f"}`                   | функція (тіло не записується)                                                                                                                                                                      |
| `symbol`      | `{"$type":"symbol","description":"x"}`              | Symbol                                                                                                                                                                                             |
| `date`        | `{"$type":"date","value":"2026-…Z"}`                | Date, ISO 8601                                                                                                                                                                                     |
| `map`         | `{"$type":"map","entries":[[k,v],…]}`               | Map; `k`, `v` — Value                                                                                                                                                                              |
| `set`         | `{"$type":"set","values":[v,…]}`                    | Set                                                                                                                                                                                                |
| `class`       | `{"$type":"class","name":"Cart","value":{…}}`       | екземпляр класу. Error → `value: {name, message, stack?}`, RegExp → `{source, flags}`, Promise → `{state}`, Buffer/TypedArray → `{length}`                                                         |
| `accessor`    | `{"$type":"accessor","get":true,"set":false}`       | властивість-getter/setter; getter не викликався                                                                                                                                                    |
| `hole`        | `{"$type":"hole"}`                                  | дірка в розрідженому масиві                                                                                                                                                                        |
| `cycle`       | `{"$type":"cycle","path":"$.a.b"}`                  | циклічне посилання                                                                                                                                                                                 |
| `masked`      | `{"$type":"masked"}`                                | замасковане поле всередині значення                                                                                                                                                                |
| `deeper`      | `{"$type":"deeper"}`                                | обрізано за глибиною (лише в `truncated`/`live`)                                                                                                                                                   |
| `more`        | `{"$type":"more","count":120}`                      | останній елемент масиву, `map.entries` чи `set.values`: ще N елементів (лише в `truncated`/`live`)                                                                                                 |
| `string-cut`  | `{"$type":"string-cut","value":"…","length":40000}` | `value` — префікс, `length` — повна довжина в UTF-16 code units (лише в `truncated`/`live`)                                                                                                        |
| `object`      | `{"$type":"object","entries":{…},"more":N?}`        | екранування: ключі `entries` — буквальні рядки, значення — Value (розбираються рекурсивно). Обов'язкове для справжнього об'єкта з ключем `$type`; `more` — ще N ключів (лише в `truncated`/`live`) |
| `unavailable` | `{"$type":"unavailable","reason":"…"}`              | лише `live`: ім'я недоступне в кадрі (TDZ, не існує). У файлі — `invalid-value`                                                                                                                    |

Об'єкт із ключем `$type`, тег якого viewer не знає, показується як звичайний об'єкт з позначкою
`unknown-tag`.

### 4.3 Ідентичність, батьки і порядок

**Ідентичність.** Span ідентифікується трійкою `(trace, session, id)`, трейс — `id` (унікальний у
dataset'і). Один трейс може містити span'и кількох сесій (наприклад, browser і node). Ключ трейсу —
лише його `id`; ключ span'а — трійка.

**`order`** — порядковий номер **початку** виклику (enter) у межах `(trace, session)`. Продюсер
присвоює його в момент входу у виклик, незалежно від того, в якому порядку записує span'и. Тому він
визначений і для `running` span'ів, які не завершились. Ціле 0…2^53−1, унікальне в `(trace, session)`.
Різниця `order` ніколи не показується як тривалість.

**Розв'язання батька** span'а S:

1. `parent: null` → S — справжній корінь. `parentSession` разом з `parent: null` — фатальна помилка.
2. Задано `parentSession` → шукаємо точно `(S.trace, parentSession, parent)`. Не знайдено →
   `unknown(missing)`. Інших спроб немає, навіть коли `parentSession` дорівнює `session`.
3. `parentSession` не задано:
   1. `(S.trace, S.session, parent)`, якщо такий span є;
   2. інакше span'и трейсу з `id = parent` в інших сесіях: рівно один → він; два і більше →
      `unknown(ambiguous)` (жодного не вибираємо); жодного → `unknown(missing)`.
4. Span з батьком `unknown(…)` малюється як корінь свого трейсу з позначкою.
5. **Цикли.** Span'и, чий ланцюжок батьків ніколи не доходить до кореня, утворюють цикл. У кожному
   циклі корінням стає член з найменшою парою `(session, order)` (порівняння `session` побайтово
   UTF-8). Він позначається `cycle`, його ребро до батька відкидається.

Батьки ніколи не вгадуються за часом чи порядком.

**Порядок дітей** батька P: спершу діти з тієї самої сесії, що й P, за `order`. Потім діти з інших
сесій, згруповані за `session` (побайтово за зростанням), у групі — за `order`.

**Порядок коренів трейсу:** справжні корені, потім корені з `unknown(missing|ambiguous)`, потім
корені циклів. У кожному класі — за `(session, order)`.

**Порядок трейсів** у списку в усіх читачах: за `id`, побайтово за зростанням.

Завдяки цим правилам дерево і вся текстова проєкція однакові за будь-якого порядку span'ів у файлі.

### 4.4 Статус

Значення: `complete`, `errored`, `running`, `suspended`, `unknown`.

- `running` у файлі означає «запис зупинився, коли виклик ще тривав» і показується як
  `running (at capture)`.
- `unknown` завжди має причину: `statusReason` або `unspecified`.
- `suspended` — очікування, а не помилка. Сюди належить і Suspense: у React 18 — кинутий thenable, у
  React 19 — `SuspenseException` (це `Error`, але продюсер записує `suspended`, не `errored`).
- `unknown` з `statusReason: "aborted"` — HTTP-запит, закритий клієнтом до завершення відповіді
  (`close` без `finish`). Такий запит ніколи не записується як `complete`.
- Статус трейсу виводиться: `errored`, якщо є хоч один errored span; `incomplete`, якщо є
  running/unknown; інакше `complete`.

### 4.5 NDJSON (`.kosmo-trace.ndjson` і stdin)

- Кожен рядок — один JSON-об'єкт з полем `type`. Поля лежать поруч із `type`, без вкладення:
  - `{"type":"header","format":"kosmo-trace","version":1,"dataset":{…}}`;
  - `{"type":"trace","id":"t_9f","name":"GET /cart"}`;
  - `{"type":"span", …поля span'а 4.1}`;
  - `{"type":"link","from":{…},"to":{…},"kind":"caused-by"}`.
- Перший непорожній рядок — `header`. BOM на початку відкидається. Другий `header` — фатальна
  помилка, як і повторний `trace` з тим самим `id`.
- Далі рядки йдуть у будь-якому порядку; span може прийти раніше свого батька чи свого `trace`.
- Порожні рядки пропускаються, CRLF приймається. Кожен рядок обмежується 1 MiB **до** парсингу.
- Рядок з невідомим `type` пропускається, а банер показує `N unknown lines skipped`. Так само
  поводиться JSON з невідомими полями верхнього рівня.
- Потік читається до EOF з індикатором `reading… N spans`, після чого модель будується один раз.
- Помилка рядка (невалідний JSON, фатальне порушення 4.9) зупиняє читання. TUI будує модель з уже
  прочитаних рядків і показує банер `stream stopped at line N: <reason>`. `--print` у такому разі
  нічого не друкує: помилка з позицією йде в stderr, exit 2.
- Загальний ліміт — 64 MiB або 200 000 span'ів. При перевищенні: `stream stopped: too-large`, з тією
  ж поведінкою, що й при помилці рядка.

### 4.6 SQLite (`.kosmo-trace.sqlite`)

Та сама модель у таблицях з префіксом `kosmo_`.

```sql
CREATE TABLE kosmo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- обов'язкові рядки: ('format','kosmo-trace'), ('version','1'), ('dataset','<JSON dataset>')

CREATE TABLE kosmo_traces (id TEXT PRIMARY KEY, name TEXT);

CREATE TABLE kosmo_spans (
  trace TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL,
  parent TEXT, parent_session TEXT, "order" INTEGER NOT NULL,
  name TEXT NOT NULL, kind TEXT, status TEXT NOT NULL, status_reason TEXT,
  duration_ms REAL, runtime TEXT,
  file TEXT, line INTEGER, col INTEGER, end_line INTEGER, snippet TEXT, snippet_cut INTEGER,
  area_module TEXT, area_feature TEXT,
  attrs TEXT,                             -- JSON-об'єкт 4.13 або NULL
  args TEXT, ret TEXT, error TEXT,        -- JSON Value 4.2 або NULL = not-recorded
  PRIMARY KEY (trace, session, id)
);
CREATE INDEX        kosmo_spans_parent ON kosmo_spans (trace, parent);
CREATE UNIQUE INDEX kosmo_spans_order  ON kosmo_spans (trace, session, "order");

CREATE TABLE kosmo_links (
  from_trace TEXT NOT NULL, from_session TEXT NOT NULL, from_id TEXT NOT NULL,
  to_trace TEXT NOT NULL, to_session TEXT NOT NULL, to_id TEXT NOT NULL,
  kind TEXT NOT NULL
);
```

- Кожне значення `kosmo_spans.trace` мусить мати рядок у `kosmo_traces`. Якщо ні — фатальна помилка
  при відкритті (перевіряється одним запитом `… EXCEPT …`).
- Список трейсів читається сторінками по 200 рядків з `kosmo_traces`, `ORDER BY id`. `>` завантажує
  наступну сторінку.
- При відкритті трейсу span'и читаються одним запитом, але без `args`/`ret`/`error`. Значення
  читаються ліниво при виборі span'а; якщо значення не проходить валідацію, поле стає
  `invalid-value(<table/pk>: <що>)`, а трейс лишається відкритим. Трейс більш ніж на 200 000 span'ів
  не відкривається: стан `trace-too-large(N)`.
- Зайві таблиці й колонки ігноруються. Якщо немає обов'язкової таблиці чи колонки —
  `not-a-kosmo-trace-store`. Сюди належить і SQLite store callflow.
- Відкривається лише в режимі read-only через `process.getBuiltinModule("node:sqlite")`, і тільки
  після того, як установлено фільтр `ExperimentalWarning` для SQLite. Жоден модуль не імпортує
  `node:sqlite` статично: статичний імпорт друкує попередження раніше за будь-який фільтр і псує
  екран. Це перевіряє тест.

### 4.7 Області (`area`)

- `module` — технічна межа (директорія, пакет, модуль), `feature` — бізнес-логіка (`cart`,
  `checkout`). Обидва — рядки, які задає продюсер.
- `area` відсутня або без жодного поля → viewer виводить `module = dirname(location.file)` (для
  файлу в корені — `.`) і позначає область як `derived` (у TUI — префікс `~`). `feature` ніколи не
  виводиться.
- Файл у `node_modules`: похідний `module` — ім'я пакета після **останнього** `node_modules/`
  (разом з `@scope/`). Тож `node_modules/.pnpm/cors@2.8.5/node_modules/cors/lib/index.js` дає
  `~cors`. Бібліотечні шари (cors, body-parser, ValidationPipe) читаються як одна область.
- Без `location` і без `area` span потрапляє в область `(unknown)`.
- Рядок панелі Areas має ключ `(module, feature, derived)`. Явна `src/cart` і похідна `~src/cart` —
  окремі рядки.

### 4.8 Корінь проєкту і шляхи

- `location.file` — лише відносний POSIX-шлях: без `..`, без абсолютного шляху, без схеми
  (`file://`, `webpack://`), без керівних і bidi-символів. Порушення → location відкидається з
  позначкою `invalid-location`, span лишається.
- `snippet` — текст рядка `line` без символу кінця рядка, обрізаний по межі UTF-8 до ≤ 512 B.
  Обрізаний snippet має `snippetCut: true`.
- Корінь для читання файлів (фрагменти коду, дебаг) визначається так:
  1. `--root <dir>` або `:root <dir>`;
  2. `dataset.root`, якщо така директорія існує і проходить перевірку довіри (нижче);
  3. найближчий предок файлу трейсу, де є `.git` або `package.json`;
  4. поточна директорія.
- **Перевірка довіри до `dataset.root`** (правило 2). Файл трейсу — недовірені дані, тож
  `dataset.root` не може сам вибрати, які файли машини показувати. Усі шляхи порівнюються за
  realpath (симлінки розкрито):
  - `dataset.root` мусить дорівнювати поточній директорії або директорії файлу трейсу чи містити
    одну з них. Для stdin директорії трейсу немає, рахується лише cwd;
  - корінь файлової системи `/` відкидається завжди, навіть якщо він «містить» cwd;
  - домашня директорія користувача і будь-який її предок відкидаються (корінь надто широкий).
    Домашню директорію визначає composition root (`os.homedir()` у `ui/open.ts`) і передає як
    залежність; якщо вона невідома (`os.homedir()` кинув виняток або повернув порожній рядок),
    ця перевірка пропускається, решта діє;
  - відкинутий `dataset.root` переходить до правила 3, а рядок стану трейсу показує
    `dataset.root ignored (<причина>): <шлях>`. `dataset.root`, якого немає на диску, переходить до
    правила 3 мовчки, як і раніше;
  - `--root`/`:root` задає користувач, тож перевірка до них не застосовується.
- Продюсери можуть не писати `dataset.root` у переносні файли, бо абсолютні шляхи хоста — приватні дані.
- _Змінено 2026-09-25 після рев'ю етапу 1:_ раніше правило 2 приймало будь-яку наявну директорію, і
  ворожий трейс із `"root": "/"` та `location.file: "etc/passwd"` показував той файл у вікні коду.

### 4.9 Ліміти і наслідки порушень

Правило за замовчуванням: будь-яке порушення, якого немає в рядках «погіршує», фатальне. При
відкритті воно дає `invalid(<позиція>: <що>)`, NDJSON-потік зупиняється (4.5). Позиції: для JSON —
шлях (`$.spans[12].location.line`), для NDJSON — номер рядка, для SQLite — таблиця і первинний ключ.
Частина позиції, взята з даних до валідації (частина первинного ключа SQLite, ключ об'єкта у `Value`),
обрізається до 256 B UTF-8 з `…`, тож позиція ніколи не несе мегабайтів.

| Правило                                                                                                                                                    | Наслідок                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format` ≠ `kosmo-trace` / `version` ≠ 1                                                                                                                   | фатально: `not-a-kosmo-trace` / `unsupported-version`                                                                                                          |
| Немає обов'язкового поля, неправильний JSON-тип                                                                                                            | фатально                                                                                                                                                       |
| `id`, `trace`, `session`, `parent`, `parentSession`, id у link > 256 B UTF-8                                                                               | фатально                                                                                                                                                       |
| `name`, `kind`, ім'я трейсу, `statusReason`, рядки `area`, `kind` link'а, `dataset.title`, `dataset.createdAt`, `dataset.producer.name`/`version` > 1024 B | фатально                                                                                                                                                       |
| `dataset.root` > 4096 B                                                                                                                                    | фатально                                                                                                                                                       |
| Дублікат `(trace, session, id)` або `(trace, session, order)`                                                                                              | фатально                                                                                                                                                       |
| `parentSession` при `parent: null`                                                                                                                         | фатально                                                                                                                                                       |
| `order` не ціле 0…2^53−1                                                                                                                                   | фатально                                                                                                                                                       |
| Файл JSON/SQLite > 64 MiB                                                                                                                                  | фатально: `too-large` (розмір перевіряється до читання)                                                                                                        |
| Рядок NDJSON > 1 MiB; потік > 64 MiB або > 200 000 span'ів                                                                                                 | потік зупиняється (4.5)                                                                                                                                        |
| Трейс SQLite > 200 000 span'ів                                                                                                                             | трейс не відкривається: `trace-too-large(N)`                                                                                                                   |
| Порушення правил `location` (4.8), `line` < 1, `column` < 1, `endLine` < `line`, `file` > 4096 B                                                           | погіршує: location відкидається, `invalid-location`                                                                                                            |
| `snippet` > 512 B                                                                                                                                          | погіршує: snippet відкидається, `invalid-snippet` (location лишається)                                                                                         |
| `durationMs` < 0 або не скінченне                                                                                                                          | погіршує: поле відкидається                                                                                                                                    |
| `attrs` не є об'єктом                                                                                                                                      | погіршує: `attrs` відкидаються цілком, `invalid-attrs`                                                                                                         |
| Окремий запис `attrs` порушує 4.13 (ключ, тип, розмір, понад 32 ключі)                                                                                     | погіршує: відкидається лише цей запис, span лишається, `invalid-attrs(N)`                                                                                      |
| `Value`: вкладеність > 64, неправильна форма тегу, заборонений у цьому стані тег, `unavailable` у файлі                                                    | погіршує: поле стає `invalid-value(<позиція>)` (однаково в усіх читачах, зокрема при лінивому читанні SQLite)                                                  |
| Невідомий тег у `Value`                                                                                                                                    | погіршує: `unknown-tag`                                                                                                                                        |
| Значення одного поля в пам'яті > 64 KiB                                                                                                                    | погіршує: структурне обрізання (`string-cut`/`more`/`deeper`) → `truncated` з `reason: "viewer-cap"`; для `live` стан лишається `live` з тими самими маркерами |

### 4.10 JSON Schema

Пакет містить `schema/kosmo-trace-v1.schema.json` (документ) і `$defs` для рядків NDJSON (`header`,
`trace`, `span`, `link`). Це документація для продюсерів, експортується як `./schema/*`.

Валідатор у коді написаний вручну, нуль runtime-залежностей. Паритет зі схемою перевіряє тест із
JSON-Schema-валідатором (devDependency):

- кожна валідна фікстура і кожен валідний рядок NDJSON проходять обидва валідатори;
- ворожі випадки позначено `schema-expressible` (версія, обов'язкові поля, enum'и, типи, патерни
  шляхів і керівних символів) — обидва їх відкидають;
- або `validator-only` (байтові ліміти, вкладеність, унікальність, розміри файлу й рядка, м'які
  наслідки) — перевіряються лише ручним валідатором.
  Схема ніколи не суворіша за ручний валідатор на полях із м'якими наслідками (`location.file`,
  невідомі `$type`). Усе, що відкидає схема, ручний валідатор теж відкидає або позначає.

### 4.11 Сумісність наперед у межах `version: 1`

| Невідоме                                             | Поведінка                                   |
| ---------------------------------------------------- | ------------------------------------------- |
| Поле документа, dataset, trace, span, location, area | ігнорується                                 |
| Рядок NDJSON з невідомим `type`                      | пропускається, рахується в банері           |
| Таблиця або колонка SQLite                           | ігнорується                                 |
| Значення `status`                                    | `unknown`, `statusReason` = сире значення   |
| Значення `runtime`                                   | `other`                                     |
| Стан `Value`                                         | `not-recorded(<сире значення>)` з позначкою |
| `kind` span'а або link'а                             | показується як є                            |
| Ключ `attrs`                                         | показується як є в detail                   |

Нова версія формату — це нове значення `version`. Новий тип рядка NDJSON чи нове поле з'являються в
межах v1 лише тоді, коли старий viewer може їх безпечно проігнорувати.

### 4.12 Link'и

- Відомі типи: `caused-by` (to спричинив from, наприклад, effect → fetch), `follows-from`.
- Detail span'а має секцію `links`: вихідні `→ <name> (caused-by)` і вхідні `← <name> (caused-by)`.
  Кінець link'а без span'а показується як `missing`.
- Валідатор перевіряє лише форму SpanRef.
- `--format json --trace` зберігає link'и, у яких хоча б один кінець належить трейсу.

### 4.13 Фреймворки: словник `kind` і `attrs`

`kind` — рядок з крапками `<framework>.<role>`. Це не закритий enum: невідомий kind показується як є
(після sanitize). Особливо відображаються лише точні відомі імена з таблиці. JSON Schema дає їх як
`examples`. Словник спирається на OpenTelemetry: SpanKind і атрибути HTTP за стабільними іменами
semconv.

**Відомі kind'и v1:**

| kind                    | Межі span'а                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `function` (типовий)    | виклик → return / throw / settle                                                                               |
| `http.server`           | запит отримано → `finish` відповіді. `close` без `finish` → `unknown(aborted)`. Ні того, ні іншого → `running` |
| `http.client`           | вихідний виклик (`fetch`, `http.request`) → відповідь або помилка                                              |
| `express.router`        | шар Router або sub-app                                                                                         |
| `express.middleware`    | callback `use()` з арністю ≤ 3: від виклику до першого `next()`, `finish` відповіді або `close`                |
| `express.handler`       | callback методу route, ті самі межі                                                                            |
| `express.error-handler` | callback з арністю 4 (так Express його й розпізнає)                                                            |
| `nest.middleware`       | як `express.middleware`                                                                                        |
| `nest.guard`            | `canActivate` → settle; boolean-результат записується в `return`                                               |
| `nest.interceptor`      | від `intercept()` до завершення, помилки чи відписки Observable. Downstream-enhancer'и — його діти             |
| `nest.pipe`             | `transform` → settle                                                                                           |
| `nest.handler`          | метод контролера                                                                                               |
| `nest.filter`           | `catch()` → return                                                                                             |
| `react.render`          | виклик функції компонента; suspension → статус `suspended` (4.4)                                               |
| `react.effect`          | setup або cleanup effect'у                                                                                     |
| `next.middleware`       | `middleware.ts` (edge або node) або `proxy.ts` Next 16 (node)                                                  |
| `next.route-handler`    | export у `app/**/route.ts`                                                                                     |
| `next.server-action`    | `'use server'` action. `runtime: browser` — виклик клієнтського stub'а, `node` — тіло action                   |
| `next.render`           | рендер route (RSC/SSR)                                                                                         |

**Правила для продюсерів** (viewer їх не перевіряє, лише документує):

1. Один виклик — рівно один span з найспецифічнішим kind'ом. Middleware Nest на платформі Express —
   `nest.middleware`, не ще й `express.middleware`. `app.use()` у застосунку Nest — `express.middleware`.
2. Шари middleware Express/Nest — **брати** під своїм router'ом або запитом, а не діти попереднього
   шару. Синхронний `next()` вкладає наступні шари в стек попереднього (навіть після `await`), тож
   батьки, взяті зі стеку, неправильні.
3. `http.route` — шаблон низької кардинальності, складений із шаблонів mount'ів (`/api/orders/:id`),
   ніколи не з URL чи `req.baseUrl`.
4. Статус `http.server`: `errored` для 5xx або неперехопленого винятку; 4xx — `complete`; обрив
   клієнтом — `unknown(aborted)`.
5. Метадані фреймворку — в `attrs`, значення користувача — лише в `args`/`return`/`error`.
6. Батьки рендерів React не вгадуються.
7. Сирі URL (`http.target`, `http.url`, `url.full`, `url.query`) у `attrs` не пишуться. Якщо вони
   все ж є, viewer маскує в них значення query (8.3).

**`attrs`** — опційний об'єкт `ключ → string | number | boolean`. Без `null`, масивів і об'єктів у v1.

- Ключ відповідає `^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$` і має ≤ 128 B. Такий патерн приймає
  імена OTel разом із шаблонами на кшталт `http.request.header.content-type`.
- Не більше 32 ключів, рядок ≤ 512 B UTF-8, числа скінченні, серіалізований об'єкт ≤ 8 KiB.
- Записи перевіряються в порядку документа. Невалідні записи відкидаються, потім валідні
  приймаються, поки не буде перевищено 32 ключі або 8 KiB серіалізованого об'єкта, а решта
  відкидається. Усі відкинуті рахуються в `invalid-attrs(N)` (4.9). JSON, NDJSON і SQLite
  зберігають порядок тексту JSON, тож результат однаковий у всіх читачах. Відсутній ключ означає
  «не записано».
- Ключі проходять маскування 8.3 (наприклад, `http.request.header.authorization`, `session.id`).

Ключі, які viewer використовує у v1:

| Ключ                                                             | Значення                                      | Де видно                                                      |
| ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `http.request.method`, `http.route`, `http.response.status_code` | OTel stable                                   | рядок `http.server` у дереві, у списку трейсів і в kosmo-text |
| `next.request.type`                                              | `document` \| `rsc` \| `prefetch` \| `action` | рядок `http.server`                                           |
| `react.strict_mode.duplicate`                                    | boolean — твердження продюсера                | приглушений рядок з позначкою `⧉strict`                       |

Рекомендовані ключі лише для показу в detail:

- `express.handoff` (`next` \| `next-error` \| `next-route` \| `next-router` \| `rejected` \| `threw` \| `response`);
- `express.mount_path`;
- `nest.binding` (`global` \| `controller` \| `method` \| `param`);
- `nest.di_scope` (`request` \| `transient`);
- `nest.handler` (`OrdersController.create`);
- `nest.pipe.arg_type` (`body` \| `query` \| `param` \| `custom`), `nest.pipe.arg_data`;
- `react.effect.type` (`passive` \| `layout` \| `insertion`), `react.effect.phase` (`setup` \| `cleanup`);
- `next.action.id`, `http.response.completion` (`finish` \| `aborted`), `error.type`.

Майбутні (не у v1): `react.commit`, `db.query`, транспорти Nest (rpc/ws/graphql), тип link'а
`caught-by` (Error Boundary), масиви в `attrs`, кеш Next.

## 5. Архітектура

### 5.1 Модулі

```
src/format/           нове ядро; нуль залежностей
  types.ts              DatasetInfo, TraceSummary, SpanRow, SpanRef, TraceRef, Link, Value, Area, Location, Attrs
  validate.ts           4.9, позиційні помилки
  value.ts              розбір тегованих значень 4.2, структурний capValue, маскування за ключами
  model.ts              TraceModel: індекси, розв'язання батьків і порядок 4.3, статуси, області, link'и
  kinds.ts              словник 4.13
src/readers/
  sniff.ts              визначення контейнера (6.8)
  json.ts  ndjson.ts  sqlite.ts
src/code/
  snippet.ts            читання файлу з кореня, вікно рядків, перевірка snippet'а, кеш
  params.ts             імена параметрів функції з тексту (для capture, етап 2)
src/sanitize.ts         escapeTerminalControls, валідація OSC 8 URI
src/print.ts            kosmo-text/v1, --format json|tab (розділ 7)
src/app.ts              екрани: start | traces | trace | targets; відкриття/закриття dataset'у під час роботи
src/start.ts            пошук трейсів, recent.json
src/debug/            етап 2–3 (розділи 9–10)
  discover.ts  transport.ts (WebSocket; pipe — етап 3)  cdp.ts (маршрутизація за sessionId)
  scripts.ts  sourcemap.ts  normalize.ts (9.4)  breakpoints.ts (точки й сайти, 9.5)
  capture-core.ts (серіалізація + маскування без залежностей; з нього збираються helper'и, 9.1)
  helper.ts  tracepoint.ts  pause.ts  port.ts  browser.ts
UI дебагера — панелі екрана trace: Targets, Hits, Paused-view (як Areas)
UI (переписуються на TraceModel):
  session, view-state, render, panes, detail, stack, bookmarks, commands, command-line,
  keys, labels, capabilities, clipboard, terminal, color, wrap, ansi, bounds
```

`session.ts` — це головний цикл: чисті `reduce(state, action)`, `renderFrame(state, cols, rows)`,
`decodeKey`. Увесь I/O (файли, процеси, мережа, термінал, годинник) іде через порти, передані в
`run(proc, deps)`, як зараз.

### 5.2 Доля кожного поточного файлу

| Файл                                                                                                                                                                                                                                       | Доля                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ansi`                                                                                                                                                                                                                                     | Без змін                                                                                                                                                                                                                                                                    |
| `terminal`                                                                                                                                                                                                                                 | Змінюється: другий захисний шар у `paint` (розділ 8)                                                                                                                                                                                                                        |
| `color`                                                                                                                                                                                                                                    | Змінюється: підключається до render (`adaptSgr(detectColorLevel)`, `sourceLink`); сьогодні його ніхто не імпортує                                                                                                                                                           |
| `wrap`                                                                                                                                                                                                                                     | Підключається до detail і фрагмента коду                                                                                                                                                                                                                                    |
| `bounds`                                                                                                                                                                                                                                   | `ByteLru`/`jsonBytes` лишаються (кеш значень SQLite і карт); `BoundedQueue`/`FRAME_QUEUE_*` видаляються                                                                                                                                                                     |
| `terminal-input`                                                                                                                                                                                                                           | Лишається; підказка `--print [text\|json\|tab]`                                                                                                                                                                                                                             |
| `command-line`                                                                                                                                                                                                                             | Переписується: нова граматика refs (6.6)                                                                                                                                                                                                                                    |
| `keys`                                                                                                                                                                                                                                     | Переписується: нова карта (6.7)                                                                                                                                                                                                                                             |
| `render`, `panes`                                                                                                                                                                                                                          | Переписуються: без compare/depth/requests/serializers/values/SQL; нові екрани й панелі                                                                                                                                                                                      |
| `view-state`, `session`                                                                                                                                                                                                                    | Переписуються на `TraceModel`; `session` стартує без dataset'у (5.4)                                                                                                                                                                                                        |
| `commands`                                                                                                                                                                                                                                 | Переписуються на нову модель (6.6)                                                                                                                                                                                                                                          |
| `detail`                                                                                                                                                                                                                                   | Переписується: значення 4.2, location, area, attrs, link'и, фрагмент коду                                                                                                                                                                                                   |
| `stack`, `bookmarks`, `capabilities`                                                                                                                                                                                                       | Переписуються: ключі 4.3, `name` замість `nodeId`                                                                                                                                                                                                                           |
| `labels`                                                                                                                                                                                                                                   | Переписується: мітки kind'ів 4.13 без жодного виведення ролей (прибирається `interceptorRole` і `FrameworkPayload` callflow)                                                                                                                                                |
| `requests`                                                                                                                                                                                                                                 | Видаляється. Його ідея — один трейс може мати кілька вхідних запитів — лишається як рядок-підсумок у списку трейсів (6.2)                                                                                                                                                   |
| `clipboard`                                                                                                                                                                                                                                | Змінюється лише `buildCopyDocument` (kosmo-text/v1 піддерева через print/sanitize). Вибір адаптера, `CLIPBOARD_ENV_ALLOWLIST`, пошук за абсолютним PATH і fallback у stdout лишаються разом із тестами                                                                      |
| `print`, `cli`, `open-viewer`                                                                                                                                                                                                              | Переписуються. `open-viewer` зберігає інваріанти: повернення raw mode на EOF і ще раз через `RECLAIM_AFTER_EOF_MS`; `q` до відкриття джерела; Ctrl+C → exit 130; EPIPE у продюсера при ранньому виході                                                                      |
| `source`, `source-open`, `detect`                                                                                                                                                                                                          | Замінюються на `readers/*` і 5.3                                                                                                                                                                                                                                            |
| `viewer`, `duration`, `terminal-session`                                                                                                                                                                                                   | Видаляються: у production ніхто не імпортує `viewer`/`terminal-session`; `duration` потрібен лише replay і `viewer`. Фікстура `test/fixtures/pty-viewer.mjs` переходить на справжній bin; `distReady` у `test/pty.ts` і `test/terminal-pty.test.ts` перевіряє `dist/cli.js` |
| `source-live`, `source-export`, `source-stream`, `source-sqlite`, `source-common`, `sqlite-driver`, `context`, `outcomes`                                                                                                                  | Видаляються                                                                                                                                                                                                                                                                 |
| `replay`, `replay-pin`, `replay-clock.md`, `compare`, `values`, `depth`, `snapshot-selectors`, `serializers`, `sql`                                                                                                                        | Видаляються                                                                                                                                                                                                                                                                 |
| `review`, `review-format`, `review-fs`, `review-lock`, `review-status`, `eval`, `eval-child`                                                                                                                                               | Видаляються                                                                                                                                                                                                                                                                 |
| `docs/sql-recipes.md`, `scripts/deps-tarballs.mjs`, `scripts/parity-kc.*`, `scripts/sqlite-fixture-kc.mjs`                                                                                                                                 | Видаляються                                                                                                                                                                                                                                                                 |
| Фікстури й хелпери callflow: `test/fixtures/{cross-source,parity,sqlite}`, `cross-source.ts`, `parity-state.ts`, `sqlite-fixtures.ts`, `source-fixtures.ts`, `replay-records.ts`, їхні snapshot'и, записи в `.gitignore`/`.prettierignore` | Видаляються                                                                                                                                                                                                                                                                 |

Долю кожного тестового файлу визначає план. Інваріанти, які мусять пережити перенесення, перелічено
в 13.2.

### 5.3 Інтерфейси

```ts
interface TraceReader {
  readonly kind: "json" | "ndjson" | "sqlite";
  readonly origin: { path: string } | "stdin";
  open(signal: AbortSignal): Promise<OpenedDataset>;
  reopen?(signal: AbortSignal): Promise<OpenedDataset>; // немає для stdin → `r` = unavailable(stdin-stream)
  close(): Promise<void>;
}

type OpenedDataset = {
  info: DatasetInfo; // dataset + kind + origin
  traces: TraceListPage; // { items: TraceSummary[], hasMore }
  loadMoreTraces?(signal: AbortSignal): Promise<TraceListPage>; // лише sqlite
  loadTrace(id: string, signal: AbortSignal): Promise<TraceModel>;
  loadValues?(ref: SpanRef, signal: AbortSignal): Promise<SpanValues>; // лише sqlite
  notices: Notice[]; // stream stopped, unknown lines skipped, …
};

type TraceSummary = {
  id: string;
  name: string | null;
  spans: number | null;
  status: TraceStatus | null;
  requests: {
    first: { method: string | null; route: string | null; status: number | string | null } | null;
    count: number;
  } | null; // span'и http.server; first — з найменшою (session, order)
};
// SQLite рахує spans/status/requests одним агрегатним запитом по kosmo_spans для id сторінки.
// null у TUI і в tab показується як `-`.

interface TraceModel {
  // незмінний; будується один раз
  readonly trace: TraceSummary;
  get(ref: SpanRef): SpanRow | undefined; // для json/ndjson — разом зі значеннями
  roots(): SpanRef[]; // порядок 4.3
  children(ref: SpanRef): SpanRef[]; // порядок 4.3
  parentOf(
    ref: SpanRef
  ):
    | { kind: "root" }
    | { kind: "resolved"; ref: SpanRef }
    | { kind: "unknown"; reason: "ambiguous" | "missing" }
    | { kind: "cycle" };
  areas(): AreaRow[]; // ключ (module, feature, derived), лічильники
  spansInArea(key: AreaKey): SpanRef[];
  links(ref: SpanRef): { out: LinkView[]; in: LinkView[] };
}
```

Можливість, якої джерело не має, просто відсутня в об'єкті. `capabilities.ts` виводить з цього, які
клавіші доступні, і пояснює причину: `reload: unavailable(stdin-stream)`.

### 5.4 Екрани і потік даних

```
argv ─┬─ шлях ──► sniff ──► reader.open ──► validate ──► OpenedDataset ──┐
      └─ нічого ──► екран start ── Enter ──────────────────────────────────┤
                                                                            ▼
               екран traces (якщо трейсів > 1) ── Enter ──► loadTrace ──► екран trace
                                                                            │ вибір span'а
                             detail: values + location + area + attrs + links + snippet(root, location)
               етап 2–3: DebugPort (події CDP як actions) ──► Targets / Hits / Paused
```

- `session` стартує без dataset'у. `app.ts` тримає поточний екран і вміє відкривати та закривати
  dataset під час роботи.
- Dataset з одним трейсом відкриває екран trace одразу.
- Exit 1/2 (6.8) застосовуються лише до шляху з argv. Помилку відкриття файлу, вибраного на
  стартовому екрані, показує банер із причиною з розділу 12, і користувач лишається на стартовому
  екрані.

## 6. Інтерфейс (етап 1)

### 6.1 Стартовий екран

`kosmo-tui` без аргументів:

```
 kosmo-tui                                               Enter open · / filter · q quit
 Found in ./ (depth 2)
 ▸ traces/checkout-bug.kosmo-trace.json        2.1 MB   today 10:02
   traces/cart.kosmo-trace.sqlite              40 MB    yesterday
 Recent
   ~/work/storefront/.traces/pdp.kosmo-trace.json      yesterday
   ~/tmp/crash.kosmo-trace.ndjson                     file-not-found
```

- Пошук: поточна директорія плюс два рівні піддиректорій, без `node_modules`, `.git` і прихованих
  директорій. Шукаються файли `*.kosmo-trace.json`, `*.kosmo-trace.ndjson`, `*.kosmo-trace.sqlite`.
  Будь-який інший шлях відкривається аргументом.
- Рядок показує шлях, розмір і час зміни. Файли на цьому екрані не відкриваються.
- Нещодавні — до 20 шляхів у `$XDG_CONFIG_HOME/kosmo-tui/recent.json` (або
  `~/.config/kosmo-tui/recent.json`). Зберігаються лише шлях і час відкриття. `-r` вимикає запис.
  Якщо домашню директорію визначити не вдалося (`os.homedir()` кинув виняток або повернув порожній
  рядок), TUI все одно працює: з `$XDG_CONFIG_HOME` список працює як завжди, без нього
  `recent.json` вимкнено, і стартовий екран показує про це інформаційний банер (змінено 2026-09-25
  після рев'ю етапу 1; раніше це був вихід з кодом 2).
- З етапу 2 з'являється `A debug`: панель Targets без трейсу.

### 6.2 Екран traces

Список трейсів dataset'у: `id`, `name`, кількість span'ів, статус. Якщо трейс має span'и
`http.server`, рядок додатково показує `METHOD route → status` першого з них (з найменшою парою
`(session, order)`; однаково в усіх читачах), а при кількох — ще й `N requests`. Жодних діагностик
рядок не виводить.

- `j`/`k` — рух, Enter — відкрити трейс, `/` — фільтр за `id`/`name`.
- `>` — наступна сторінка (SQLite).
- Esc — назад на стартовий екран, якщо прийшли звідти.

### 6.3 Екран trace

- **Дерево** — DFS за дітьми `TraceModel` у порядку 4.3, а не сортування за глибиною чи id.
  Розгортання прив'язане до `SpanRef`, зокрема для батьків з інших сесій і з `parentSession`.
- **`v`** перемикає на таблицю: ті самі рядки DFS пласким списком з колонками.
- **Фільтри** `e` (лише помилки), `/` (пошук за `name` і `location.file`) і область (6.5)
  показують збіги разом з їхніми предками. Предки приглушені як контекст.
- **`T` або Backspace** — назад до списку трейсів.
- Лишаються stack-панель (`s`, записані предки), bookmarks (`m`, `'`) і текстовий вигляд (`d`).
- **Рядок дерева:** гліф статусу, `name`, `kind` (якщо не `function`, повністю й приглушено — так
  `express.middleware` і `nest.middleware` в одному дереві не плутаються), `file:line`, тривалість.
  Особливий показ для відомих kind'ів (4.13):
  - `http.server` — `METHOD route → status` з `attrs`, а також `next.request.type`;
  - `express.error-handler` і `nest.filter` — гліф шляху помилки `⤳`;
  - `nest.guard` із записаним `return` = `false` — `→ false (denied)`;
  - `react.strict_mode.duplicate` = `true` — рядок приглушений з позначкою `⧉strict` (це твердження
    продюсера, viewer дублікатів сам не шукає);
  - `running`-шар middleware — звичайне `running (at capture)`. Причину viewer не вигадує, і
    відсутній error handler ніколи не позначається.
- **Межа сесії або runtime:** коли дитина має інший `session` чи `runtime`, ніж батько (виклик
  server action з браузера, запит browser → Express/Nest), перед нею стоїть рядок-роздільник
  `┄┄ browser → node · n1 ┄┄`. Він не вибирається, не рахується в таблиці, закладках і DFS-індексах і
  не потрапляє в kosmo-text.

### 6.4 Detail і фрагмент коду

```
 calculateLineTotal · function · errored · node · s1
 src/cart.ts:12:3  area src/cart · cart
 ┌ src/cart.ts ──────────────────────────────────────────
 │▶ 12  export async function calculateLineTotal(item, qty) {
 │  13    const p = await price(item.id);
 │  14    if (item.discount > 100) {
 │  15      throw new RangeError("discount > 100%");
 │  16    }
 │  17    const total = p * qty;
 │  18    log(total);
 │  19    return total;
 │  20  }
 └───────────────────────────────────────────────────────
 args    [{"id":7}, 2]
 return  not-recorded (threw)
 error   RangeError: discount > 100%
 attrs   code.function = calculateLineTotal
```

- **Блок `attrs`** — по одному `key = value` на рядок, відсортовано за ключем, після sanitize.
  Замасковані ключі показуються як `masked`. Якщо щось відкинуто, додається рядок `invalid-attrs(N)`.
  Блок `links` — 4.12.

- **Ім'я** показується повністю, як є в `name`.
- **Вікно коду:** з `endLine` — від `line` до `endLine` (до 40 рядків, далі `…`); без нього — ±8
  рядків довкола `line`.
- **Розмір:** вікно обрізається до доступних рядків панелі і **завжди містить рядок `▶`**. Скорочується
  контекст довкола, але не сам рядок. Enter дає detail фокус: тоді панель займає все тіло екрана, а
  `j`/`k`/PgUp/PgDn її прокручують. Tab або Esc повертає фокус списку. Golden-кадри 80×24 і мінімального
  розміру перевіряють, що рядок `▶` видно.
- **Табуляції** в коді розгортаються в пробіли (крок 4) до екранування.
- **Порівняння snippet'а:** з обох боків прибрати CR, обрізати пробіли на краях. Якщо `snippetCut`,
  порівнюється як префікс.
- **Стани фрагмента:**
  - `ok`;
  - `file-missing`;
  - `outside-root` (realpath виходить за корінь через symlink);
  - `too-large` (> 2 MiB);
  - `unreadable` (EACCES та ін.);
  - `not-text` (NUL-байти або невалідний UTF-8);
  - `changed-since-trace` (рядок не збігається зі snippet'ом, або `line` за кінцем файлу). Тоді той
    самий текст шукається в ±40 рядках: найближчий збіг, при рівності — менший номер рядка, і показується
    `moved to line N`.
- **`file:line`** — OSC 8 посилання лише при `KOSMO_TUI_LINKS=1` (як зараз). URI будується лише з
  провалідованого `root + location.file`.

### 6.5 Панель Areas (`a`)

Список областей поточного трейсу: `module`, `feature`, кількість span'ів і помилок. Похідні області
позначені `~`. Enter фільтрує дерево до span'ів області (предки приглушені), Esc знімає фільтр.

### 6.6 Команди і refs

Граматика refs:

- **span-ref:** `.` (вибраний) | `<id>` | `<session>:<id>` | `<trace>:<session>:<id>`. Перші три
  форми розв'язуються в поточному трейсі. Неоднозначність не вгадується: показується список
  кандидатів.
- **trace-ref:** `<trace>`.
- Токени можна брати в лапки. `/` на початку токена позначає regex лише в `:find`, `:filter name`
  і `:area`.

| Команда                                                                     | Сенс                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `:trace <trace-ref>`                                                        | Відкрити трейс                                                                                                                                                                                                                       |
| `:ancestors [span-ref]`                                                     | Ланцюжок батьків за 4.3 з позначками `unknown(…)`/`cycle`                                                                                                                                                                            |
| `:path <from> <to>`                                                         | Шлях існує, коли один span — предок іншого за розв'язаними батьками: `found`. Різні трейси → `no-path`. Ланцюжок упирається в `unknown(…)` → `unknown-path(<reason>)`                                                                |
| `:callers [span-ref]`                                                       | Усі span'и трейсу з тим самим `(location.file, location.line)`, що й ref (без location — з тим самим `name`). Показуються їхні батьки, згруповані за `(name, file:line)` батька, з лічильником; невідомі батьки — `(unknown parent)` |
| `:find /re/[imsu]`                                                          | Збіги `name` або `location.file` у трейсі; список результатів, Enter — перейти                                                                                                                                                       |
| `:filter errors [on\|off] \| name /re/ \| kind <glob> \| area <x> \| clear` | Фільтри дерева; `kind nest.*` лишає кроки Nest з приглушеними предками                                                                                                                                                               |
| `:area <x>`                                                                 | Спершу шукає серед `feature`, потім серед `module`; `module:<x>` і `feature:<x>` задають тип явно                                                                                                                                    |
| `:bookmark [list]`                                                          | Закладки (ключ — SpanRef, мітка — `name`)                                                                                                                                                                                            |
| `:root [<dir>]`                                                             | Без аргументу показує корінь; з аргументом змінює корінь і перечитує фрагменти                                                                                                                                                       |
| `:q`                                                                        | Вихід                                                                                                                                                                                                                                |

### 6.7 Клавіші

Клавіші панелі чи модального вікна у фокусі мають пріоритет над глобальними.

| Клавіша                                | Дія                                                                        | Етап |
| -------------------------------------- | -------------------------------------------------------------------------- | ---- |
| `j` `k` ↑ ↓ PgUp PgDn `g` `G` Home End | Навігація                                                                  | 1    |
| `h` `l` Space                          | Згорнути / розгорнути / перемкнути                                         | 1    |
| Enter                                  | Список трейсів: відкрити трейс. Дерево: фокус на detail                    | 1    |
| Tab / Esc                              | Фокус на список / зняти вибір, закрити панель, назад                       | 1    |
| `T` Backspace                          | З екрана trace — до списку трейсів                                         | 1    |
| `v` `d`                                | Дерево ↔ таблиця / текстовий вигляд kosmo-text                             | 1    |
| `/` `e` `a`                            | Пошук / лише помилки / Areas                                               | 1    |
| `s`                                    | Stack (записані предки)                                                    | 1    |
| `m` `'`                                | Закладка / список закладок                                                 | 1    |
| `y`                                    | Копіювати kosmo-text вибраного піддерева (`--detail 0`, той самий ліміт)   | 1    |
| `>` `r`                                | Наступна сторінка трейсів (SQLite) / перечитати файл                       | 1    |
| `:`                                    | Командний рядок                                                            | 1    |
| `q` Ctrl+C                             | Вихід                                                                      | 1    |
| `A`                                    | Панель Targets                                                             | 2    |
| `b`                                    | Tracepoint на вибраному span'і; повторне `b` знімає його                   | 2    |
| `B`                                    | Breakpoint на вибраному span'і; повторне `B` знімає його                   | 2    |
| `H`                                    | Панель Hits / tracepoints                                                  | 2    |
| `P`                                    | Повернутися до Paused-view                                                 | 2    |
| `c` `n` `o`                            | Поки процес-джерело на паузі — у будь-якому вигляді: continue / over / out | 2    |
| `s`                                    | У Paused-view — step into (в інших виглядах лишається Stack)               | 2    |

Етап 1 звільняє без заміни: `n`, `b`, `L`, `p`, `=`, `w`, `f`, `t`, `R`, `-`, `+` (`b` повертається на
етапі 2). Локальні клавіші панелей: Hits `f`/Enter, Targets `r` (rescan) / `R` (rescan з
wildcard-портами, 9.2) / Enter / Esc, підтвердження `y`/`n`/Esc, рядок tracepoint'а Enter/Esc.

Команди дебагера: `:attach <ip>:<port>`, `:detach`, `:tp <file:line> [names…]`,
`:untp [<file:line>|all]`, `:tp-cap <N>`, `:bp <file:line>`, `:unbp [<file:line>|all]`,
`:max-pause <s>|off` (етап 2); `:attach-browser <ip>:<port>`, `:reload-armed` (етап 3).

### 6.8 CLI, визначення контейнера, коди виходу

```
kosmo-tui [-r] [--root <dir>]                          стартовий екран
kosmo-tui <file|-> [-r] [--root <dir>]                 відкрити трейс
kosmo-tui <file|-> --print [--trace <id>] [--format text|json|tab] [--detail 0|1]
kosmo-tui --help | --version
```

- `-r` / `--read-only`: не пише `recent.json`, вимикає все з ефектом `debug` (етапи 2–3).
- **Визначення контейнера:**
  1. SQLite magic → sqlite;
  2. інакше читається перший непорожній рядок (≤ 1 MiB, без BOM): повний JSON-об'єкт з
     `"type":"header"` → ndjson, інакше JSON-документ;
  3. розширення вирішує лише в неоднозначних випадках.
     Для stdin діє те саме правило.
- **Stdin (`-`):** клавіші читаються з керуючого терміналу; без нього — exit 1 з підказкою `--print`.
- **Коди виходу для шляху з argv:**
  - шлях не існує або це директорія → 1;
  - `too-large`, `not-a-kosmo-trace`, `not-a-kosmo-trace-store`, `unsupported-version`,
    `invalid(…)` → 2;
  - під `--print` зупинений потік → 2;
  - помилки використання → 1.

## 7. Print і текстова проєкція `kosmo-text/v1`

### 7.1 Комбінації `--print`

| `--format`      | без `--trace`                                         | з `--trace <id>`                                                                  |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `text` (типово) | exit 1: `pass --trace <id>`                           | проєкція 7.2                                                                      |
| `json`          | нормалізований документ `kosmo-trace/v1` (без ліміту) | вирізка: цей трейс і його link'и (4.12), без ліміту                               |
| `tab`           | рядки `id\tname\tspans\tstatus`                       | рядок на span: `session\tid\tparent\tstatus\tkind\tfile:line\tname` у порядку DFS |

- `--detail` дозволено лише з `text`; інакше exit 1.
- Stdin читається до EOF без дедлайну.
- `text` і `tab` мають ліміт 51 200 B UTF-8, включно з останнім рядком-позначкою. Відкидаються цілі
  останні групи рядків, а в кінець додається позначка обрізання. `json` не обмежується: це експорт
  даних, розмір якого вже обмежено лімітами входу.
- `--format json` не застосовує термінальне екранування. C0, C1, DEL і bidi пишуться JSON-екрануванням
  `\uXXXX`, маскування за ключами застосовується (8.3), стан значення не змінюється.
- Щоб вивід знову проходив валідацію, поля, відкинуті при читанні (location, snippet, записи `attrs`,
  `durationMs`), у `json` не пишуться. Поле `invalid-value` пишеться як
  `{"state":"not-recorded","reason":"invalid-value"}`.
- Клітинки `tab` екрануються: `\t`, `\n`, `\\` і керівні символи → `\uXXXX`.

### 7.2 Граматика

```
header      = "kosmo-text/v1 trace=" jstr " name=" (jstr / "-") " spans=" total " status=" tstatus LF
span-line   = indent glyph " " jstr [ " " kind ] "  " loc "  [" area "]  " dur [ "  " http ] [ "  " mark ] LF
detail-line = indent "    args=" v "  return=" v "  error=" v [ "  attrs=" a ] LF
trailer     = "… truncated: output-byte-cap (shown " N " of " M " spans)" LF
```

- `indent` — два пробіли на рівень глибини. `detail-line` має відступ span'а плюс чотири пробіли.
- `jstr` — JSON-рядок (`JSON.stringify`) з додатковим екрануванням C1 і bidi як `\uXXXX`.
- `glyph`: `✓` complete, `✗` errored, `…` running, `⏸` suspended, `?` unknown.
- `loc`:
  - `file:line`, де `file` пишеться як є, якщо відповідає `^[A-Za-z0-9._/@$+~#-]+$`, інакше — `jstr`;
  - або `(no location)`;
  - або `(invalid-location)`.
- `area`: `module`, `module · feature` або `~module` (кожна частина — як є або `jstr` за тим самим
  правилом), або `(unknown)`.
- `kind` — присутній, лише якщо kind не `function`. Пишеться як є, якщо відповідає
  `^[a-z][a-z0-9_.-]*$`, інакше — `jstr`.
- `dur`: `durationMs.toFixed(1) + "ms"` або `-`.
- `http` — лише для `http.server`, коли є хоч один із атрибутів методу, route чи статусу:
  `<method|-> <route|-> → <status|->`. Кожна з трьох частин пишеться як є за правилом `loc`, інакше —
  `jstr` (числовий статус — як число).
- `mark`: `parent=unknown(ambiguous)`, `parent=unknown(missing)`, `cycle`, `unknown(<reason>)` для
  статусу unknown, `strict-duplicate`, `invalid-attrs(N)`. Кілька позначок розділяються пробілом у
  фіксованому порядку: parent, cycle, status, strict-duplicate, invalid-attrs.
- `a` — компактний JSON `attrs` з відсортованими ключами і маскуванням; присутній, лише коли `attrs`
  непорожні. Ліміт той самий, що й для `v`.
- `v` у `detail-line`:
  - `recorded` → компактний JSON значення;
  - `truncated` → `truncated:` + компактний JSON;
  - `masked` → `masked`;
  - `not-recorded` → `not-recorded(<reason>)` або `not-recorded`;
  - `invalid-value` → `invalid-value(<jstr позиції>)`;
  - невідомий стан (4.11) → `unknown-state(<jstr сирого значення>)`.
    Кожне значення ≤ 512 B: довше обрізається по межі UTF-8 до ≤ 509 B з додаванням `…`.
- `total` — кількість усіх span'ів трейсу. `tstatus` — статус трейсу (4.4).
- Рядки йдуть у порядку DFS 4.3. Кожен рядок закінчується `\n`, кодування UTF-8.
- Група = `span-line` плюс його `detail-line`. При перевищенні ліміту групи відкидаються з кінця,
  доки весь вивід разом із `trailer` не вміститься в 51 200 B.
- `y` і `d` у TUI використовують ту саму проєкцію з `--detail 0`.

## 8. Безпека терміналу і маскування

### 8.1 Екранування

`escapeTerminalControls` замінює на `\uXXXX`:

- C0 — крім `\n` у багаторядкових блоках (вікно коду, розгорнуті значення). Табуляції у вікні коду
  спершу розгортаються в пробіли, в інших місцях `\t` стає `\u0009`;
- DEL;
- C1 (зокрема U+009B);
- bidi-керування U+202A–U+202E, U+2066–U+2069.

Застосовується до кожного рядка з даних (трейс, файли коду, debuggee) **до** wrap/fit.

### 8.2 Другий шар у `terminal.paint`

`paint` розбирає кожен рядок на токени і пропускає лише:

- SGR (`ESC[…m`);
- OSC 8, URI якого `paint` перевіряє сам: схема `file://`, шлях у межах кореня, без керівних і
  bidi-символів. Порожній корінь або `/` — це відсутність кореня: `isSafeOsc8Uri` тоді не пропускає
  жодного URI (змінено 2026-09-25 після рев'ю етапу 1; корінь із `dataset.root` обмежує 4.8).

Усе інше екранується: сирий ESC, C1, окремі C0, bidi. Кольори йдуть через
`adaptSgr(detectColorLevel(env, isTTY))`. Парсер екрана в `test/pty.ts` навчиться OSC, що
закінчується на `ESC\`. Тест перевіряє, що рядок даних із CSI чи OSC виводиться екранованим.

### 8.3 Маскування за ключами

- Ключ властивості (і ключ `attrs`) розбивається на слова за camelCase, `-`, `_`, `.`, у нижньому
  регістрі.
- Ключ маскується, якщо:
  - серед слів є одне з: `password`, `passwd`, `pwd`, `secret`, `token`, `auth`, `authorization`,
    `cookie`, `credential`, `credentials`, `jwt`, `bearer`, `otp`;
  - або в ньому є пара слів поспіль: `api key`, `session id`, `private key`, `access key`,
    `client secret`;
  - або весь ключ дорівнює `apikey`, `sessionid`, `sid`, `set-cookie`.
- Приклади: `tokenizer` і `sessionStorage` не маскуються, `csrfToken` і `x-api-key` маскуються.
- **Значення, незалежно від ключа:** рядок, схожий на облікові дані
  (`^(Bearer|Basic|Digest|Negotiate)\s+\S+` без урахування регістру, або JWT
  `^eyJ[\w-]+\.[\w-]+\.[\w-]*$`), маскується повністю.
- **URL-подібні рядки** (зокрема `req.url`, `originalUrl`, attrs `http.target`, `http.url`,
  `url.full`, `url.query`): маскуються значення query-параметрів, ключі яких підпадають під правило
  ключа.
- Маскування ніколи не буває повним: секрет, скопійований у змінну з невинним ім'ям, пройде. Про це
  попереджає екран підтвердження attach.
- Маскування — другий шар для записаних значень у detail, print і `y` (`{"$type":"masked"}`, стан
  лишається). Для live-значень (етапи 2–3) воно обов'язкове і відбувається ще в процесі-джерелі.

## 9. Етап 2: live-дебагер для Node

### 9.1 Ефект `debug` і що виконується в процесі

Новий ефект `debug` означає «зупиняє або виконує код в іншому процесі». Він окремий від `read`.
`-r` і `--print` вимикають усе з цим ефектом.

| Дія                                                                                                                                                                | Ефект                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Список процесів (`ps`, `lsof`/`ss`)                                                                                                                                | `read`                                                                                                                                                    |
| `GET /json/version`, `/json/list`                                                                                                                                  | `read`. Побічний ефект: запит на HTTP-порт застосунку виконує його код (Next записує в лог `GET /json/version 404`), тому порядок проб обмежено (9.2 п.3) |
| Attach (WebSocket, `Runtime.enable`, `Debugger.enable`)                                                                                                            | `debug`; Node друкує `Debugger attached.` у термінал застосунку                                                                                           |
| `SIGUSR1` для ввімкнення інспектора                                                                                                                                | `debug`                                                                                                                                                   |
| Встановлення helper'а (`Runtime.evaluate` фіксованого коду; перший `process.getBuiltinModule("node:inspector")` завантажує ~27 внутрішніх модулів Node)            | `debug`                                                                                                                                                   |
| Helper у vm-контексті Edge і `Runtime.addBinding` (9.6)                                                                                                            | `debug`                                                                                                                                                   |
| Умови tracepoint'ів і breakpoint'ів (згенерований код, 9.6–9.7)                                                                                                    | `debug`                                                                                                                                                   |
| Реєстрація очікуваних значень «того самого випадку» через `Runtime.callFunctionOn` (лише дані)                                                                     | `debug`                                                                                                                                                   |
| Пауза, кроки, `Runtime.getProperties` на паузі                                                                                                                     | `debug`                                                                                                                                                   |
| Етап 3: запуск браузера з тимчасовим профілем, `Page.addScriptToEvaluateOnNewDocument(helper)`, `Page.navigate`, `Page.reload` (`:reload-armed`, з підтвердженням) | `debug`                                                                                                                                                   |
| Етап 3: `GET` карти з loopback dev-сервера                                                                                                                         | `read`                                                                                                                                                    |

Жоден рядок із трейсу чи з debuggee ніколи не стає частиною коду, який виконується. Згенерований код
містить лише фіксовані фрагменти kosmo-tui, провалідовані ідентифікатори (9.6), числа, які генерує
kosmo-tui (tpId, кепи), і nonce (hex-літерал за `^[0-9a-f]{32}$`). Решта даних передається лише як
аргументи CDP (`callFunctionOn`), які не розбираються як код.

**Спільне ядро helper'а.** Серіалізація 4.2 і маскування 8.3 написані як один модуль без залежностей
і без замикань на імпорти (`src/debug/capture-core.ts`). З нього під час збірки через
`Function.prototype.toString` складаються три джерела: Node-helper, Edge-helper і browser-helper.
`src/format/value.ts` використовує те саме ядро. Unit-тест проганяє на тих самих входах і
впроваджений helper, і `value.ts` та очікує однаковий результат.

### 9.2 Панель Targets і discovery

```
 Debug targets                                   r rescan · Enter select · Esc back
 ▾ next dev · supervisor (no app code)      pid 83915   127.0.0.1:9229
   ▸ ● next-server v16.3.6 · app code (RSC · SSR · route handlers · actions · middleware)
         pid 83916   127.0.0.1:9230   node 22.22   ✓ same project as trace
 ▸ ● pid 48213  sfnext dev          127.0.0.1:9231  node 25.2  ✓ same project as trace
 ▾ node --watch · supervisor                pid 51000
   ▸ ○ pid 51002  node server.js    inspector off   (Enter → enable via SIGUSR1)
   ? [::1]:9240  unverified (no matching process)
```

Discovery (`debug/discover.ts`) бере лише процеси поточного користувача.

1. **Процеси.** Власний pid kosmo-tui виключається.
   - macOS: `ps -axo pid=,ppid=,uid=,command=` і окремо `ps -axo pid=,ucomm=`, щоб `ucomm` був
     останньою колонкою (він може містити пробіли); результати з'єднуються за pid.
   - Linux: `/proc/<pid>/status` (ppid, uid), `/proc/<pid>/cmdline` (argv, розділений NUL),
     `readlink /proc/<pid>/exe`. `ps` не використовується: після `process.title` там `comm` має
     вигляд `next-server (v1` з пробілами.

   Node-процес визначається так:
   - на macOS `ucomm` дорівнює `node` або `nodejs`. `ucomm` не змінюється через `process.title`, на
     відміну від `comm`: у `next-server` той показує `next-server (v16`;
   - або перший `txt` з `lsof` (macOS) чи `/proc/PID/exe` (Linux) має базове ім'я `node` або `nodejs`.

   `command` для цього не використовується.

2. **Supervisor'и й обгортки** розпізнаються за точними токенами argv, без підрядків:
   - node з токеном `--watch` або `--watch-path[=…]` (дочірній процес Node 25 має
     `--watch-kill-signal=…`, але не `--watch`);
   - `…/tsx/dist/cli.mjs` або `.bin/tsx`;
   - `…/@nestjs/cli/bin/nest.js`;
   - `…/next/dist/bin/next`;
   - `nodemon`, `ts-node-dev`;
   - менеджери пакетів і обгортки за будь-якої підкоманди: `argv[0]` ∈ {`npm`, `pnpm`, `yarn`, `npx`,
     `bunx`} (форма title), або базове ім'я скрипта в argv — `npm-cli.js`, `pnpm.cjs`/`pnpm.mjs`/
     `pnpm.js` (зокрема шляхи corepack), `yarn.js`/`yarn.cjs`, `cross-env/…/bin/cross-env.js`.
     «Скрипт лежить у `node_modules`» ознакою інструмента не є: `sfnext` і `next` — справжні процеси
     застосунку, запущені з `node_modules`.

   Supervisor показується заголовком групи, під ним — його нащадки (за `ppid`). Supervisor теж
   пробується. Якщо він сам слухає інспектор, діє одне правило міток: supervisor Next отримує
   `supervisor (no app code)`, а будь-який інший supervisor, що слухає, — `tool process, not your
app` (наприклад, коли `NODE_OPTIONS=--inspect` на `tsx` чи `nest` захопив порт). Обидва випадки
   вимагають додаткового підтвердження.

3. **Порти:** `lsof -a -p <pid,pid,…> -iTCP -sTCP:LISTEN -P -n -Fpn`.
   - Exit 1 з валідними `p`/`n`-записами — успіх; exit 1 без виводу — «немає слухачів».
   - `f`-рядки ігноруються; `n` розбирається як `host:port`, зокрема `[v6]:port`.
   - На Linux без `lsof` — `ss -ltnpH`. Лише коли жоден із них не запускається (ENOENT),
     перевіряються порти 9229–9239 на `127.0.0.1`.
   - Для кожного pid порти пробуються в такому порядку, і на першому знайденому інспекторі проби
     зупиняються:
     1. 9229–9239;
     2. порти з `--inspect[=…]`/`--inspect-port` в argv;
     3. решта loopback-портів.
        Wildcard-bind (`*:port`) пробується на `127.0.0.1` лише за явного `R` (rescan all) з
        попередженням, що запит дійде до HTTP-сервера застосунку.
   - Проба: `GET /json/version` і `/json/list` на адресу, яку повідомив `lsof`/`ss`, таймаут 300 мс.
     Target показується, лише якщо `Browser` починається з `node.js/`.
4. **Зіставлення target ↔ процес** — за pid слухача з `lsof`/`ss`. Без нього рядок `unverified`, і
   attach можливий лише після додаткового підтвердження. Порожній url `file://` у `/json/list`
   (точка входу Nest без розширення) впливає лише на показ.
5. **Той самий проєкт:** cwd процесу (`lsof -a -p PID -d cwd -Fn` / `/proc/PID/cwd`) дорівнює кореню
   трейсу (4.8) або лежить усередині нього. Такий рядок має `✓ same project as trace` і стоїть першим.
   Без трейсу корінь визначається правилами 4.8 з cwd.
6. **Мітки фреймворків** за точними токенами argv:
   - `vite/bin/vite.js` → `vite`;
   - `react-router` з `dev` → `react-router dev`;
   - `sfnext` з `dev` → `sfnext dev`;
   - дочірній процес з title `^next-server \(v[^)]+\)$` → `next-server vX · app code …`, і курсор
     стоїть на ньому за замовчуванням;
   - дочірній процес `nest start` → `nest app`;
   - будь-що інше → `node <script>`.

   Підказки Next (11.4) показуються лише там, де їх можна виявити:
   - інспектується тільки supervisor;
   - supervisor у `waiting-for-debugger`;
   - `next-server` без інспектора.

7. **Інспектор вимкнений (`○`):** Enter пропонує `SIGUSR1`. Лише macOS/Linux, окреме підтвердження,
   лише процеси, перевірені як node за п.1. **Ніколи не supervisor'ам**: батько `node --watch`
   ігнорує сигнал, а батьки `tsx`/`nest` відкривають інспектор у собі.
   - Після сигналу до 3 с опитуються LISTEN-сокети **цього pid** (інспектор відкривається на
     `process.debugPort`, а це не завжди 9229).
   - Якщо нового слухача немає — `inspector-enable-timeout`. Якщо ймовірний порт тримає інший pid —
     `inspector-port-busy (best guess)`.
   - kosmo-tui запам'ятовує, що ввімкнув інспектор сам (див. 9.9).
8. **Перезапуск:** коли дитину supervisor'а замінено (watch, перезапуск Next), рядок нового pid у
   Targets має стан `restarted`. Заголовок сесії тим часом показує `target restarted (pid A → B) ·
Enter reattach` (9.3). Enter на рядку або в заголовку виконує reattach; SIGUSR1 при цьому
   пропонується лише тоді, коли новий pid без інспектора.
9. **`:attach <ip>:<port>`** — fallback для Windows і нестандартних випадків. Виконує кроки 3–4 для
   цього порту і показує екран підтвердження.
10. **Рядки запуску браузера (етап 3):** для кожного знайденого Node-процесу з loopback- чи
    wildcard-портом LISTEN, крім його порту інспектора, — `◆ launch browser → http://localhost:<port>`.
    Порт ніколи не пробується. Якщо портів кілька, рядків теж кілька. Мітка фреймворку — з п.6.
    `:launch-browser <loopback-url>` — fallback для серверів, яких discovery не бачить.

**Екран підтвердження** показує pid, команду, cwd, IP:port, `Browser`, `title` і `url` (усе
екрановано), а також попередження:

- «kosmo-tui зможе зупиняти цей процес і виконувати в ньому код; пауза блокує всі запити»;
- «якщо до процесу під'єднано інший дебагер (VS Code, DevTools), kosmo-tui цього не бачить»;
- «маскування значень неповне (8.3)».

`y` — attach.

### 9.3 З'єднання

- **Проксі.** До першого мережевого запиту в процесі kosmo-tui до `NO_PROXY`/`no_proxy` додаються
  `127.0.0.1`, `::1`, `[::1]` і `localhost`. Discovery робить запити через `http.request` з новим
  `http.Agent`. Інтеграційний тест із фейковим проксі при `NODE_USE_ENV_PROXY=1` перевіряє, що через
  проксі не йде жодного з'єднання.
- **Транспорт.** Глобальний `WebSocket`, лише до IP-літерала loopback, що пройшов 9.2 п.3. Хост у
  `webSocketDebuggerUrl` замінюється на цей IP; без userinfo, query і fragment. Повідомлення понад
  16 MiB (розмір перевіряється після отримання) закриває з'єднання з `message-too-large`.
- **Послідовність:**
  1. `Runtime.evaluate("process.pid", {throwOnSideEffect: true, returnByValue: true})`:
     - дорівнює вибраному pid → далі;
     - `undefined` (target чекає на дебагер: `--inspect-brk`, `--inspect-wait`) → стан
       `waiting-for-debugger`; identity береться з pid слухача, і підтвердження це показує;
     - інакше або pid самого kosmo-tui → `pid-mismatch`, detach.
  2. `NodeRuntime.notifyWhenWaitingForDisconnect({enabled: true})`.
  3. `Runtime.enable`. Усі `Runtime.consoleAPICalled`, що прийшли до відповіді на нього, відкидаються:
     це повтор до 1000 старих повідомлень, серед них і хіти попередньої сесії kosmo-tui.
  4. `Debugger.enable` → `Debugger.setAsyncCallStackDepth(32)` →
     `Debugger.setBlackboxPatterns(["/node_modules/"])` (впливає лише на кроки й паузи, не на вміст
     стеків) → `Debugger.setPauseOnExceptions("none")` → `Debugger.setSkipAllPauses(true)` (9.8).
  5. Встановлення helper'а (9.6), а також helper'ів у вже наявних контекстах Edge.
  6. `Runtime.runIfWaitingForDebugger`. Для `waiting-for-debugger` після цього ще раз перевіряється
     `process.pid`; якщо не збігається — detach.
- **Секрет.** UUID target'а — секрет. У заголовку, логах, clipboard і помилках він скорочується до
  `ws://127.0.0.1:9229/<…last4>`. Node сам друкує повний URL у термінал застосунку (`Debugger
listening on …`, `Debugger ending on …`), і SECURITY.md про це каже.
- **Кінець сесії.** Закриття сокета без `executionContextDestroyed` — звичайний кінець при
  watch-перезапуску, SIGTERM чи tree-kill. Стан стає `exited`. Якщо той самий supervisor отримав нову
  дитину з інспектором (повторна проба його дітей до 10 с), показується
  `target restarted (pid A → B) · Enter reattach`. Reattach повторює перевірку pid, встановлює
  helper і перерозв'язує всі логічні точки. Якщо підключитися за щойно знайденим UUID не вдалося,
  `/json/list` перепитується до 2 с (swc-watch Nest стартує двічі).
- **CDP-клієнт** (`debug/cdp.ts`) з самого етапу 2 підтримує необов'язкову маршрутизацію за
  `sessionId`. Транспорт Node її не задає, а етап 3 додає лише pipe. Реєстр, сайти breakpoint'ів і
  епохи пауз мають ключ `(sessionId, scriptId)`.
- **Target'и і заголовок** (D18): одночасно не більше одного Node-target'а і одного браузера.
  - Заголовок: `debug: node pid 48213 (sfnext dev)`, а при двох target'ах — `debug: node pid 48213 ·
browser (temp profile)`.
  - `A` відкриває Targets, не від'єднуючи наявні сесії. Лише другий target того самого типу
    (Node → Node, браузер → браузер) питає підтвердження, щоб від'єднати поточний.
  - `:detach [node|browser]`; без аргументу, після підтвердження, від'єднує обидва.
  - `c`/`n`/`o`/`s` діють на target, чию паузу показує Paused-view. Якщо на паузі обидва, `P`
    перемикається між ними, і кожен має власний рядок банера. `:max-pause` діє на обидва.
- **Маршрутизація точки** (з етапу 2) — за `runtime` span'а:
  - `node`, `edge` або відсутній → Node-target;
  - `browser` → браузер;
  - `other` → `runtime-not-attached`.
  - `:tp`/`:bp` без span'а → в усіх під'єднаних target'ах.
  - `b`/`B` без відповідного під'єднаного target'а відмовляють (`not-attached` /
    `runtime-not-attached`).
  - Логічні точки переживають detach і перерозв'язуються при reattach.
- **Порядок хітів:** кожен хіт отримує монотонний `seq` у порядку надходження повідомлень на
  з'єднанні. Для одного isolate CDP доставляє їх у порядку виконання. `seq` — основа порядку між
  різними tracepoint'ами (наприклад, для послідовності enhancer'ів Nest).

### 9.4 Реєстр скриптів і source maps

- **Легкий запис для кожного скрипта:** `(sessionId, scriptId) → url, kind`, де `kind` ∈
  `user | node_modules | node | tool | react-fake`. На Node 22 `callFrames[].url` у `Debugger.paused`
  порожній, тож кадри підписуються через `location.scriptId`. Для кожного `user`-скрипта записуються
  ще `hasSourceURL`, `sourceMapURL`, `hash`, `startLine`/`startColumn`, `executionContextId`, а також
  прапорець `map-untrusted` і, для недостовірних карт, відповідність рядків диск ↔ `sourcesContent`
  (9.5 крок 0).
- **Відкидаються одразу** (найдешевша перевірка):
  - url з `kosmo-tui://` (кожне обчислення умови народжує новий `scriptParsed`);
  - `wasm://` (type stripper Node);
  - `evalmachine.<anonymous>`;
  - порожній url **без** `sourceMapURL` (`Runtime.evaluate`).

  Порожній url з `data:`-картою лишається кандидатом і зіставляється за абсолютними `sources` карти.
  Так буває з Vite SSR-модулями, коли шлях проєкту містить пробіли (V8 відкидає такий `sourceURL`),
  і тоді Targets показує підказку `project path contains spaces: SSR scripts have no url`.

- **Ніколи не кандидати для breakpoint'а**, але лишаються для підпису кадрів:
  - `node:`/`internal/` і `node_modules`;
  - фейкові функції React Flight: url `about://React/…` або `rsc://React/…`, а також скрипти з
    фіксованим коментарем React «This module was rendered by a Server Component…» (перевіряється
    через `getScriptSource` лише для малих скриптів з `hasSourceURL`);
  - джерела на `/__nextjs-internal-proxy.(mjs|cjs)`.

  Без цього tracepoint на RSC давав 9 хітів замість 1 (14.2).

- **`hasSourceURL` не означає eval:** нативний type stripping Node додає `//# sourceURL=file:///…`
  до кожного `.ts`.
- **Карта завжди має пріоритет.** Якщо у скрипта є карта, використовується вона, навіть коли url
  дорівнює `root + file`: `--experimental-transform-types`, tsx і ts-node зсувають позиції. Url
  береться як є лише для скриптів без карти (після кроку 2 нижче).
- **Джерела карт:**
  - `data:`-URL декодується;
  - відносний шлях або `file://` читається з диска **лише всередині кореня проєкту** (зокрема
    `<root>/dist` і `<root>/.next`);
  - http(s)-карти для Node не завантажуються (браузер — 10.5; помилка завантаження записується на
    скрипт, `map-fetch-failed(…)`);
  - кеш — `ByteLru` за `sourceMapURL`/`hash`, з обмеженим розміром. Вендорні скрипти пропускаються ще
    до декодування карт.
- **Декодер Source Map v3** (`debug/sourcemap.ts`, ~200 рядків):
  - base64-VLQ;
  - index maps (sections, як у всіх картах Turbopack);
  - `sourceRoot`;
  - зворотний пошук original → generated (`allGeneratedPositionsFor`).

  Карти бувають немонотонними (swc), а порожні рядки — без відображення (tsc/swc). Оракул у
  тестах — `@jridgewell/trace-mapping` (devDependency), зокрема його `resolvedSources`.

- **Нормалізація джерела** — явний алгоритм, однаковий для Node і браузера:
  1. **Приєднати `sourceRoot`**, якщо він непорожній.
  2. **Розв'язання.**
     - Джерело зі схемою (`file:`, `http(s):`, `webpack-internal:`, `webpack:`, `turbopack:`) або
       абсолютний шлях (`/…`) не розв'язується.
     - Відносне джерело розв'язується відносно URL зовнішньої карти, а для `data:`-карт — відносно url
       скрипта. Якщо база — голий абсолютний шлях (sourceURL Vite SSR), діє POSIX-семантика
       `path.posix.resolve(dirname(base), src)`; інакше — семантика URL.
  3. **Перетворення в шлях:**
     - `file://…` → декодований шлях;
     - `webpack-internal:///(<layer>)/./<rel>` → відносний до кореня `<rel>` (`<layer>` лишається
       міткою);
     - `webpack-internal:///<abs>` → `/<abs>` (так після розв'язання виглядають абсолютні джерела
       webpack у Next);
     - `webpack://<ns>/./<rel>` і нормалізоване `webpack://<ns>/<rel>` → відносний `<rel>`;
     - `turbopack:///[project]/<rel>` → відносний `<rel>` (корінь Turbopack може бути коренем
       monorepo);
     - `turbopack:///[turbopack]/…` → runtime, ігнорується;
     - `http(s)://<loopback>/<path>` →
       - `/@fs/<abs>` дає абсолютний шлях;
       - будь-який інший `<path>` приєднується до кореня dev-сервера, тобто realpath cwd процесу, який
         тримає цей порт (9.2 п.5, п.10);
       - якщо корінь невідомий (`:attach-browser`), шлях стає відносним без початкового `/`;
     - query і hash (`?t=`, `?id=`, `?<n>`) знімаються, далі decodeURI.
  4. **Порівняння:**
     - абсолютний шлях порівнюється з `realpath(root + file)` і з `path.resolve(root + file)` (Next
       пише шлях, з яким його запущено, навіть через symlink);
     - відносний порівнюється з `file` на рівність або так: `("/" + rel).endsWith("/" + file)`.
  5. **Однозначність.** Суфікс дозволено лише тоді, коли в межах **однієї карти** так збігається
     рівно один нормалізований шлях. Кілька збігів → `failed(ambiguous-source)`. Зворотного суфікса
     (`file` закінчується на `rel`) немає.
  6. **Регістр.** На macOS порівняння без урахування регістру.
  7. **Скрипти без карти:** url проходить кроки 3–4 так само (браузерний класичний скрипт
     `http://localhost:P/src/app.js`, Node `file:///…`).
- **Той самий файл у кількох скриптах — норма:** шари Next (`rsc`, `ssr`, `action-browser`),
  HMR-копії, контексти Node й Edge. Озброюються всі, і всі рахуються в `resolved (N scripts)`.
- **Контексти.** Знищення не-типового контексту (`auxData.isDefault: false`; Next створює їх
  постійно) прибирає його скрипти з реєстру, а зачеплені точки переходять у `pending`. Detach воно
  ніколи не спричиняє.
- **Координати:** трейс 1-based → декодер (рядки 1-based, колонки 0-based) → CDP 0-based, з
  поправкою на `startLine`/`startColumn`.

### 9.5 Розв'язання точки зі span'а

**Логічна точка** — це місце `(file, line, column?, endLine?, snippet?)` разом із набором
реєстрацій. Кожна реєстрація — tracepoint або breakpoint з власним `tpId`, іменами і span-еталоном.
`:tp`/`:bp` без span'а беруть текст рядка з диска як snippet.

Для кожного `user`-скрипта, карта якого посилається на `file` (або скрипта без карти, шлях якого
після 9.4 дорівнює `root + file`), виконується:

0. **Довіра до карти** (для пари скрипт + джерело):
   - якщо в карті є `sourcesContent` (swc, tsx, ts-node, Vite, Next), вона порівнюється з файлом на
     диску; для карт без `sourcesContent` (tsc) порівнюються лише диск і snippet;
   - при розбіжності скрипт отримує `map-untrusted` (випадок storefront, 14.3);
   - тоді будується відповідність рядків диск ↔ `sourcesContent`: token-нормалізований текст
     (ідентифікатори, ключові слова і пунктуація, без пробілів і лапок) кожного рядка з диска
     шукається в `sourcesContent` у межах ±200 рядків.
1. **Опорний рядок у координатах карти.** Для довіреної карти — `line`. Для `map-untrusted` — рядок
   `L'` у `sourcesContent`, що однозначно відповідає рядку `line` з диска. Жодного або кілька
   однаково добрих збігів → `failed(map-mismatch)`: хіт на неправильному рядку гірший за чесний
   `failed`. Пошук іде в `sourcesContent`, а не в згенерованому коді: Babel-перегенерований TS
   зберігає типи, а esbuild стирає їх у згенерованому коді.
2. **Початок тіла** — заголовок функції ніколи не буде стартом:
   - V8 для старту з колонки заголовка `export const f = async () => {` повертає місця **модуля**,
     і точка спрацювала б один раз при завантаженні, а не на кожен запит (перевірено);
   - тому шукається перша оригінальна позиція **після відкривача тіла**, що має сегменти карти:
     - для багаторядкових функцій перебираються рядки `line+1 … endLine` (без `endLine` — до `line+40`);
     - для однорядкових беруться сегменти на `line` після колонки `=>`/`{` за текстом з диска (для
       `map-untrusted` — з `sourcesContent`);
   - знайдену позицію переводить у generated `allGeneratedPositionsFor`. Позиція має бути точною до
     колонки: tsx (esbuild, `minifyWhitespace`) кладе весь модуль в один згенерований рядок;
   - нічого не знайдено → `failed(no-breakable-location)`.
3. **Вибір місця.** `Debugger.getPossibleBreakpoints({start, restrictToFunction: true})` дає місця
   тіла однієї функції, і береться перше. Останнє місце типу `return` позначає кінець тіла. Порожній
   результат → `failed(no-breakable-location)`.
4. **Перевірка відображення.** Зворотне відображення вибраного місця має лежати в `[line, endLine]`
   (для `map-untrusted` — через відповідність кроку 0), а без `endLine` — у тілі функції. Перевірка
   відсікає місце в коді модуля і фейки React для сусідніх модулів того самого chunk'а.
5. **Helper у контексті.** Для типового контексту фрейму ініціалізованої сесії або контексту Edge
   (9.6) helper має існувати. Якщо його немає, для цього скрипта стан `failed(no-helper-in-context)`,
   бо умова з `?.hit` там мовчки нічого не робила б. Перевіряється й для місць, про які пізніше
   повідомив `breakpointResolved`.
6. **Сайт і постановка.**
   - Сайт має ключ `(sessionId, scriptHash | scriptId, genLine, genCol)` і володіє **рівно одним**
     CDP-breakpoint'ом. V8 відхиляє другий breakpoint у тому самому місці навіть з іншою умовою
     (`Breakpoint at specified location already exists`, перевірено), тож усі реєстрації цього
     місця (`b` і `B` на одному span'і, два span'и однієї функції, `:tp` поруч зі span'ом) ділять
     сайт.
   - Умова сайту — згенерований код (9.6): `(h?.hit(tp1,…), h?.hit(tp2,…), <пауза>)`, де `<пауза>`
     — це `false` лише з tracepoint'ами, `true` для звичайного `B` і `h?.match(bp3, …) === true`
     для «того самого випадку».
   - Будь-яка зміна набору перевстановлює breakpoint сайту (remove + set) з новою умовою; короткий
     проміжок без озброєння прийнятний. Кеп і захист частоти прибирають реєстрацію із сайту, а не
     breakpoint.
   - Основний шлях — `Debugger.setBreakpointByUrl({scriptHash, lineNumber, columnNumber, condition})`.
     Він озброює поточний скрипт і всі ідентичні перевиконання синхронно (webpack перевиконує модулі
     з тим самим hash навіть без правок; перезавантаження в Chrome).
   - `Debugger.setBreakpoint` за `scriptId` — лише fallback для місця, яке відрізняється в копіях.
     Hash і `scriptId` — різні типи селектора, тож вони можуть співіснувати.
   - `setBreakpointByUrl` за `url`/`urlRegex` **не використовується ніколи**: після HMR під тим самим
     url рядки зсуваються (Turbopack 15.5, Vite, webpack).
7. **Нові скрипти** з новим hash (lazy-завантаження, HMR) перерозв'язуються на кожен `scriptParsed`:
   - webpack при правці перевиконує весь chunk route (265–464 скрипти);
   - Turbopack 15.5 — весь chunk під тим самим url;
   - Turbopack 16 — лише змінений модуль як `…chunk.js?id=[project]/<file>+[<layer>]`.
8. **Стани логічної точки** (точка існує незалежно від target'а, переживає detach і перерозв'язується
   при reattach):

   | Стан                                                                                        | Коли                                                                                                                     |
   | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | `pending`                                                                                   | відповідного скрипта ще немає                                                                                            |
   | `resolved @file:line (N scripts)`                                                           | озброєно в N скриптах; нотатки за скриптом: `map-fetch-failed(…)`, `map-untrusted`                                       |
   | `re-anchored`                                                                               | хоча б один скрипт озброєно через відповідність кроку 0                                                                  |
   | `armed after first run`                                                                     | точку поставлено на скрипт, чий `scriptParsed` прийшов раніше за цей breakpoint (його перший запуск міг бути пропущений) |
   | `failed(map-mismatch \| ambiguous-source \| no-breakable-location \| no-helper-in-context)` | крок 0–5                                                                                                                 |
   | `auto-removed`                                                                              | захист частоти (9.6)                                                                                                     |
   | `removed: cap N reached`                                                                    | клієнтський кеп (9.6)                                                                                                    |

   Розв'язання з `breakpointResolved` і `scriptParsed.resolvedBreakpoints` дедуплікуються за
   `(breakpointId, scriptId)`.

**Показ кадрів недостовірних карт.** Кадри зі скрипта `map-untrusted` підписуються оригінальним
рядком через відповідність кроку 0. Кадр без відповідності показується як `≈ <рядок>` і ніколи не
отримує `✓`. Кадр у самому місці нашого сайту показує `file:line` логічної точки з позначкою
`re-anchored`. Тест 5b порівнює generated-позицію верхнього кадру з озброєною позицією маркера.

### 9.6 Tracepoint (`b`) без паузи

**Мета:** при кожному проході через місце span'а отримати шлях виклику і значення, не зупиняючи процес.

**Постановка.**

- `b` на span'і відкриває рядок `tp src/cart.ts:12 capture: item, qty`. Список попередньо заповнено
  іменами параметрів, які `code/params.ts` розбирає з тексту функції на диску (для деструктуризації —
  імена листків).
- Допускаються лише ідентифікатори `^[A-Za-z_$][\w$]*$`, окрім зарезервованих слів ES (зокрема
  strict-mode, `await`, `yield`). Виняток — `this`.
- Enter ставить tracepoint. `:tp <file:line> [names…]` робить те саме; `:untp [<file:line>|all]`
  знімає (типово — той, що під курсором у Hits). Повторне `b` на span'і знімає його tracepoint.

**Helper у типовому контексті** встановлюється один раз на attach:

- Встановлюється через `Runtime.evaluate` фіксованого коду з репозиторію, що закінчується на
  `\n//# sourceURL=kosmo-tui://helper`.
- Ключ — `Symbol.for("kosmo-tui:" + nonce)`, де nonce — 128 випадкових біт на кожен attach.
- Властивість визначається через `defineProperty(enumerable: false, configurable: true, writable:
false)`. Тому `delete` при detach працює, а два екземпляри kosmo-tui одне одному не заважають.
- Консоль береться один раз при встановленні:
  `process.getBuiltinModule("node:inspector").console.context("kosmo-tui")`. Застосунки, що
  підміняють `globalThis.console`, на це не впливають.
- Джерело helper'а — фіксований код, куди підставлено лише nonce як hex-літерал (перевірка
  `^[0-9a-f]{32}$`). Ліміти серіалізації — константи цього коду.
- Tracepoint'у реєстрація в helper'і не потрібна: умова самодостатня (нижче), тож перший прохід у
  щойно створеному документі чи контексті одразу дає замаскований хіт. Через
  `Runtime.callFunctionOn(helper, "arm", arguments: [bpId, expected])` реєструються лише очікувані
  значення `match` (9.7). kosmo-tui надсилає `arm` знову на кожен новий типовий контекст
  (`auxData.isDefault`) ініціалізованої сесії і на кожен контекст Edge.

**Helper у vm-контексті Edge** (Next middleware з edge runtime у `next dev`):

- Консолі з `.context` там немає (`.trace` йде в stderr застосунку), `process` — polyfill, методи
  якого кидають.
- Тому на attach викликається `Runtime.addBinding({name: "__kosmo_tui_<nonce>", executionContextName:
"Edge Runtime"})`. На кожен `Runtime.executionContextCreated` з цим ім'ям виконується
  `Runtime.evaluate({contextId, expression: <фіксований edge-helper>})`.
- Edge-helper серіалізує так само і викликає binding одним рядком JSON
  `{nonce, tpId, values, stack: new Error().stack}`. Стек лише синхронний і в згенерованих шляхах;
  кадри зіставляються з реєстром за url, беручи найновіший скрипт з цим url у цьому контексті.
- Хіт з'являється в Hits з позначкою `edge sandbox · sync stack only`.
- Інші vm-контексти → `failed(no-helper-in-context)` (9.5 п.5).

**Умова сайту** — згенерований код без жодного рядка з даних, з тегом url. На кожне ім'я — окремий
thunk, ключ об'єкта — провалідований ідентифікатор, а кеп (N + 50) — число, яке генерує kosmo-tui:

```js
(globalThis[Symbol.for("kosmo-tui:<nonce>")]?.hit(<tpId>, <capPlus50>, {item: () => item, qty: () => qty}), false)
//# sourceURL=kosmo-tui://site/<siteId>
```

Для сайту з кількома реєстраціями виклики `hit` ідуть через кому, а останнім стоїть вираз паузи
(9.5 п.6).

**`hit`:**

- Кожен thunk викликається у власному `try/catch`. Недоступне ім'я (TDZ, не існує) стає
  `{"$type":"unavailable","reason":"<повідомлення помилки>"}` лише для цього імені.
- Маскування за іменем працює з першого проходу, бо імена є в самій умові.
- Лічильник на `tpId` створюється ліниво. Після `capPlus50` хітів `hit` одразу повертається.
- **Серіалізація:** глибина 2, 50 елементів, 1000 символів на рядок, теги 4.2.
  - Getters з кодом користувача не викликаються (`accessor`). Дозволено лише фіксований список
    вбудованих безпечних accessor'ів: `length`/`byteLength` TypedArray/ArrayBuffer, DOM
    `nodeName`/`tagName`/`id`.
  - `Error` → `class` з `{name, message}`; `stack` не читається, бо це own accessor і він запускає
    `Error.prepareStackTrace`.
- **Зведення для фреймворкових об'єктів** визначаються лише за формою власних data-властивостей
  (без getters і методів) і записуються як `class` (4.2), без нових тегів:
  - `IncomingMessage` (власні `method`, `rawHeaders`) → `{method, url, httpVersion, headers (з
`rawHeaders`), baseUrl?, originalUrl?, params?, route: route?.path, query? (лише коли це власна
властивість, як в Express 4; в Express 5 — `accessor`), body?, extras (власні перелічувані
властивості, додані middleware, неглибоко)}`;
  - `ServerResponse` → `{statusCode, finished}`;
  - Nest `ExecutionContextHost`/`ArgumentsHost` (власні `args`, `contextType`) → `{contextType,
class: constructorRef?.name, handler: handler?.name, req: <зведення args[0]>}`;
  - React-елемент (`$$typeof` = `Symbol.for("react.element" | "react.transitional.element")`) →
    `{type: <ім'я>, key}`; `_owner`, `_store`, `props.children` не обходяться;
  - `SyntheticBaseEvent` React → `{type, target, currentTarget}` (DOM-зведення); `nativeEvent` не
    обходиться.
- **Маскування 8.3** (ключі, значення-облікові дані, query в URL) відбувається **до** того, як дані
  залишать процес. Значення хіта понад 16 KiB замінюються на `{"$type":"deeper"}`; ліміт стосується
  лише значень, не стеку.
- Далі викликається `ctx.trace("KOSMO_TP", nonce, tpId, json)`. `trace` приносить синхронні кадри й
  async-ланцюжок, а повідомлення не потрапляє у stdout/stderr процесу.

**Приймання хітів:** лише `Runtime.consoleAPICalled` після відповіді на `Runtime.enable`, у якого
контекст відповідає `^kosmo-tui#\d+$`, `args[1]` дорівнює nonce, а `tpId` озброєний. Або
`Runtime.bindingCalled` з тим самим nonce. Кадри з url на `kosmo-tui://` відкидаються.

**Винятки.** `Runtime.exceptionThrown` приписується сайту лише тоді, коли
`exceptionDetails.url` дорівнює `kosmo-tui://site/<id>`; тоді біля його точок показується
`capture error: …`. Власні неперехоплені помилки застосунку (`Uncaught…`, як async throw в Express 4)
показуються окремо як `target error`. Шляхи в CJS-винятках — звичайні абсолютні шляхи, у кадрах —
`file://`, і перед зіставленням обидва нормалізуються.

**Ліміти.** Кожен прохід через breakpoint з умовою коштує ~80–120 мкс (Node і Chrome), навіть коли
умова одразу повертає `false` (14.2). Тому:

- клієнт рахує хіти і знімає tracepoint через `Debugger.removeBreakpoint` після N хітів (типово 100,
  `:tp-cap N`), стан `removed: cap N reached`;
- якщо за секунду більше 200 хітів, tracepoint знімається автоматично: `auto-removed: hot line
(N hits/s)`. Tracepoint на компоненті всередині списку може вичерпати кеп за один рендер, і панель
  про це попереджає.

**Панель Hits (`H`):**

```
 Tracepoints                                             f same-case filter · Enter expand
 ▸ src/cart.ts:12 calculateLineTotal   resolved @src/cart.ts:13 (2 scripts)   37 hits   capture: item, qty
     10:02:11.402  requestLogger → auth → getCart ⟂await calculateLineTotal     item={"id":7} qty=2   ≈ recorded sp_3
     10:02:11.950  requestLogger → auth → getCart ⟂await calculateLineTotal     item={"id":9} qty=1
```

- **Шлях** будується лише з кадрів користувача через усі async-сегменти, які позначаються `⟂await`
  або `⟂then`. Послідовності кадрів `node_modules`/`node:` згортаються в `… N frames (<пакет>)`,
  стартові кадри `inspector_async_hook` приховуються.
- **Порядок у live stack — не батьківство.** Синхронний `next()` Express вкладає попередні middleware
  в стек як «викликачів», хоча в трейсі вони брати (4.13). Guard і pipe Nest на live stack — уже
  завершені брати, тож предками handler'а там видно лише `use → intercept`. Панель показує стек як
  стек і нічого з нього не виводить.
- **Повний live stack** відкривається Enter: кадри переведені через карти в оригінальні `file:line`.
  Кадр, оригінальний `file` якого дорівнює `location.file` span'а відкритого трейсу, а рядок
  потрапляє в `[line, endLine]` (або в тіло функції, 9.5), позначений `✓` («місце збігається»,
  не «батько»).
- **Зберігання:** кільце на tracepoint, до 1000 хітів. Кадри зберігаються компактно (`scriptId`, рядок,
  колонка, індекс імені), до 64 кадрів і 8 async-сегментів на хіт.
- **Фільтр «той самий випадок» (`f`):**
  - еталон — span, на якому tracepoint створено; для `:tp` без span'а фільтр вимкнений;
  - захоплене ім'я зіставляється з позицією параметра за списком `code/params.ts`; імена поза списком —
    wildcard;
  - порівнюються лише `recorded`-примітиви `args` еталона; `masked`, `truncated`, `not-recorded` і
    вкладені структури — wildcard;
  - позначка звучить `≈ recorded sp_3` («consistent with recorded»), а не «той самий виклик».

### 9.7 Breakpoint з паузою (`B`)

- **Постановка** — та сама, що в 9.5. Поки озброєний хоч один `B`, діє
  `Debugger.setSkipAllPauses(false)`.
- **Рядок постановки:** `B` відкриває рядок `bp src/cart.ts:12 [ ] same case only` (пробіл перемикає
  прапорець, Enter ставить). Те саме робить `:bp <file:line> [--same-case]`.
- **«Лише той самий випадок»:** вираз паузи сайту — `h?.match(<bpId>, {item: () => item, …}) === true`.
  `match` повертає `true` лише при збігу з очікуваними значеннями, зареєстрованими як дані через
  `arm` (9.6); до реєстрації — `false` з лічильником `unchecked passes`.
  - Випадки без збігу процес не зупиняють. Їхній лічильник helper віддає через `callFunctionOn` раз
    на секунду: `non-matching passes: N`.
  - Проходи під час mount одразу після reload `B` «того самого випадку» не ловить, бо `arm` ще не
    прийшов.
- **Paused-view** замінює список span'ів:
  - заголовок `live JS stack (paused)`;
  - кадри підписуються через `location.scriptId` і показуються з оригінальними `file:line` та `✓` за
    правилом 9.6;
  - `asyncStackTrace` видно за замовчуванням: handler Nest на паузі має лише 3 синхронні кадри;
  - scope `local`, `closure`, `block` (глобальний — ні) через
    `Runtime.getProperties(ownProperties: true)`, ліниве розгортання, getters не викликаються.
- **Live-значення** мають стан `live`, проходять структурний `capValue`, маскування й `sanitize` і
  показуються поруч із записаними `args` span'а.
- **Клавіші** — 6.7; у польоті лише один крок.
- **Банер** на весь рядок: `PAUSED 12s — усі запити до pid 48213 заблоковано · c continue`.
  `:max-pause <s>|off` вмикає автоматичний resume (типово вимкнено).
- **`objectId`** живуть лише до resume. Кожна пауза має епоху, відповіді зі старої епохи відкидаються,
  `Runtime.releaseObjectGroup` викликається на кожен resume і detach.

### 9.8 Чия це пауза

- Поки немає жодного `B`, діє `Debugger.setSkipAllPauses(true)`. Тоді `debugger;` у коді застосунку,
  «Break on start» (`--inspect-brk`) і breakpoint'и інших клієнтів не зупиняють процес через нашу
  сесію, а tracepoint'и (умови) працюють.
- Пауза наша, якщо `hitBreakpoints` перетинається з нашими breakpoint'ами, або якщо це перша пауза
  після нашої команди кроку без чужого `Debugger.resumed` між ними (епоха кроку).
- Будь-яка інша пауза показується як `paused (debugger statement / break on start / another client)`.
  Вона ніколи не продовжується автоматично, і предикат 9.7 до неї не застосовується. Виняток для
  браузера — 10.4.
- `Debugger.resumed` без нашої команди → `resumed by another client`.

### 9.9 Завершення і сигнали

- **Detach** (`:detach`, `q`, Ctrl+C, SIGTERM, SIGHUP):
  1. порт переходить у стан `closing`, і відтепер відновлюються лише **наші** паузи;
  2. наші breakpoint'и знімаються;
  3. `resume`, якщо пауза наша;
  4. видаляються helper'и: `delete globalThis[Symbol.for("kosmo-tui:<nonce>")]` у типовому контексті
     і в кожному контексті Edge;
  5. `Runtime.removeBinding`, а також видалення функції binding'а з global кожного контексту Edge
     (`removeBinding` її не прибирає);
  6. `Runtime.discardConsoleEntries` (очищує історію консолі й для інших клієнтів — написано в
     SECURITY.md);
  7. `Debugger.disable`, `releaseObjectGroup`, закрити сокет.
     На все це дається дедлайн 1.5 с, після нього сокет знищується. Термінал відновлюється одразу, не
     чекаючи відповідей.
- **Від'єднання під час паузи** відновлює процес і знімає breakpoint'и сесії (14.2). Тож навіть
  аварійне завершення kosmo-tui не залишить процес замороженим, якщо паузу не тримає інший клієнт.
- **`NodeRuntime.waitingForDisconnect`** (вихід процесу, зокрема аварійний, чи перезапуск
  `next-server` після зміни `next.config`) → негайний detach. Інакше процес-джерело висить на
  `Waiting for the debugger to disconnect...` і блокує перезапуск Next. Запасний сигнал — знищення
  типового контексту (`isDefault: true`). Знищення будь-якого іншого контексту detach не спричиняє.
- **Ctrl+Z** (у raw mode приходить байтом `\u001a`) декодується як `suspend`:
  1. якщо під'єднано і пауза наша — `resume`;
  2. `Debugger.setBreakpointsActive(false)`;
  3. відновити термінал і `SIGSTOP` собі.
     На `SIGCONT` — повернути raw mode й alt screen і `setBreakpointsActive(true)`.
- **Сигнали:** SIGHUP і SIGCONT реєструються в `Proc` поряд із SIGINT/SIGTERM.
- **`uncaughtException`** у kosmo-tui: синхронно знищити сокет, відновити термінал, вийти.
- **Інспектор, увімкнений через SIGUSR1:** при detach kosmo-tui питає, чи закрити debug-порт
  (`process.getBuiltinModule("node:inspector").close()` з відкладенням), і попереджає, що це
  від'єднає й інші дебагери. При відмові статус показує `debug port stays open until the process
exits`, і SECURITY.md про це каже.

## 10. Етап 3: дебаг React у браузері

Ядро CDP спільне з етапом 2: реєстр, карти, сайти, helper, tracepoint'и, пауза. Рамка завершення
9.9 (стан `closing`, resume лише нашої паузи, дедлайн 1.5 с, термінал першим) діє і тут. Нижче — лише
відмінності.

### 10.1 Запуск браузера (основний шлях)

- **Звідки запуск:** рядок `◆ launch browser → http://localhost:<port>` у Targets (9.2 п.10) або
  `:launch-browser <loopback-url>`.
- **Адреса:** для слухача на `127.0.0.1`, `[::1]` або wildcard відкривається `http://localhost:<port>`.
  Chrome пробує обидві адресні родини, а `localhost` дозволено cross-site-перевіркою Next і
  `allowedHosts` Vite. Сторінка через `http://[::1]` у Next 16 не гідрується (14.2). IP-літерал
  відкривається лише за явним вибором користувача.
- **Бінарник:** `$KOSMO_TUI_BROWSER`, потім Google Chrome, Microsoft Edge, Chromium, Chrome for Testing з
  кешу Playwright. Нічого не знайдено → `browser-not-found`.
- **Прапорці:**
  - `--remote-debugging-pipe` (fd 3/4, JSON, розділений NUL);
  - `--user-data-dir=<mkdtemp 0700 з ім'ям kosmo-tui-profile-<pid>-*>`;
  - `--no-first-run`, `--no-default-browser-check`, `--use-mock-keychain`, `--password-store=basic`;
  - `--disable-extensions`, `--disable-background-networking`.

  Процес запускається у власній групі. Вікно звичайне. Headless — це опція `launch()` у
  `debug/browser.ts`, яку передають лише тести, без змінної середовища. На Linux опція `noSandbox`
  доступна так само лише тестам.

- **Послідовність:**
  1. запуск без URL (`about:blank`);
  2. `Target.setAutoAttach` на сесії браузера (10.3);
  3. ініціалізація сесії сторінки (10.4);
  4. озброєння точок;
  5. `Page.navigate(url)`.

  Так helper гарантовано виконується раніше за код першого документа.

- **Чому pipe:** TCP-порту немає, тож іншим процесам і користувачам немає до чого під'єднатися. Немає
  `DevToolsActivePort` і UUID у stderr. Браузер завершується разом із kosmo-tui. Тимчасовий профіль не
  містить cookies зі звичайного браузера. Chrome 136+ і так відмовляє у remote debugging на профілі за
  замовчуванням.
- **Ніколи** не передається `--remote-allow-origins`: глобальний `WebSocket` Node не надсилає `Origin`.
- **stderr браузера** пишеться в приватний лог, а не в TUI.
- **Прибирання після старту:** kosmo-tui видаляє директорії `kosmo-tui-profile-<pid>-*`, чий власник
  (pid) уже не живий.

### 10.2 Під'єднання до браузера користувача (fallback)

`:attach-browser <ip>:<port>` працює лише за таких умов:

- адреса loopback;
- `/json/version` `Browser` починається з `Chrome/`, `HeadlessChrome/` або `Edg/`;
- командний рядок pid'а, що слухає, містить `--user-data-dir`, який не є профілем за замовчуванням;
- немає `--remote-allow-origins` із `*` чи не-loopback origin'ом (інакше `remote-allow-origins-unsafe`,
  і attach заборонено).

Ініціалізуються лише loopback-сторінки. Екран підтвердження попереджає: TCP-порт браузера доступний
будь-якому локальному процесу і користувачу, а сторінка дає повний контроль над своїм origin'ом.

### 10.3 Дерево target'ів

- `Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true})` ставиться на
  **сесії браузера**, без фільтра. Тож під'єднуються і нові вкладки та popup'и. Фільтр, що виключає
  worker'и, лишає їх назавжди на паузі (перевірено на Chrome 153).
- Кожен автоматично під'єднаний target:
  - **`page`** з url `http(s)` на loopback-хості ініціалізується (10.4) і показується під рядком
    браузера в Targets. Інші сторінки лише відпускаються (`runIfWaitingForDebugger`) без ініціалізації;
  - **iframe**, зокрема cross-site OOPIF (`localhost` проти `127.0.0.1`), отримує ту саму
    ініціалізацію, а потім `Runtime.runIfWaitingForDebugger`;
  - **dedicated, shared і service worker'и** отримують `Runtime.runIfWaitingForDebugger` і одразу
    від'єднуються (у v1 їх не трасуємо).
- Жоден target ніколи не лишається в очікуванні.
- `browser_ui`, `background_page`, service worker'и розширень, `chrome://` і `devtools://` приховані.
- **Навігація на не-loopback origin:** browser-helper на старті перевіряє, чи `location.hostname`
  loopback, і якщо ні — нічого не встановлює. kosmo-tui відкидає хіти цієї сесії й показує
  `non-loopback-page`, доки сторінка не повернеться.

### 10.4 Ініціалізація сесії сторінки

1. `Page.enable` → `Page.addScriptToEvaluateOnNewDocument({source: <browser-helper>, runImmediately:
true})`, ідентифікатор зберігається. Джерело — фіксований код із підставленим nonce (9.6).
   - Helper виконується раніше за код сторінки на кожному документі й фреймі.
   - Він бере оригінальні `console.context("kosmo-tui")`, `JSON.stringify`, `Object.keys` і
     `getOwnPropertyDescriptor`.
2. `Runtime.enable`: повтор старих повідомлень до відповіді відкидається, як у 9.3.
3. `Debugger.enable` → `setAsyncCallStackDepth(32)` → `setBlackboxPatterns(["/node_modules/",
"/@vite/client", "/@react-refresh", "/@id/__x00__", "^webpack-internal:///.*/node_modules/",
"/_next/static/chunks/.*next_dist"])`.
4. `setSkipAllPauses(<бажане значення>)`: `true`, лише коли не озброєно жодного `B`.
   - Chrome скидає цей прапорець на кожному reload і навігації, тому **поточне** бажане значення
     надсилається знову на кожен новий документ головного фрейму (`Page.frameNavigated`).
   - Пауза, що прийшла в цьому проміжку, коли жоден `B` не озброєний, можлива лише від `debugger;` у
     коді сторінки. Для браузера, запущеного kosmo-tui, вона продовжується автоматично й рахується як
     `skipped pause (reload gap)`. Це виняток з 9.8: інших клієнтів у pipe-режимі, крім наших власних
     сесій, немає.
5. Перевірки `process.pid` немає. Identity в режимі запуску — наш pipe, у fallback — pid слухача.
6. **Helper у контексті** (9.5 п.5) у браузері означає: типовий контекст фрейму ініціалізованої сесії.

### 10.5 Скрипти й карти за бандлерами

| Бандлер                          | Скрипти                                                                               | Карти                                                             | HMR                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Vite 7 (+ React)                 | ES-модулі `/src/App.tsx`                                                              | inline `data:`, `sources` — самі імена файлів, `sourcesContent` є | url стає `/src/App.tsx?t=<ts>` (новий hash)                                        |
| React Router 7 (framework, Vite) | `/app/root.tsx`, `/app/routes/*.tsx`, віртуальні `/@id/__x00__virtual:react-router/…` | inline, імена файлів                                              | як Vite                                                                            |
| Next webpack (клієнт)            | eval-скрипти `webpack-internal:///(app-pages-browser)/./src/…`                        | inline, абсолютні шляхи                                           | той самий url, новий hash                                                          |
| Next Turbopack (клієнт)          | `/_next/static/chunks/<id>._.js`                                                      | окремий `.map` через HTTP, index map                              | `<chunk>.js?id=%255Bproject%255D/<file>+[app-client]+(ecmascript)` з inline-картою |

- **Шляхи джерел** зіставляються за 9.4. Базові імена Vite розв'язуються відносно url скрипта, а
  http-шлях приєднується до кореня dev-сервера (cwd процесу, чий порт відкрито).
- **Окремі карти через HTTP:**
  - URL карти розв'язується відносно url скрипта;
  - схема `http:`, origin той самий, що в скрипта, хост `localhost`, `127.0.0.1` або `[::1]`, і
    кожна DNS-відповідь — loopback;
  - `redirect: "error"`, без cookies, таймаут 5 с, ліміт 32 MiB, через `http.Agent` з 9.3;
  - `/__nextjs_source-map?…` не завантажується ніколи;
  - помилка записується на скрипт: `map-fetch-failed(cross-origin | non-loopback | http-<status> |
too-large | timeout)`.
- **Фейки React у браузері** (`about://React/Server|Client/…`) виключаються з кандидатів. Інакше
  файл Server Component розв'язався б у браузері через карти з `/__nextjs_source-map`.
- **Озброєння** — сайти з `scriptHash` (9.5 п.6) плюс перерозв'язання на кожен `scriptParsed` з новим
  hash. `setBreakpointByUrl(url)` не використовується.
- **Перший рендер** (mount) на вже відкритій сторінці пропускається: скрипт виконався раніше, ніж
  точку озброєно, і точка має стан `armed after first run`. `:reload-armed` (з підтвердженням, бо
  заново виконує код сторінки) робить `Page.reload` після озброєння. Hash-сайти озброюють ідентичні
  скрипти раніше, ніж ті виконаються, а самодостатня умова (9.6) дає замасковані хіти з першого
  проходу нового документа. Так mount-рендери й effects ловляться без пауз.

### 10.6 React у Hits

- **Dev StrictMode:** тіло компонента виконується 2 рази за рендер. Mount-effect: setup, cleanup,
  setup. Документація пояснює, що кількість хітів — не кількість commit'ів.
- **Batching:** 20 синхронних кліків дають 20 хітів обробника і 2 хіти рендеру.
- **Hydration** React Router рендерить route 2 рази з `loaderData` із сервера.
- **`clientLoader`** виконується на hydration, якщо `clientLoader.hydrate === true` або route не має
  server loader'а; інакше — ні.
- **Захоплення:** props (імена листків деструктуризації), змінні стану, аргументи подій (зведення 9.6).
- **Owner stacks React 19** приходять як async-батьки (`<Counter>`, `"use client"`) і видні в повному
  стеку. Окремий шлях компонентів — поза обсягом.

### 10.7 Один файл у Node і в браузері

Route-файл React Router чи Next виконується і в SSR, і в клієнті. Маршрутизацію точок за `runtime`,
заголовок і клавіші при двох target'ах описано в 9.3. Хіт має позначку `node`, `edge` або `browser`.

### 10.8 Безпека і завершення браузера

- **Що дає target:**
  - target сторінки — повний контроль над її origin'ом (`document.cookie`, `localStorage`);
  - endpoint браузера — всі cookies профілю, зокрема HttpOnly.
- **Тому:**
  - тимчасовий профіль, pipe за замовчуванням, лише loopback;
  - використовуються лише домени `Page`, `Runtime`, `Debugger`, `Target` і метод `Browser.close`;
  - `Storage`, `Network`, `Cookie` не використовуються.
- **README попереджає:**
  - вікно DevTools, яке користувач відкриє в запущеному браузері, бачить кожне повідомлення
    kosmo-tui `console.trace`;
  - код сторінки бачить ключі `Symbol.for`, може видалити чи підмінити helper і підробити хіти (nonce
    від цього не захищає). Обсяг обмежує лише захист частоти. Пауза неможлива, бо умова завжди
    закінчується `, false`.
- **Завершення запущеного браузера** (у рамці 9.9):
  1. resume нашої паузи;
  2. `Browser.close`, до 1 с чекати виходу;
  3. SIGTERM групи, до 1 с чекати;
  4. SIGKILL групи;
  5. `rmSync(profile)`.

  Прибирання окремих сторінок тут не потрібне. Той самий шлях синхронно виконується з
  `uncaughtException` і SIGHUP.

- **Завершення для `:attach-browser`**, у кожній ініціалізованій сесії:
  1. зняти сайти;
  2. `Page.removeScriptToEvaluateOnNewDocument`;
  3. видалити helper у кожному живому контексті;
  4. `Runtime.discardConsoleEntries`;
  5. `Debugger.disable`;
  6. `Target.detachFromTarget`.
- **Коли сесія сторінки закінчується:** на `Target.detachedFromTarget`, `targetDestroyed`, EOF pipe'а
  або закритті сокета. **Ніколи** — на `executionContextsCleared`/`executionContextDestroyed`: їх
  спричиняють навігація, reload і знищення iframe'ів.

## 11. Підтримка фреймворків

### 11.1 Node.js

| Запуск                                                                                                           | Що бачить kosmo-tui                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --inspect app.js` / `.mjs`                                                                                 | url `file:///abs`, без карти                                                                                                                      |
| `.ts` з нативним type stripping (за замовчуванням з 22.18; на 22.13–22.17 потрібен `--experimental-strip-types`) | url `file:///abs/x.ts`, `hasSourceURL: true`, позиції точні, карти немає                                                                          |
| `--experimental-transform-types`                                                                                 | url той самий `.ts`, але рядки зсунуті; inline-карта з `file://` без `sourcesContent`                                                             |
| `tsx --inspect`                                                                                                  | два процеси (батько без інспектора, дитина з інспектором); inline-карта з абсолютними шляхами; CJS-вихід — весь модуль у рядку 2, ESM — у рядку 1 |
| `ts-node --transpile-only`                                                                                       | один процес, inline-карта, рядки зсунуті                                                                                                          |
| `node --watch --inspect`                                                                                         | supervisor (не слухає) + дитина; перезапуск → новий pid, UUID, а з `:0` — новий порт                                                              |

Порада в README: передавати `--inspect` застосунку (`tsx --inspect`, `nest start --debug`), а не
через `NODE_OPTIONS` на supervisor'і. Інакше порт захоплює supervisor (`tsx`, `nest`, `npm run`), а
застосунок лишається без інспектора.

### 11.2 Express 4 і 5

- Трейс: шари — брати (4.13). Live stack: синхронний `next()` вкладає попередні middleware, тож шлях
  handler'а виглядає як `requestLogger → auth → getCart` (9.6).
- Внутрішні кадри різняться між версіями: Express 5 — `handleRequest`/`trimPrefix`/`processParams`,
  Express 4 — `handle`/`trim_prefix`/`process_params` плюс вбудовані `query` і `expressInit`. Шлях Hits
  їх згортає, а тести перевіряють лише кадри користувача.
- Async-помилка: Express 5 передає відхилений promise в error handler (у його стеку кидаючого кадру
  немає, він є лише в `err.stack`). Express 4 дає `unhandledRejection`, запит зависає, а без обробника
  процес падає. Це видно як `target error`, а якщо процес виходить — як `waitingForDisconnect` →
  detach.
- Захоплення `req`/`res` — зведення 9.6. Сирий `req` на глибині 2 — це ~3 KB внутрішніх полів Node.

### 11.3 NestJS 10/11

- **Дебажити з скомпільованого виходу:** `nest start --debug [--watch]` (CLI запускає дитину
  `node --enable-source-maps --inspect dist/main`), `node --inspect dist/main.js` або ts-node.
  Нативний type stripping на Nest падає (декоратори, parameter properties), а під tsx ламається
  DI через конструктор (esbuild не видає `design:paramtypes`). README це пояснює.
- **Карти:**
  - tsc: `dist/x.js.map`, `sources: ["../src/x.ts"]`, `sourceRoot: ""`, без `sourcesContent`;
  - swc: та сама відносна форма з `sourcesContent`, відображення немонотонні.
    Обидві карти читаються з диска всередині кореня.
- **Watch:** кожна успішна компіляція вбиває дитину й запускає нову (9.3 «Кінець сесії»). swc-builder
  стартує двічі.
- **Порядок enhancer'ів** видно в порядку хітів:
  - OK: middleware → guard → interceptor (до) → pipe → handler → service → interceptor (після);
  - помилка pipe: → pipe → filter;
  - guard повернув `false`: → guard → filter.
    На live stack guard і pipe — уже завершені брати. Шлях handler'а: `use → intercept → getCart`.
- **Захоплення контексту:** зведення `ExecutionContextHost` (9.6) показує клас, handler і
  `req.method`. Без нього `args[0]` обрізався б до `deeper`.
- У `/json/list` url дитини — `file://` з порожнім шляхом (точка входу без розширення); це впливає
  лише на показ.

### 11.4 Next.js 15.5 і 16

- **Процеси:** `next dev` — supervisor (`node …/next/dist/bin/next dev`) плюс рівно одна довгоживуча
  дитина `next-server (vX)`. Вона тримає HTTP-порт і виконує весь код застосунку в одному isolate.
  Turbopack окремого Node-процесу не додає.
- **Порти інспектора:**
  - `NODE_OPTIONS=--inspect=127.0.0.1:P next dev` (15.5 і 16): supervisor на P, `next-server` на P+1;
  - `next dev --inspect=127.0.0.1:P` (лише 16): інспектується лише `next-server`, на P;
  - 15.5 відхиляє прапорець `--inspect`;
  - 15.5 з `NODE_OPTIONS=--inspect=0` — дитина отримує порт 1 і падає;
  - два одночасні `NODE_OPTIONS=--inspect next dev` — другий сервер без інспектора;
  - `NODE_OPTIONS=--inspect-wait` — supervisor чекає на дебагер, а `next-server` не може зайняти порт.
    Targets показує лише підказки, які можна виявити (9.2 п.6): інспектується тільки supervisor;
    supervisor у `waiting-for-debugger`; `next-server` без інспектора. Решту пасток і рекомендовані
    команди описано в README.
- **Де виконується код:**

| Контекст                                  | Що там                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `next-server`, типовий контекст           | RSC, SSR клієнтських компонентів, route handlers, server actions (шар `action-browser`), instrumentation, Node-middleware (15.5 `runtime: 'nodejs'`), `proxy.ts` (16)          |
| `next-server`, vm-контекст `Edge Runtime` | `middleware.ts` (edge за замовчуванням), route'и з `runtime: 'edge'` — через Edge-helper (9.6)                                                                                 |
| Не під'єднано kosmo-tui                   | `generateStaticParams`/`getStaticPaths` (окремий worker без `--inspect`), валідація cacheComponents у 16 (worker_thread), проби `'use cache'` (пул worker'ів), production edge |

Виявити, що точка стоїть саме в такому коді, неможливо: модуль зазвичай завантажено й у
`next-server`, тож точка має `resolved (N scripts)` і просто не отримує хітів. Тому Hits для
Next-target'а показує під точкою з 0 хітів фіксовану примітку: «код у `generateStaticParams`, dev
validation чи проби `'use cache'` виконується у worker'ах, до яких kosmo-tui не під'єднується
(11.4)». Нічого при цьому не стверджується.

- **Скрипти:**
  - webpack — eval-source-map на модуль (`webpack-internal:///(<layer>)/./src/…`, inline-карта з
    абсолютними шляхами);
  - Turbopack — chunk'и `.next/[dev/]server/chunks/*.js` з картами на диску (index maps), кілька
    модулів в одному chunk'у;
  - Server Fast Refresh у 16 — eval-скрипт `…?id=[project]/<file>+[<layer>]+(ecmascript)`.
    webpack перевиконує модулі з тим самим hash навіть без правок, і це закриває `scriptHash`.
- **Перезапуск:** правка `next.config.*` перезапускає `next-server`. `waitingForDisconnect` приходить за
  ~20 мс → detach → новий pid на тому самому порту → `target restarted · Enter reattach`.
- **Видимі побічні ефекти:** `next dev` друкує `Debugger attached.` і повний ws URL у свій термінал.
  Next 16 пише `AGENTS.md`/`CLAUDE.md` у директорію застосунку, якщо не задано `agentRules: false`
  (тестовий застосунок це задає).

### 11.5 React

- **Серверна частина** (SSR, RSC у Next, React Router, Vite SSR) — Node-target етапу 2.
- **Клієнтська частина** — браузер етапу 3 (розділ 10).
- Особливості StrictMode, Suspense і hydration описано в 10.6. Suspension React 19
  (`SuspenseException`) продюсер записує як `suspended` (4.4).
- React 18 не має owner stacks; повтор StrictMode в ньому відрізнити не можна.

### 11.6 React Router 7 і Vite SSR (зокрема storefront)

`react-router dev` і `sfnext dev` — один процес: Vite у middleware mode. SSR-модулі — це
`new AsyncFunction` з `//# sourceURL=<абсолютний шлях>` та inline-картою (9.4). Той самий route-файл
виконується і в SSR, і в клієнті (10.7). Специфіку storefront описано в 14.3.

## 12. Стани «немає даних» і помилки

Спільного стану `unavailable` немає: кожен стан має власну причину.

| Де                              | Стани                                                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Відкриття                       | `file-not-found`, `too-large`, `not-a-kosmo-trace`, `not-a-kosmo-trace-store`, `unsupported-version`, `invalid(<позиція>: <що>)`, `trace-too-large(N)`                                                                      |
| NDJSON / stdin                  | `reading… N spans`, `no-controlling-terminal`, `stream stopped at line N: <reason>`, `stream stopped: too-large`, `N unknown lines skipped`                                                                                 |
| Батько                          | `unknown(ambiguous)`, `unknown(missing)`, `cycle`                                                                                                                                                                           |
| Location / snippet / attrs      | `no location`, `invalid-location`, `invalid-snippet`, `invalid-attrs`, `invalid-attrs(N)`                                                                                                                                   |
| Фрагмент коду                   | `ok`, `file-missing`, `outside-root`, `too-large`, `unreadable`, `not-text`, `changed-since-trace`, `moved to line N`                                                                                                       |
| Значення                        | `recorded`, `truncated` (`viewer-cap`), `masked`, `not-recorded(reason)`, `live`, `invalid-value(<позиція>)`, `unknown-tag`, `loading` (SQLite), у live — `unavailable` на ім'я                                             |
| Можливість                      | `reload: unavailable(stdin-stream)` та інші `<capability>: unavailable(<reason>)`                                                                                                                                           |
| Рядок Targets (Node)            | `unverified`, `tool process, not your app`, `supervisor (no app code)`, `inspector-off`, `inspector-port-busy (best guess)`, `inspector-enable-timeout`, `restarted`                                                        |
| Сесія Node (заголовок)          | `waiting-for-debugger`, `pid-mismatch`, `exited`, `target restarted (pid A → B) · Enter reattach`, `resumed by another client`, `message-too-large`, `target error`                                                         |
| Браузер                         | `browser-not-found`, `browser-exited`, `default-profile-refused`, `remote-allow-origins-unsafe`, `non-loopback-page`, `skipped pause (reload gap)`                                                                          |
| Дія дебагера (відмова `b`/`B`)  | `no-location`, `invalid-location`, `runtime-not-attached`, `not-attached`                                                                                                                                                   |
| Логічна точка (9.5 п.8)         | `pending`, `resolved @file:line (N scripts)`, `re-anchored`, `armed after first run`, `failed(map-mismatch \| ambiguous-source \| no-breakable-location \| no-helper-in-context)`, `auto-removed`, `removed: cap N reached` |
| Нотатки точки / скрипта / сайту | `map-untrusted`, `map-fetch-failed(<reason>)`, `capture error`, `unchecked passes`, `non-matching passes: N`, примітка про worker'и Next (11.4)                                                                             |
| Кадр                            | `≈ <рядок>` (недостовірна карта без відповідності), `re-anchored`, `✓`                                                                                                                                                      |
| Позначки хіта                   | `node`, `edge`, `browser`, `edge sandbox · sync stack only`, `≈ recorded <span>`                                                                                                                                            |

## 13. Тестування

### 13.1 Фікстури без callflow

- **Builder і writers.** `test/trace-builder.ts` будує dataset у коді. Один writer записує той самий
  dataset як `.kosmo-trace.json`, `.ndjson` і `.sqlite` (через `node:sqlite` `DatabaseSync` у режимі
  запису). Тест рівності читачів замінює `cross-source-parity.test.ts`.
- **`test/fixtures/kosmo-trace/`** — закомічений набір:
  - кілька сесій, батьки з інших сесій;
  - `ambiguous`, `missing`, `cycle`;
  - усі статуси, стани значень і теги;
  - явні, похідні, `node_modules` і `(unknown)` області;
  - link'и.
- **`test/fixtures/frameworks/`** — трейси у формі фреймворків (усі з нулем runtime-залежностей):
  - `express-chain` — ланцюг middleware братами, error handler, завислий шар, два запити;
  - `nest-pipeline` — OK, `403` від guard'а, `400` від pipe'а, `app.use()` поряд із `nest.middleware`;
  - `react-strict` — дублікати StrictMode, effect setup/cleanup, `suspended`;
  - `next-action` — межа browser → node через `parentSession`; middleware в обох формах: edge-sandbox
    у `next dev` і deployed edge перед `http.server`;
  - `attrs-hostile` — поганий ключ, 33 ключі, рядок 513 B, `null`, масив, об'єкт, ключ, що
    маскується, C1/bidi.
- **`test/fixtures/hostile/`** (у `.prettierignore`) — ворожа матриця 13.3.
- **`test/fixtures/project/`** — дерево коду для всіх станів фрагмента: symlink за межі кореня,
  змінений рядок, зсунутий рядок, CRLF, табуляції. Файл понад 2 MiB генерується під час тесту.
- **`examples/`:**
  - `examples/demo.kosmo-trace.json` і його код — для README (там і NDJSON-продюсер на ~20 рядків);
  - `examples/storefront/cart-and-pdp.kosmo-trace.json` — трейс, написаний вручну, для двох
    loader'ів критерію 5, прив'язаний до `storefront-next-template@1a5b952b`.
- **`docs/superpowers/specs/evidence/2026-09-24-probes/`** — скрипти проб 14.2 (докази й відправна точка
  для інтеграційних тестів; не збираються і не запускаються `npm test`).

### 13.2 Інваріанти, що мусять пережити перенесення

- Allowlist змінних середовища clipboard і пошук за абсолютним PATH (S-L3).
- Відновлення терміналу на SIGINT/SIGTERM/SIGHUP і при неперехопленій помилці.
- Повна ідентичність span'а: однаковий `id` у різних сесіях — різні span'и.
- Батьки з інших сесій (колишній R-L4 → правило 4.3 п.3.2).
- `sanitize` до wrap/fit для кожного рядка з даних; другий шар у `paint`.
- Інваріанти `open-viewer` (5.2): raw mode після EOF, `q` до відкриття, exit 130, EPIPE.

### 13.3 Unit

- **Валідатор і ворожа матриця:**
  - вкладеність 65, id > 256 B (зокрема з кирилицею), рядок NDJSON > 1 MiB;
  - керівні й bidi-символи, `..`/абсолютні шляхи;
  - дублікати span'ів і `order`, `parentSession` при `parent: null`;
  - невідомі теги, `unavailable` у файлі, `version: 2`, невідомі enum'и, другий `header`;
  - матриця `attrs`;
  - паритет зі схемою (4.10).
- **Модель:**
  - усі гілки розв'язання батьків і циклів, повнота порядку;
  - незалежність дерева від порядку span'ів — property-тест на кожній фікстурі;
  - області (зокрема `node_modules` і pnpm), статус трейсу, link'и.
- **`kosmo-text/v1`:**
  - golden-файли для json, ndjson і sqlite та для фікстур фреймворків;
  - байтовий ліміт, детермінізм, граматика (kind, `http`, позначки);
  - `--format tab`/`json` і таблиця 7.1.
- **UI фреймворків:**
  - шари Express показуються братами, у error handler'а є `⤳`;
  - guard показує `→ false (denied)`;
  - `⧉strict`, роздільник сесій, `:filter kind nest.*`;
  - блок `attrs`;
  - жодних вигаданих діагностик.
- **Інше:**
  - `sanitize`, `paint`, маскування 8.3 (`tokenizer`, `sessionStorage`, `csrfToken`, `auth`,
    `Bearer …`, JWT, query-рядки);
  - snippet'и й усі стани 6.4;
  - визначення контейнера 6.8;
  - відсутність статичного імпорту `node:sqlite`.
- **Етап 2:**
  - декодер source maps проти оракула на реальних картах: Vite SSR, Vite client (імена файлів), tsc,
    swc (немонотонні), esbuild/tsx (один рядок), webpack eval, Turbopack index map, transform-types;
  - нормалізація джерел (усі форми 9.4), перепривʼязування на синтетичній «брехливій» карті;
  - розбір параметрів, фільтр імен, зведення 9.6 (без виклику getters), розбір `ps`/`lsof`/`ss`,
    виявлення supervisor'ів.

### 13.4 Session і PTY

- **Session-тести** з фейковими портами (як зараз `session-fakes.ts`):
  - екрани start/traces/trace і помилки відкриття зі стартового екрана;
  - клавіші та пріоритет, панелі;
  - розмір detail (кадри 80×24 і мінімальний);
  - `-r`;
  - закриття з дебагером у будь-якому стані;
  - Targets з групами supervisor'ів і `target restarted`.
- **PTY-тести** через справжній bin:
  - відкриття json/ndjson/sqlite;
  - stdin з керуючим терміналом і NDJSON-продюсером `node -e`, що пише, робить паузу й завершується
    (клавіші під час і після EOF, повернення raw mode, EPIPE при ранньому виході);
  - без керуючого терміналу — exit 1 з підказкою;
  - відновлення терміналу на SIGINT/SIGTERM/SIGHUP.

### 13.5 Інтеграційні тести дебагера

**Каркас.**

- Інтеграційні тести керують `src/debug/*` напряму через тестовий порт, без PTY.
- Тестовий код може надсилати `Runtime.evaluate` у **власну** сесію. Так він клацає кнопки і читає
  монітор проміжків `setInterval(10)` на сторінці. Правило 9.1 обмежує kosmo-tui, а не тести.
- Debuggee запускаються з `--inspect=127.0.0.1:0` (для тесту SIGUSR1 — `--inspect-port=0`).
  Перевірки фільтруються за pid, який запустив сам тест. Єдиний тест порядку проб на 9229 іде окремо.
- Інтеграційні тести мають окремий vitest-project з `fileParallelism: false`, явними таймаутами й
  опитуванням готовності (`Ready`, `PORT`, `Debugger listening`).
- Номери рядків беруться з маркерних коментарів під час тесту, ніколи не жорстко.
- **Вікно вимірювання** проміжків і пауз — від першого `setBreakpointByUrl` точки до останнього
  очікуваного хіта, без навігації всередині. `Debugger.paused` рахуються за всю сесію, включно зі
  `skipped pause (reload gap)`. Тестові застосунки не містять `debugger;`, тож будь-яка така пауза —
  провал.
- `KOSMO_TUI_E2E=1` (у CI): відсутній браузер чи застосунок — провал, а не пропуск.

**Базовий набір Node** (`test/apps/node/`, без встановлення пакетів). Створюється в зрізі 1
етапу 2, і кожен зріз додає свої сценарії:

- зріз 1 — discovery: групи supervisor'ів (`node --watch`, дерево `pnpm → sh → cross-env → node`),
  розбір `ps`/`lsof`/`/proc`, фейковий проксі при `NODE_USE_ENV_PROXY=1` (0 з'єднань через проксі);
- зріз 2 — перевірка pid, зокрема `--inspect-brk`/`--inspect-wait`; detach; вихід процесу з
  під'єднаним клієнтом без зависання; Ctrl+C; `node --watch`: перезапуск → `target restarted` →
  reattach;
- зріз 3 — tracepoint: без паузи (проміжок ≤ 50 мс), нічого в stdout/stderr, `unavailable` на ім'я,
  повтор консолі при повторному attach не дає хибних хітів, кеп і захист частоти на гарячому рядку,
  `debugger;` не зупиняє при `skipAllPauses`, `vm.createContext` не рве сесію, монотонний `seq`;
- зріз 4 — CJS, ESM, strip (на 22.13–22.17 з `--experimental-strip-types`), transform-types,
  `AsyncFunction` + `//# sourceURL`, HMR-подібне перевиконання (`scriptHash`) без подвійних хітів,
  порожній url з `data:`-картою;
- зріз 4 — точка на `export const f = async () => {…}`, `export async function f() {…}` і
  однорядковій стрілці, з `column` і без нього: хіт на кожен виклик, а не один при завантаженні
  модуля;
- зріз 5 — модуль у формі storefront: `AsyncFunction` з `//# sourceURL=<abs>` та inline-картою, чий
  `sourcesContent` — перегенерований Babel'ом TS (рядки зсунуті, типи збережені). Очікується
  `re-anchored` і хіти на маркерному рядку, або `failed(map-mismatch)`, але ніколи хіт на іншому
  рядку. Верхній кадр показує рядок логічної точки;
- зріз 6 — `B` на тому самому span'і, що й `b` (один сайт), кроки, приписування пауз, від'єднання під
  час паузи, «той самий випадок»;
- зріз 7 — SIGUSR1 дитині (не supervisor'у) і закриття порту.

**Фреймворки Node** (`test/apps/{express,nest,next}`, власні `package.json` і lockfile, job
фреймворків, зріз 9 етапу 2):

- `express` (express@5 і `express4: npm:express@4.22.1`) — шлях `requestLogger → auth → getCart`,
  зведення `req` з маскуванням (`authorization`, `cookie`, `x-api-key`, `Bearer …`), async-помилка
  в 5 і `target error` в 4;
- `nest` (Nest 11; tsc у globalSetup, опційно swc; без `@nestjs/cli`, окремий тест із
  `KOSMO_TUI_E2E_NEST_CLI=1`):
  - порядок хітів enhancer'ів за `seq` для трьох сценаріїв;
  - контекст guard'а;
  - пауза в handler'і (3 синхронні кадри + async, `this` = контролер);
  - watch-перезапуск;
- `next` (у PR — 16.x Turbopack; 15.5.x webpack — nightly; `agentRules: false`, `rm -rf .next` перед
  прогоном, `NEXT_TELEMETRY_DISABLED=1`):
  - discovery (supervisor + `next-server`);
  - по 1 хіту на route handler / lib / RSC / SSR клієнтського компонента / server action;
  - фейки React не рахуються;
  - edge middleware через Edge-helper (без нього — `failed(no-helper-in-context)`);
  - HMR, перезапуск через `next.config`, SIGUSR1;
- `rr7`, серверна частина (не обов'язково) — tracepoint на loader'і в `react-router dev`.

**Браузер без встановлення пакетів** (`test/apps/browser-basic/`, створюється в зрізі 1 етапу 3).
Вміст: сервер `node:http`, класичний скрипт, ES-модуль з картою з іменами файлів, chunk з
index-картою через HTTP, eval з `webpack-internal://` і зсувом, worker, OOPIF, перехід на
не-loopback сторінку. Сценарії:

- запуск через pipe без LISTEN-сокета; профіль 0700 видаляється, зокрема після SIGKILL kosmo-tui при
  наступному старті;
- tracepoint без паузи, async-ланцюжок, маскування;
- хуки консолі сторінки нічого не бачать;
- повтор для другого клієнта (друга flat-сесія на ту саму сторінку) ігнорується;
- reload: сесія жива, helper відновлено, `scriptHash`-сайт ловить перший тік, хіти замасковані ще до
  будь-якого `arm`;
- карти (зокрема корінь dev-сервера, відмінний від кореня трейсу — monorepo), OOPIF, worker не
  лишається на паузі, popup ініціалізовано, `non-loopback-page`;
- гарячий рядок; detach прибирає все.

**Фреймворки в браузері** (`test/apps/{vite-react,rr7,next}`, job фреймворків, зріз 7 етапу 3):

- `vite-react` (Vite 7 + plugin-react 5 + React 19):
  - клік дає 1 хіт обробника з props і шляхом та 2 хіти рендеру;
  - монітор проміжків на сторінці ≤ 50 мс, 0 `Debugger.paused` (критерій 6);
  - через `:reload-armed` — 2 хіти mount-рендеру і 2 хіти effect'у, з 0 пауз;
  - HMR `?t=` дає хіти лише з нового скрипта;
- `rr7` (React Router 7, framework mode) — route має і `loader`, і `clientLoader` без `hydrate`:
  hydration дає 2 хіти рендеру і 0 хітів `clientLoader`. Той самий файл озброюється і в Node-target;
- `next` (клієнт):
  - сторінка відкрита через `localhost` і гідрується;
  - tracepoint на обробнику кліку в `'use client'` компоненті — 1 хіт на клік, 2 хіти рендеру;
  - фейки `about://React` не рахуються, 0 запитів до `/__nextjs_source-map`;
  - HMR через `?id=` (Turbopack) і той самий url з новим hash (webpack, nightly).

### 13.6 CI

- **Основний job** (Node 22.13.0 — нижня межа `engines`, 22.x, 24.x): unit-, session- і PTY-тести,
  базовий набір Node і `browser-basic`. Chromium ставиться через `npx playwright install --with-deps
chromium` з кешем. `KOSMO_TUI_E2E=1`.
- **Job фреймворків** (Node 22.x і 24.x): встановлює `test/apps/*` (кеш за lockfile) і Chromium,
  `KOSMO_TUI_E2E=1`, тести фреймворків 13.5.
- **Nightly, не блокує:** Next 15.5 webpack і Turbopack, 16 webpack, `next@latest` і canary, Node Current.
- `test/apps/**` виключено з кореневих `tsconfig.json` і `vitest` include, а також із `prettier`.
- Без callflow-tarball'ів і без комірок SQLite-драйвера.

## 14. Докази й ризики

### 14.1 Дослідження

- **З досліджень kosmo-callflow** (`docs/research/*`, `docs/contracts/tui-boundary.md`,
  `docs/plans/2026-09-20-text-trace-format-and-sequencing.md`, `docs/plans/2026-09-21-cli-tui-design.md`,
  `docs/experiments/trace-text-fixtures.md`, `docs/validation/2026-09-23-extract-tui-validation.md`)
  узято:
  - повну ідентичність span'а і заборону вгадувати батьків;
  - типізовані відсутні значення й окремість порядку і часу;
  - ліміти й позиційні помилки, байтовий ліміт текстової проєкції;
  - екранування C0/DEL/C1, чисті reduce/render;
  - семантику фреймворків: порядок enhancer'ів Nest, ланцюг Express, життєвий цикл React.
- **OpenTelemetry semconv:** HTTP-атрибути, SpanKind SERVER/CLIENT, правило статусу 4xx/5xx.
- **Дослідження CDP:** 5 напрямків, кожен перевірив окремий рецензент.
- **Самоперевірка spec v1:** 4 боки з перевіркою скептиком.
- **Дослідження фреймворків:** Next 15.5.25 і 16.3.6 (webpack і Turbopack), Express 4.22.1 і 5.2.1,
  Nest 11.2.5 (tsc, swc, CLI 11.0.24), tsx 4.23, ts-node 10.9, Vite 7.3.5, React 18.3 і 19.2,
  React Router 7.18, Chrome 153 і Chrome for Testing 149. Кожен напрямок перевірив скептик.
- **Друга самоперевірка (v3):** 3 боки зі скептиком, зокрема експерименти на V8 (старт breakpoint'а
  з заголовка стрілкової функції, дубль breakpoint'а в одному місці, `sourceURL` з пробілами).
- Скрипти проб лежать у `docs/superpowers/specs/evidence/2026-09-24-probes/`.

### 14.2 Проби (Node 22.22.0 і 25.2.1; Chrome 153)

| Перевірка                                                           | Результат                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracepoint через умову `(…, false)`                                 | 0 пауз, найбільший проміжок між тіками 12–16 мс при інтервалі 10 мс (Node і Chrome)                                                            |
| `console.context("kosmo-tui").trace`                                | синхронні кадри + async-ланцюжок; нічого в stdout/stderr процесу чи в хуках консолі сторінки                                                   |
| Значення                                                            | приходять разом із секретами → маскування в helper'і обов'язкове                                                                               |
| Один closure на всі імена                                           | одне TDZ-ім'я губить усі значення хіта                                                                                                         |
| Thunk на ім'я                                                       | решта значень на місці, помилки поіменно; `() => this` працює; `({ this })` — SyntaxError                                                      |
| Повторний attach                                                    | `Runtime.enable` повторює хіти попередньої сесії, усі до відповіді на `enable`                                                                 |
| `setSkipAllPauses(true)`                                            | `debugger;` не зупиняє, умови працюють; у Chrome скидається на кожному reload                                                                  |
| Пауза після нашого `stepOver`                                       | `hitBreakpoints: []` → потрібна епоха кроку                                                                                                    |
| `vm.createContext` + GC; контексти Next                             | `executionContextDestroyed` для не-типових контекстів при живому процесі                                                                       |
| `NodeRuntime.waitingForDisconnect`                                  | при виході, аварії й перезапуску `next-server` (~20 мс після правки `next.config`)                                                             |
| `setBreakpoint(scriptId)` + `setBreakpointByUrl(scriptHash)`        | два хіти на прохід; hash сам озброює поточний і ідентичні перевиконані скрипти (Node, webpack, Chrome reload)                                  |
| `--inspect-brk` / `--inspect-wait`                                  | `process.pid` = `undefined` до `runIfWaitingForDebugger`                                                                                       |
| `NODE_USE_ENV_PROXY=1`                                              | `fetch`/`http.get` на 127.0.0.1 ідуть через проксі; `NO_PROXY` + новий `http.Agent` — 0 з'єднань                                               |
| Предикат «той самий випадок», 200 рідких проходів (не гарячий цикл) | умова V8 ~4.7 мс; пауза + `evaluateOnCallFrame` + resume 162–199 мс                                                                            |
| Node, гарячий рядок, 200 000 викликів                               | 4.6 мс → 17.5–24.3 с з tracepoint'ом (кеп у процесі не допомагає); клієнтський `removeBreakpoint` після 5 хітів — 2.6–3.9 мс, 6–7 хітів        |
| Chrome, гарячий рядок                                               | 200 000 викликів: 0.6 мс → 16.7 с (~84 мкс/прохід); 20 000 викликів: 0.9 мс → 2138 мс, з `removeBreakpoint` після 100 хітів — 20 мс і 102 хіти |
| Старт з заголовка `const f = async () => {`                         | `getPossibleBreakpoints(restrictToFunction)` повертає місця модуля; старт усередині тіла — місця функції                                       |
| Другий breakpoint у тому самому місці з іншою умовою                | `Breakpoint at specified location already exists`                                                                                              |
| `sourceURL` з пробілом у шляху                                      | V8 його відкидає; url скрипта порожній                                                                                                         |
| Tracepoint'и в `next-server`                                        | route handler, lib, RSC, SSR клієнтського компонента, server action — по 1 хіту на запит, 0 пауз                                               |
| Фейки React Flight                                                  | RSC-tracepoint без виключення: 9 хітів замість 1 (8 фейків з `ReferenceError`)                                                                 |
| Edge middleware Next                                                | helper типового контексту в `Edge Runtime` мовчки не спрацьовує; `addBinding` + helper на контекст працюють                                    |
| `ps comm` на macOS                                                  | `next-server (v16` після `process.title`; `ucomm` лишається `node`; `comm` не в останній колонці обрізається                                   |
| tsx                                                                 | весь модуль в одному згенерованому рядку; точна до колонки позиція дає хіти                                                                    |
| `node --watch`, `nest --watch`                                      | новий pid, UUID (а з `:0` — порт) за ~0.3 с; `executionContextDestroyed` старому сокету не приходить                                           |
| SIGUSR1 на supervisor'і `tsx`/`nest`                                | інспектор відкривається в supervisor'і; перевірка pid це не ловить                                                                             |
| Порядок хітів Nest 11                                               | middleware → guard → interceptor → pipe → handler → service → interceptor (після); однаково для tsc, swc, CLI, ts-node                         |
| Vite, карти в браузері                                              | `sources` — самі імена файлів; без розв'язання відносно url карти не збігається нічого                                                         |
| Chrome, pipe                                                        | немає LISTEN-сокета; браузер завершується разом із батьком                                                                                     |
| Chrome, auto-attach з фільтром без worker'ів                        | виключені worker'и назавжди на паузі                                                                                                           |
| React 19 StrictMode (Vite)                                          | mount: 2 хіти рендеру і 2 хіти effect'у; клік: 1 обробник і 2 рендери                                                                          |
| Blackboxing і instrumentation-паузи                                 | Next 15 webpack: 186 пауз / +1.9 с без blackbox'у, 5 пауз / ~10 мс з ним                                                                       |
| Next 16, origin                                                     | сторінка через `http://[::1]` не гідрується (HMR-websocket заблоковано), через `localhost` — гідрується                                        |
| Статичний `import "node:sqlite"`                                    | `ExperimentalWarning` друкується до будь-якого фільтра                                                                                         |

### 14.3 Цільовий проєкт `storefront-next-template@1a5b952b`

- `sfnext dev` — один процес: Vite 7.3.5 у middleware mode, SSR-модулі через
  `vite.environments.ssr.runner.import` у головному isolate. `pnpm dev:debug` запускає його з
  `NODE_OPTIONS=--inspect`.
- Кожен SSR-модуль — `new AsyncFunction` з `//# sourceURL=<абсолютний шлях>` та inline-картою.
- **Недостовірні карти.** `@salesforce/storefront-next-dev@1.3.1` має transform з `enforce: "pre"`,
  який перегенеровує файл через Babel і повертає `map: null` (`dist/index.js:676-681`). Зачеплено 38
  файлів з `<UITarget>`, з них 7 routes, серед них `_app.product.$productId.tsx`. Для них рядки карти
  не збігаються з диском; тут потрібне перепривʼязування (9.5 п.4). Та сама проблема є і в клієнтських
  картах цих файлів (етап 3).
- **Ручна перевірка етапу 2:**
  1. Node ≥ 24 → `pnpm dev:debug`;
  2. `kosmo-tui examples/storefront/cart-and-pdp.kosmo-trace.json --root <шлях до storefront>` → `A`;
  3. target `sfnext dev` (`✓ same project`) → span loader'а → `b`;
  4. запит у браузері → хіти (критерії 5a, 5b).

### 14.4 Ризики

| Ризик                                                                                                             | Що робимо                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Точність перепривʼязування для Babel-перегенерованого коду                                                        | синтетичний тест + критерій 5b; неоднозначність → `failed`, не хибний хіт                                                                                                  |
| Вартість кожного проходу (~80–120 мкс)                                                                            | клієнтський кеп, захист частоти, попередження в панелі                                                                                                                     |
| Пауза блокує весь dev-сервер, включно з Ctrl+C                                                                    | tracepoint як основний режим, `skipAllPauses`, банер, `:max-pause`                                                                                                         |
| Внутрішні деталі фреймворків змінюються між мінорними версіями (url HMR Next, фейки React, формати tsx)           | правила за url — лише виключення й мітки; розв'язання — через карти, `scriptId` і `scriptHash`; зафіксовані версії в тестових застосунках, nightly на `next@latest`/canary |
| Supervisor'и й перезапуски (watch, Next)                                                                          | виявлення supervisor'ів, SIGUSR1 лише дітям, `target restarted` і ручний reattach                                                                                          |
| Секрети в змінних з невинними іменами, в URL                                                                      | маскування значень і query, попередження при attach; повним маскування не буває                                                                                            |
| Код сторінки може підробити хіти                                                                                  | лише захист частоти; пауза неможлива (`, false`)                                                                                                                           |
| DevTools, відкритий користувачем у запущеному браузері, бачить повідомлення kosmo-tui                             | README                                                                                                                                                                     |
| Інший клієнт тримає паузу                                                                                         | приписування пауз, `resumed by another client`, попередження при attach                                                                                                    |
| `Runtime.discardConsoleEntries` очищує історію консолі й для інших клієнтів                                       | SECURITY.md                                                                                                                                                                |
| Глобальний `WebSocket` не обмежує розмір до буферизації                                                           | перевірка після отримання, закриття з'єднання                                                                                                                              |
| Linux без `lsof`/`ss`, Windows                                                                                    | перевірка портів 9229–9239 і `:attach`                                                                                                                                     |
| `node:sqlite` — Stability 1.1 на 22.x/24.x                                                                        | нижня межа 22.13.0 у CI; динамічне завантаження після фільтра попереджень                                                                                                  |
| Не перевірено: Edge, headed-запуск через pipe, Pages Router Next, `next start`, Nest 10, Linux-топологія Nest CLI | окремі пункти в тестах фреймворків; зафіксувати результат перед закриттям етапу                                                                                            |

## 15. Зміни в документах і пакеті

**Етап 1:**

- **`package.json`:**
  - прибрати `dependencies` `@kosmo-callflow/*`, `overrides`, `peerDependencies` `better-sqlite3`,
    devDependency `better-sqlite3` і скрипт `deps:tarballs`;
  - `engines.node` ≥ 22.13.0;
  - `files` += `schema`, `exports` += `"./schema/*"`;
  - devDependencies: JSON-Schema-валідатор, `@jridgewell/trace-mapping`;
  - опис: «Terminal viewer for kosmo-trace call traces».
  - `package-lock.json` генерується заново. `test/package.test.ts` перевіряє: нуль runtime-залежностей,
    немає overrides/peers, `engines` ≥ 22.13.0, `files` містить `schema`.
- **`README.md`:** формат, словник kind'ів і `attrs` для продюсерів, стартовий екран, екрани й клавіші,
  приклад NDJSON-продюсера.
- **`SECURITY.md`:** kosmo-tui читає трейси лише на читання і пише тільки `recent.json` (`-r`
  вимикає); OSC 8 — лише при `KOSMO_TUI_LINKS=1`.
- **`CONTRIBUTING.md`:** правило 4 замінюється на «Формати `kosmo-trace/v1` і `kosmo-text/v1` —
  контракти цього репозиторію; зміни — через версію формату, JSON Schema і golden-файли».
- **`CHANGELOG.md`** (`Unreleased`): breaking — видалено live/replay/review/eval/sql і формати
  callflow; додано `kosmo-trace/v1`, стартовий екран, Areas, фрагменти коду, kind'и фреймворків.
- **`.github/workflows/ci.yml`:** основний job 13.6.
- **Підказки `--print`** у `terminal-input.ts` і `cli.ts` → `text|json|tab`.

**Етап 2:**

- **README:**
  - розділ про дебагер з попередженням, що attach може зупиняти процес і виконувати в ньому код;
  - «як запустити з дебагом» для Node, tsx, ts-node, Express, NestJS (з компільованого виходу, чому не
    tsx і не нативний strip), Next.js 15.5/16 (команди й пастки 11.4), React Router/Vite;
  - порада не передавати `--inspect` через `NODE_OPTIONS` supervisor'у.
- **SECURITY.md:**
  - ефект `debug` — явна дія користувача, лише loopback, з підтвердженням;
  - що інжектується: helper, Edge-helper і binding, умови, ~27 внутрішніх модулів `node:inspector`;
  - що прибирається при detach;
  - `discardConsoleEntries`;
  - Node друкує ws URL у термінал застосунку;
  - SIGUSR1 і відкритий порт;
  - маскування live-значень і його неповнота;
  - побічний ефект проб discovery.
- Опис пакета: «Terminal viewer and live debugger for kosmo-trace call traces». Запис у CHANGELOG. Job
  фреймворків у CI.

**Етап 3:** README і SECURITY.md:

- запуск браузера з тимчасовим профілем і pipe;
- чому не повсякденний профіль;
- `:attach-browser` і його ризики;
- DevTools бачить повідомлення kosmo-tui;
- код сторінки бачить helper;
- `:reload-armed`.

## 16. Етапи і порядок

Кожен крок лишає `npm run build && npm test` зеленим.

**Етап 1 — ядро v1:**

1. `src/sanitize.ts` і перехід 11 модулів з `@kosmo-callflow/trace-artifacts` на нього. Поки callflow
   ще встановлено, тимчасовий тест паритету порівнює результат.
2. Нове ядро поруч зі старим кодом, ще не підключене: `src/format/*` (з `kinds.ts` і `attrs`),
   `schema/`, `test/trace-builder.ts` і writers, фікстури (разом із фреймворковими), `src/readers/*`,
   `src/code/snippet.ts`, `kosmo-text/v1` як чиста функція. Кожен модуль має власні unit-тести.
3. Видалення функцій поза обсягом, від яких не залежить жоден шлях, що лишається: review*, eval*,
   sql, replay*, compare, values, depth, requests, source-live, context, `viewer`, `duration` і їхні
   тести. Застосунок і далі відкриває джерела callflow, тести зелені.
4. Перемикання: `view-state`, `session`, `detail`, `stack`, `labels`, `bookmarks`, `capabilities`,
   `clipboard`, `panes`, `render`, `print`, `cli`, `open-viewer`, `command-line`, `commands`, `keys`
   переходять на модель і читачі. Разом із цим видаляються `source*`, `detect`, `sqlite-driver`,
   `outcomes`, `serializers`, `snapshot-selectors`, `terminal-session`, а тести, що лишаються,
   переносяться.
5. Прибрати залежності callflow і `better-sqlite3`, `deps:tarballs`, скрипти й фікстури callflow;
   згенерувати `package-lock.json`; оновити `engines`, CI і `test/package.test.ts`.
6. Новий UI: екрани start/traces, `app.ts`, Areas, фрагмент коду в detail, розмір detail, показ
   kind'ів фреймворків і `attrs`, нова карта клавіш і команди, `paint` і кольори.
7. Документи етапу 1 (15).

Етап 1 завершено, коли виконано критерії 1–4 і пройдено всі тести етапу 1 з розділу 13.

**Етап 2 — дебагер Node, вертикальними зрізами.** Кожен зріз має інтеграційний тест проти справжнього
`node --inspect` у базовому наборі `test/apps/node/` (13.5). Цей набір створюється в зрізі 1.

1. **Discovery і Targets.** Спершу з фейковими портами, потім зі справжнім процесом:
   - визначення node через `ucomm`/`txt`/`/proc`;
   - supervisor'и й обгортки, мітки, порядок проб;
   - захист від проксі;
   - `cdp.ts` з маршрутизацією за `sessionId`.
2. **З'єднання і каркас detach:**
   - перевірка pid, зокрема `waiting-for-debugger`;
   - стан `closing`, дедлайн 1.5 с, знищення сокета, `Debugger.disable`, термінал першим;
   - `waitingForDisconnect`, сигнали;
   - `exited` → `target restarted` → reattach (поки без точок).
3. **Tracepoint на простому `.js` без карт:**
   - легкий реєстр скриптів (9.4: `kind`, hash, контексти, ранні відкидання);
   - `capture-core` і helper, самодостатня умова, теги `kosmo-tui://`, маскування;
   - кепи, захист частоти, фільтр повтору, `skipAllPauses`, приписування винятків, `seq`;
   - `code/params.ts`, панель Hits і фільтр `f`;
   - до detach додається видалення helper'а і `discardConsoleEntries`.
4. **Source maps і нормалізація** (9.4) для всіх форм джерел: `sourceURL`/`AsyncFunction`, порожній
   url з картою, HMR і `scriptHash`, виключення фейків React, правило початку тіла (9.5 п.2–4).
   Reattach перерозв'язує точки.
5. **Довіра до карт і перепривʼязування** (9.5 п.0–1), показ кадрів `map-untrusted`.
6. **`B` і сайти:**
   - сайти з кількома реєстраціями;
   - Paused-view, приписування пауз;
   - `match` і `arm` («той самий випадок»);
   - до detach додаються resume нашої паузи і `releaseObjectGroup`.
7. **SIGUSR1 і закриття порту.**
8. **Зведення фреймворкових об'єктів** (9.6) **і Edge-helper** з binding'ом; до detach додається
   прибирання в контекстах Edge.
9. **Тестові застосунки** Express, NestJS і Next.js (13.5); опційно — серверна частина `rr7`.
10. **Документи етапу 2 і ручна перевірка 14.3.**

Етап 2 завершено, коли виконано критерій 5 і тести 13.5 для Node, Express, NestJS і Next.js.

**Етап 3 — дебагер браузера:**

1. **Запуск і завершення браузера:**
   - транспорт pipe у `debug/transport.ts`, тимчасовий профіль, послідовність запуску 10.1;
   - завершення 10.8, прибирання старих профілів;
   - створення `test/apps/browser-basic/`.
2. **Дерево target'ів:** auto-attach на сесії браузера, жоден target не лишається на паузі, popup'и,
   OOPIF, `non-loopback-page`.
3. **Ініціалізація сесії сторінки:** browser-helper через `addScriptToEvaluateOnNewDocument`,
   бажане значення `skipAllPauses` після навігації, `arm` на нові контексти.
4. **Карти через HTTP з loopback** (таблиця 10.5), корінь dev-сервера, `:reload-armed`,
   `armed after first run`.
5. **Одночасні Node- і браузерний target'и** (9.3, 10.7).
6. **`:attach-browser`** з перевірками 10.2 і `:launch-browser`.
7. **`test/apps/vite-react`, `rr7`, клієнт `next`** (13.5); документи етапу 3.

Етап 3 завершено, коли виконано критерії 6 і 7.
