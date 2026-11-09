> [Приватний текст первинного повідомлення оператора вилучено.]

Джерело вимоги: повідомлення оператора від 2026-11-09 про дві відмови relay;
оригінал збережено в приватній специфікації цієї задачі. Вимога після
редагування приватних даних: встановити долю обох команд і визначити
мінімальне виправлення композиції fresh/resumed prompt зі збереженням
поточного наміру, потрібних цитованих фактів, інструкцій і доступу до tools.
Цей документ завершує проєктування; продуктовий ремонт залишається відкритим.

# Обмежений ремонт owner prompt

Рекомендовано залишити межу 32 000 UTF-8 байтів і змінити відбір даних перед
остаточним render. Необов’язковий suffix має поступатися потрібному контексту.
Повний текст явної цитати потрібно передавати один раз, зберігаючи її зв’язки.
Параметри tools залишаються в чинному адаптері `describe/call`. Якщо обов’язкова
частина сама перевищує межу, композиція завершується визначеною відмовою до
відправлення цього prompt. Автоматичне обрізання потрібних фактів виключається.

## Перевірений стан і межі доказів

| Об’єкт | Спостереження 2026-11-09 |
| --- | --- |
| Serving | `13372c343f25556e9322bc9794f951b48f204cd1`; останнє успішне deployment завершене 2026-11-06 17:33:32.094 UTC |
| База поточної lane та forge main | `0f5995e7e591d0864df4ff601b37d552e615e8f9` |
| Checkout проєктування | `e1e6f17df08afad5f57b08872998f0edf197649d`; додано завершений incident trace |
| База старого ремонту | `6e8b65d9b316ff2da95b8c94f4a3ea01a8f1cfb8` |
| Проміжний ремонт | `6c5b62adec5875932d9fa62fb351a1e2862400b2`; фінал producer 2026-11-05 14:19:10.901 UTC |
| Pending repair / PR #3688 | OPEN, head `6c45a5d52441a7b7cece6f3b9fc5d3ea1b33ad9c`; base branch main; head не входить у serving |
| Продуктовий pipeline | `e2f1acb6`, `needs_decision`, owner/epoch `e2f1acb6/1`, terminal `review:3` FAIL, один P1, `maxRounds: 2` |

Перечитано пізніший первинний review від 2026-11-05 15:45:21.645 UTC і
механічний висновок від 2026-11-06 17:47:59.289 UTC. Попередній producer PASS
не скасовує пізнішого P1. Реєстрація terminal FAIL завершилася
2026-11-05 15:45:31.427 UTC. Published commit і `lastPassedCommit` у старому
pipeline вказують на той самий head; це збережені поля обліку, приймання
продукту з них не випливає.

Дев’ять прочитаних installed source files байт у байт відповідають serving
git blobs. `ownerRun.ts`, `promptBudget.ts` і `runner.ts` однакові на serving,
базі поточної lane та checkout проєктування. Серед відкритих PR, повернутих
запитом з лімітом 100, перетин `src/lib/externalRelay/` має лише #3688.
Прочитано фактичні зміни всіх його п’яти файлів. Його checkout не змінювався.

Обидва поточні запити, від 10:32:08 і 10:34:58 UTC, зупинилися під час
композиції на serving до `runOwnerAgent`: native launch і delivery operation
відсутні. Accepted completion є відповіддю про помилку. Команди через ці
запити не виконувалися; стан сторонніх релізів не досліджувався.
Повна кореляція наведена в [incident trace](relay-current-incident-trace.md).

| Збережене поле входу, UTF-8 після `json()` | Спроба A | Спроба B |
| --- | ---: | ---: |
| Conversation, 40 messages | 47 353 | 45 186 |
| Початкові metadata 80 tools | 13 895 | 13 895 |
| Owner instructions | 15 019 | 15 019 |
| Service instructions | 3 027 | 3 027 |
| Short-term memory | 2 546 | 2 546 |
| Format | 1 486 | 1 486 |
| Documents | 2 | 2 |

Trigger містить 37 сирих UTF-8 байтів, parent — 2 270. Для 78 із 80 tools
була потрібна hydration; її історичних відповідей і фінального prompt немає.
Stack не розрізняє композицію continuation на `runner.ts:898` і fresh на
`:903`. Таблиця описує отримані поля; вона не визначає внесок полів у
переповнення після скорочень. Довжина parent сама по собі причину не доводить.
Цю історичну прогалину прийнято як межу доказів. Нові hydration, upstream
читання або реконструкція відсутніх байтів для дизайну не потрібні.

## Що вже є та що лишилося

Serving вимірює повний відрендерений prompt у `promptBudget.ts:24`, видаляє
стару історію, пам’ять і необов’язкові documents. Він захищає весь direct
parent у conversation, але дублює його уривок у `owner_reply_context`.
Bridge report не має окремого бюджету. Останні скорочення зачіпають
`owner_instructions` та `instructions`, після чого можливий throw на `:77`.
Композиційна відмова відбувається раніше за запуск, хоча локальну run/chain
reservation уже створено. «До dispatch» не означає відсутність усіх записів.

Pending head додає уривки direct parent і bridge report із початком, кінцем
та маркером; скорочує escaped tool summaries за повним render; узгоджує
local metadata зі збереженими рядками; обмежує suffix на прямому resumed
dispatch; пояснює відмову за розміром. Ці зміни залишаються неприйнятими.
Head-tail excerpt не гарантує збереження факту посередині.

У `ownerRun.ts:99` serving, відповідно `:107` pending, suffix вилучається
лише після throw з усієї процедури скорочення. Pending може успішно повернути
вкорочений report без потрібного факту, тому спроба без suffix не настає.

Одна дозволена синтетична проба повторила незмінений збережений
`review-priority.test.ts` на scratch export pending head: **1 pass, 3 fail,
exit 1**, чотири випадки в одному файлі. Провайдер, HTTP і sends у harness
відсутні. Факт загубився у fresh direct quote та fresh/resumed bridge report.
Для report без suffix розміри становлять 31 146 / 30 163 байти; із suffix
head повертає 13 289 / 12 306 байтів без потрібного факту. Первинне порівняння
на pinned base мало 4/4 PASS; base цього разу не запускався. Це підтверджує
збережений P1, без атрибуції поточного інциденту цьому P1.

Наявні 39 тестів і попередній typecheck цього head пройшли у первинному review.
Вони не перевіряли цей пріоритет. Великий потрібний document спричиняв відмову
на обох ревізіях; наявного універсального транспорту великих owner inputs
ця робота не встановила.

## Правило відбору даних

Реалізація використовує чинні `boundedRelayPrompt` і renderers. Вона спочатку
визначає обов’язкові дані, прибирає дублікати їхнього представлення і вимірює
мінімально повну композицію. Класифікація визначається перевіреними зв’язками
та producer поля. Модель не вгадує, яку частину цитати можна втратити.

| Дані / producer | Політика |
| --- | --- |
| `ownerTierFor`: trigger, `owner.text`, `requestText`, IDs і reply binding | Повністю обов’язкові; зберегти різницю між text і request_text, null та порожнім значенням |
| Trusted framing, closing rules, search guidance, hard cap, підтриманий format | Обов’язкові; формат відповіді й правила ефектів зберегти |
| `input.instructions`, `owner_instructions` | Зберегти повністю: чинний контракт не позначає безпечні для видалення підполя. Їхній статус data і межі впливу зберігаються |
| Явний parent, потрібний `earlier_request`, підтверджений bridge report | Повний зміст обов’язковий для відповіді на нього; маршрут, ID та reply links зберегти |
| Local outbound recovery | Підтверджений повний local row замінює service copy з тим самим ID. Explicit-parent send group і дані для неоднозначного вибору зберегти; `ambiguous` залишається ambiguous |
| Documents trigger/parent; потрібний inbound media manifest | Обов’язкові. Зберегти extraction status, refs, зв’язок із повідомленням та правила читання untrusted content |
| Hydrated tools | У prompt обов’язкові видимі name/mode/effect/audience і спосіб list/describe/call. Повні parameters/guidance залишаються в початковому адаптері |
| Старі непов’язані messages, memory, непов’язані documents, display summaries | Необов’язкові; вилучаються детерміновано. Залежності явного reply chain до цього списку не входять |
| Дубльований Cloud prompt, сторонній suffix | Необов’язкові. Їхня присутність ніколи не скорочує обов’язковий зміст |
| Поточний Cloud round frame і tool results, потрібні для наступної дії | Обов’язкові; action/unknown/delivered/confirmation status не можна загубити разом із дубльованою історією |

Текст потрібної цитати передається один раз. Найменша внутрішня зміна:
повний рядок зберігається в `conversation`, а `owner_reply_context` посилається
на його ID і зв’язки; earlier request так само має доступний повний рядок.
Поточний trigger має повний текст у `owner_request`; його conversation row
може посилатися на цю секцію без другої копії тексту. Автор, час та reply link
зберігаються, а єдине джерело поточної інструкції лишається `owner_request`.
Окремий bridge report зберігає report text і routing metadata. Прибирати
дублікат report text можна лише за доведеного зв’язку та точного збігу;
схожість текстів підставою не є. Жоден reference не може вести на вилучений
рядок. Це зміна внутрішнього prompt representation; wire message schema
і збережені request records залишаються сумісними.

Мінімальна композиція включає всі обов’язкові дані й tool index без display
summaries. Якщо вона вміщується, можна додавати необов’язкові дані за сталим
порядком: корисна недавня історія, memory/documents, summaries, сторонній
suffix останнім. Кожен кандидат перевіряється після реального `json()` із
escaping `<`, wrapper tags та separators. Для звичайного малого input
можна зберегти повне представлення, якщо воно відповідає цим інваріантам.

Робота має кінцеву межу: одноразова класифікація та сортування до 200 service
rows плюс до 32 local rows / 65 536 текстових байтів, які вже обмежує
`scopedOutbound` у `telegram/bot/outbound.ts:171`; до 20 documents і 128 tools; жодних
мережевих lookup під час render. Для видалення історії лишається наявний
бінарний пошук; summaries зменшуються кінцевим набором caps. Не вводиться
цикл повторних запусків до випадкового успіху. Прискорення тут не заявлено.

Якщо обов’язкове ядро перевищує 32 000 байтів, renderer повертає чинну
помилку розміру до dispatch. Для довільної цитати з потрібним фактом посередині
head-tail excerpt не задовольняє вимогу збереження змісту. Для таких даних
обрано визначену відмову. Успішний запуск довгого входу очікується тоді, коли
ядро вміщується після усунення дублікатів і необов’язкового навантаження.

## Усі споживачі композиції та сумісність

| Шлях у чинному source | Потрібна зміна в майбутньому ремонті |
| --- | --- |
| `ownerRun.ts:111`, `:209`, `:219`: fresh prompt і initial cursor | Один підготовлений результат `{prompt, seen, digest}`; cursor береться з фактично відправленого результату |
| `ownerRun.ts:157`: continuation | Те саме правило ядра й optional data; digest від фактично вибраних static sections |
| `runner.ts:898–907`: побудова і вимірювання | Fresh chain готує fresh prompt; resumed готує continuation. Не будувати зайву continuation, яка може відмовити раніше за fresh |
| `runner.ts:931–952`, `ownerRun.ts:988–1021`: local launch і continuation send | Передавати підготовлений результат; прибрати повторне складання й raw suffix append. Остаточний assert залишається перед dispatch |
| `runner.ts:983`, Cloud rounds | Не передавати весь `agentPrompt` як сторонній suffix. Передати окремо потрібний round frame/results і media; outputSchema лишається у чинному transport |
| `runner.ts:1011`, `:1085`: confirmed Cloud fallback, unavailable/busy continuation | Повторно вибрати режим fresh/resumed з того самого незміненого request; зберегти наявні умови доведеної відмови та заборону fallback за невідомого ефекту |
| Recovery з `ownerTurn.context` | Та сама композиція з retained owner context; старі records не вимагають нового обов’язкового поля чи міграції |
| `ownerStaticSections`, `ownerInitialCursor`, pendingCursor/seen | Додавати до newly seen лише повністю доставлені тексти. Зберегти witness перевірки native conversation і зміненого answer text |

Поточний аргумент `suffix: string` не доводить необов’язковість даних.
`mediaInput.ts:282` генерує manifest доступу до вкладень і trust rule.
`runner.ts:983` передає суміш дубльованих секцій, round frame і results.
У внутрішніх викликах слід окремо передавати обов’язкові additions та
необов’язковий suffix. Старі exported wrappers можна лишити для сумісності
їхніх викликів; production callers мають явно класифікувати additions.
Потрібний media manifest ніколи не відкидається як сторонній suffix.
Файли майбутньої реалізації: `ownerRun.ts`, `promptBudget.ts`, `runner.ts`
і additive diagnostic metadata у `diagnostic.ts` під `src/lib/externalRelay/`.
Поведінкові тести та `docs/design/relay-owner-prompt-budget.md` потрібно
узгодити з новим внутрішнім представленням. Новий wire protocol, сховище,
міграція або зміна runtime host для цього варіанта не потрібні.

`compactToolIndex` уже вилучає parameters/spec і фільтрує audience
(`toolIndex.ts:9`). Достатньо окремої проєкції summaries для prompt.
Оригінальний hydrated request залишається у `openOwnerServiceTools`,
`describeToolIndex` і `createToolLoop`; їхній список capabilities не звужується.
Спільний `compactToolIndex` використовується також операцією list, тому
глобально міняти його metadata заради prompt не потрібно. Describe повертає
повні tools цілими елементами під 65 536 байтів; action усе ще вимагає
describe перед call. Hydration з її чинним deadline і fallback не змінюється.
Розмір rich schemas не можна оголошувати причиною цього інциденту: owner index
вже їх не містить, історичні lookup replies відсутні.

Область helper обмежена owner tier. `answerPrompt`, `toolRoundPrompt`,
`conversationTurnPrompt` і member ephemeral path зберігають свої контракти;
Cloud owner отримує потрібні round data через явні additions.
Загальний `delivery.ts:812` обирає request-local transport для великого
повідомлення вже відомій conversation. Він не є доведеним механізмом
першого structured launch; переносити його сюди без окремого контракту не слід.

Авторизація лишається у `ownerTierFor`, `ownerRelayAuthorized`, synchronous
dispatch guards, generation/account checks continuation і `beforeSend` service
tools. Уточнення prompt не надає дозволів. Lease, ownership, reply binding,
answer scrubbing, completion custody і заборона повтору невідомого action
зберігаються на чинних enforcing paths.

Для відмови за розміром використати існуючий diagnostic/answer шлях, із
розпізнаванням класу помилки на межі композиції. У diagnostic достатньо
числових total/mandatory bytes, режиму й назв вилучених категорій, без текстів,
account data і каталогів schemas; additive metadata має бути optional для
старих records. Це дозволить пояснити наступну відмову, навіть коли запуску
і chain.promptBytes ще немає. Повідомлення en/uk описує завеликий контекст і
потрібне скорочення чи поділ запиту, без обіцянки, що повтор допоможе.
Після попереднього tool effect воно зберігає відомий/невідомий outcome і не
стверджує, що весь запит нічого не виконав. Прикладати файл як універсальний
обхід цієї межі не обіцяється: потрібні extracted documents теж займають місце.

## Приймальна матриця майбутнього ремонту

Це критерії для чинного продуктового owner після дозволеного переходу.
Нової product review round або заміни gate цей документ не створює.

| Випадок | Очікуване підтвердження / наявний harness |
| --- | --- |
| Fresh і resumed; рівно 32 000 та перший більший escaped input | `ownerEnvelope.test.ts`, `prompt.test.ts`: виміряти фактично передані bytes; optional overload скорочується, ядро зберігається |
| Real producer serialization/escaping | `protocol.test.ts`, service-wire fixtures, `prompt.ts:json`; Unicode, `<`, quotes, backslashes, controls, null, request_text; порівнювати renderer з фактичним аргументом launch/continue/cloudTransport |
| Explicit quote і bridge report проти optional suffix | Перенести поведінкові випадки з retained priority harness у чинний `ownerEnvelope.test.ts`: усі чотири зберігають факт посередині, коли ядро без suffix уміщується |
| Потрібний inbound document/media | `ownerAttachment.test.ts`, `mediaInput.test.ts`, owner route harness: refs і спосіб читання лишаються; unrelated suffix можна відкинути, потрібний manifest — обов’язковий |
| Local recovered parent, earlier request, ambiguous question | `ownerOutboundContext.test.ts`, `ownerBridgeContext.test.ts`: один повний canonical текст, без dangling reference; точні routing поля й неоднозначність збережені |
| Rich schemas і граничні summaries | `toolIndex.test.ts`, `ownerServiceTools.test.ts`: чинні captured on-demand fixtures і реальні builders; index bounded, describe повертає початкову schema, допустимий read працює, undescribed action відмовляється |
| Mandatory data alone понад межу | `ownerEnvelope.test.ts`: поточний текст, потрібна цитата/document або instructions перевищують budget; стабільна відмова, нуль launch/continue/cloud transport для цього prompt, input незмінений |
| Seen/digest і заміна conversation | `prompt.test.ts`, `conversations.test.ts`: discarded/clipped text не стає newly seen, witness перевіряє точний текст і conversation; повторне складання не змінює відправлений cursor |
| Fallback, пізній tool result і повтор після restart | `cloud.test.ts`, `ownerTier.test.ts`, `ownerLifecycle.fixture.ts`: ті самі authority guards, невідомий ефект не повторюється; completion і size failure не дублюються |
| Безпека та user-facing failure | Чинні owner authorization/output tests: заміна owner/generation після await відмовляє до effect; en/uk без internal exception і приватного вмісту; reply до правильного trigger |

Fixtures hydration тут є чинними captured contract fixtures, з перевіреними
tool names, parameters, modes та audiences. Вони не зображують невідому
історичну hydration поточних запитів. Тести, що в pending вимагають обрізання
service instructions або довільного потрібного quote, слід узгодити з правилом
повного ядра й визначеної відмови. Поведінкові перевірки фактів і реального
dispatch важливіші за перевірки формулювань інструкцій.

Майбутні перевірки запускаються за явними файлами у scratch export через
чинний gate wrapper, з приватними HOME/XDG/TMPDIR/LLV_STATE_DIR і закритим
Viewer control URL, під скінченним deadline. Ця стадія виконала лише описану
одну синтетичну пробу; нових route tests, typecheck, build або кампанії не було.

## Передумова продовження та точна наступна дія

На serving і поточному main `terminalBudgetDecisionRefusal` відхиляє terminal
FAIL до запису decision answer: `engine.ts:16523` → `:4961`.
`retry-stage` на `:17580` і `skip-stage` на `:17984` мають той самий guard.
`continue-review` на `:16607` відмовляє новим grants. Звичайний допустимий
`resolve-decision` створює нову спробу того самого stage; текст answer не
перемикає reviewer на fix. Ці гілки повторно прочитано, mutating call не робився.

Підтриманого виклику для ремонту e2 за чинного fixed budget немає. Бракує
окремо дозволеної controller capability: передати збережений terminal finding
початковому producer у межах тієї самої задачі й owner/epoch, із визначеною
процедурою приймання за незмінного max2. Такий механізм мусить зберігати FAIL,
receipts, holds і publication fence, перевіряти очікувані revision/stage/attempt
та не приймати head автоматично. Його поява й дозвіл на застосування є
окремою передумовою; цей дизайн її не надає. Додаткова review round,
successor, accept-head або ручне редагування ledger не відповідають межам задачі.

Наступна вже дозволена дія — передати цей документ контролеру через
`stage_report` із PASS за завершене проєктування. E2 залишається припаркованим;
P1, owner/epoch, max2, UNKNOWN, publication і WORK holds залишаються чинними.
Запуск producer, зміна бюджету, повтор команд і rollout зараз не дозволені.
Приймання коду та реальної доставки початкової вимоги залишаються відкритими.

## Deferred — not currently justified

- Глобальне підвищення structured message limit: немає доказу його потреби
  замість виправлення відбору; межа захищає registry/journal/socket transport.
- Повтор запитів, live hydration, upstream export, доступ до інших проєктів
  і виконання релізних команд: виходять за прийняту межу розслідування.
- File-backed transport, новий context retrieval tool або семантичне стискання
  потрібних цитат: окремий контракт доступу й життєвого циклу; поточний дизайн
  визначено відмовляє, коли повне обов’язкове ядро не вміщується.
- Новий gate, driver, retention store чи автоматичний restart e2: для цього
  дизайну достатньо чинних renderers, harness і явно названої передумови.

Приватні первинні читання, source hashes, незмінений harness, manifest,
фактичний лог і terminal exit проби збережено в `LLV_EVIDENCE_DIR/repair-design`.
Первинні incident artifacts лишилися незміненими. Публічний вихід цієї стадії
обмежений цим документом.
