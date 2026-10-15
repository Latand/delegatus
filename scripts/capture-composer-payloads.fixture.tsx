/** Real pane/composer/tray/outbox; default synthetic runtime, no provider calls.
 * `?runtime=journal` keeps the production send/retry client and reads receipts
 * from the verifier, which serves both routes from the real handlers/journal.
 * `native-paint=1` also uses the production transcript stream and log bus. */
import { resetManagerIdentityForTest } from '@/components/voice/managerIdentity';
import { subscribeLog } from '@/hooks/logBus';
import { createRoot } from 'react-dom/client';
import { createElement, useSyncExternalStore } from 'react';
import { NativeConversationPane } from '@/components/scheme/NativeConversationPane';
import { installSnapshot, type RuntimeReceipt } from '@/components/runtime/runtimeModel';
import { setRuntimeBusForTests } from '@/hooks/runtimeBus';
import { setTmuxComposerRuntimeDependenciesForTests } from '@/components/tmuxComposerRuntime';
import { setLogFeedDependenciesForTests } from '@/components/logFeedDependencies';
import { composerSubmissionPayloads } from '@/lib/composerSubmissionPayloads';
import { readPendingDeliveries } from '@/components/TmuxComposer';
import { readOutbox, enqueueOutbox, updateOutbox } from '@/components/conversation/outbox';
import { viewBus } from '@/hooks/viewPresenceBus';
import { setLocale } from '@/lib/i18n';
import type { FileEntry } from '@/lib/types';
import type { RuntimeSnapshot } from '@/lib/runtime/contracts';

const params = new URLSearchParams(location.search);
const engine = params.get('engine') === 'claude' ? 'claude' : 'codex';
const nativePaint = params.get('native-paint') === '1';
const journal = params.get('runtime') === 'journal';
const CARD = params.get('card') ?? 'conversation_payload_fixture';
const PATH = params.get('path') ?? '/fixture/payload.jsonl';
const listeners = new Set<() => void>();
let receipts: RuntimeReceipt[] = [];
const requests: Record<string, unknown>[] = [];
// `?queue=<thread>` hosts the card on a native-queue Codex thread with a running turn.
const queueThread = params.get('queue');
// `?inject=1` also advertises context injection, so the send menu offers Add to context.
const injectCapable = params.get('inject') === '1';
const session = {
  conversationId: CARD, sessionKey: { engine,sessionId:queueThread ?? 'fixture-thread' },
  hostKind:engine === 'claude' ? 'claude-broker' : 'codex-app-server',host:'hosted',turn:queueThread ? 'running' : 'idle',provenance:'structured',
  accountId:'fixture-account',parentConversationId:null,cwd:null,artifactPath:PATH,
  capabilities:{steer:true,structuredAttention:true,nativeQueue:Boolean(queueThread),inject:injectCapable,imageInput:{supported:true,mimes:['image/png']}},
  activeTurnId:null,nativeQueueRevision:0,attentionIds:[],recentReceipts:[],revision:1,
};
const state = {
  store:installSnapshot({schemaVersion:1,snapshotSeq:1,retentionFloorSeq:0,runtime:{hostEpoch:1,health:'healthy'},filesRevision:0,sessions:[session],attentions:[],recentOperations:[],edges:[],flows:[],workflows:[],tasks:[]} as unknown as RuntimeSnapshot),
  connection:'live',resyncedAt:null,lastEventAt:null,enabled:true,structuredHostsEnabled:true,
};
setRuntimeBusForTests({getState:()=>state,subscribe:()=>()=>{},subscribeFilesRevision:()=>()=>{},start(){},stop(){},refresh:async()=>true} as never);
let refreshes = 0;
let mode = params.get('mode') ?? 'safe';
const nativeFetch = window.fetch.bind(window);
// Synthetic journal revisions only rise, across reloads too, like presentation revisions.
const revisionFloor = () => Number(localStorage.getItem('fixture-max-revision') ?? '0');
const bumpRevision = (revision: number) => localStorage.setItem('fixture-max-revision', String(Math.max(revision, revisionFloor())));
const publishReceipts = (next: RuntimeReceipt[]) => {
  receipts = next;
  if (!journal) bumpRevision(Math.max(0, ...next.map(receipt => receipt.revision)));
  for (const listener of listeners) listener();
};
const pollReceipts = async () => {
  const response = await nativeFetch('/fixture/receipts');
  const next = await response.json() as RuntimeReceipt[];
  if (JSON.stringify(next) !== JSON.stringify(receipts)) publishReceipts(next);
};
if (journal) setInterval(() => { void pollReceipts().catch(() => {}); }, 100);
setTmuxComposerRuntimeDependenciesForTests({
  refreshRuntime: async () => { refreshes++; if (journal) await pollReceipts(); return true; },
  useRuntimeReceiptsForArtifact: () => useSyncExternalStore(listener => {listeners.add(listener);return()=>{listeners.delete(listener);};},()=>receipts,()=>receipts),
  ...(journal ? {} : { sendRuntimeMessage: async (body: Parameters<typeof import('@/hooks/useRuntime').sendRuntimeMessage>[0]) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    if(mode === 'unknown') return {ok:false,error:'Synthetic lost response',status:503};
    const revision = Number(localStorage.getItem('fixture-server-revision') ?? '0') + 1;
    localStorage.setItem('fixture-server-revision', String(revision));
    bumpRevision(revision);
    const receipt = {conversationId:CARD,idempotencyKey:body.idempotencyKey,operationId:'fixture-operation',kind:'send',status:mode === 'delivered'?'delivered':'failed',resend:mode === 'delivered'?'unsafe':'safe',text:body.text,reason:'Synthetic pre-dispatch refusal',at:new Date().toISOString(),revision} as RuntimeReceipt;
    return {ok:mode === 'delivered',status:mode === 'delivered'?200:409,receipt,error:mode === 'delivered'?undefined:receipt.reason ?? undefined};
  } }),
});
if (!nativePaint) setLogFeedDependenciesForTests({useLogTail:()=>({lines:[],linesStart:0,size:0,loading:false,error:null,tickTime:null,paused:false,setPaused(){},clear(){},hasMore:false,loadingOlder:false,loadOlder:async()=>0,prependGen:0})} as never);
// Synthetic mode answers the operation retry contract the way the journal does:
// a leaf that names the attempt it replaces, under a key the server derives.
const retries: string[] = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (journal && (pathname.startsWith('/api/runtime/') || pathname.startsWith('/fixture/') || (nativePaint && pathname.startsWith('/api/log')))) return nativeFetch(input, init);
  const operation = /^\/api\/runtime\/operations\/([^/]+)$/.exec(pathname);
  if (operation && init?.method === 'POST') {
    const parent = decodeURIComponent(operation[1]!);
    retries.push(parent);
    const revision = revisionFloor() + 1;
    bumpRevision(revision);
    const receipt = {conversationId:CARD,idempotencyKey:'retry_'+parent,operationId:parent,retryOfOperationId:parent,kind:'send',status:'queued',at:new Date().toISOString(),revision};
    return new Response(JSON.stringify({operationId:'fixture-leaf-'+retries.length,receipt}),{status:202,headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify(pathname.includes('/targets')?{targets:{}}:{voices:[],accounts:[],models:[],engines:[],options:[]}),{status:200,headers:{'content-type':'application/json'}});
}) as typeof fetch;
setLocale('en');
const file = {path:PATH,root:engine === 'claude' ? 'claude-projects' : 'codex-sessions',name:'payload.jsonl',project:'viewer',title:nativePaint ? 'Native send latency' : 'Attachment recovery',engine,kind:'session',fmt:engine,parent:null,mtime:nativePaint ? Date.now()/1000 : 1,size:1,activity:'idle',proc:'running',pid:null,conversationId:CARD,pendingQuestion:null,waitingInput:null,model:'gpt-6-astra',effort:'high'} as FileEntry;
const host = (document.getElementById('app') ?? document.getElementById('root'))!;
const root = createRoot(host);
let mount = 0;
const render = (other = false) => root.render(createElement(NativeConversationPane,{key:++mount,file:other?{...file,path:'/fixture/other.jsonl',conversationId:'conversation_other'}:file,tasks:[],isRoot:false,active:true,place:host,fullWindowPlace:null}));
render();
Object.assign(window,{payloadFixture:{
  requests, retries, cardId:CARD,
  seedLegacyOutbox:(pending:{key:string;text:string}[])=>{
    for (const p of pending) {
      enqueueOutbox(CARD,{id:p.key,text:p.text,images:0,at:Date.now()});
      updateOutbox(CARD,p.key,{state:"delivering",originalOperationOnly:true,operationId:"report-op-"+p.key.split("-").at(-1)});
    }
  },
  select:(name:string)=>{
    const path='/fixture/selected-'+name+'.jsonl';
    viewBus.reportIdentity({viewSessionId:'fixture-view',deviceId:'fixture-device'});
    viewBus.reportContext({project:'viewer',board:{renderedRevision:null,durableRevision:null,sync:'unavailable'}});
    viewBus.reportCards([{path,conversationId:'conversation_selected_'+name,project:'viewer',label:'Selected '+name}]);
    viewBus.reportSlice({mode:'list',focusedPath:path,selectedPaths:[path],visiblePaths:[path],camera:null});
  },
  refreshes:()=>refreshes,
  saved:async()=>Promise.all((await composerSubmissionPayloads.list(CARD)).map(ref=>composerSubmissionPayloads.restore(ref))),
  holdStorage:()=>{
    const original=crypto.subtle.digest.bind(crypto.subtle);
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    crypto.subtle.digest=(async (...args:Parameters<SubtleCrypto['digest']>)=>{await wait;return original(...args);}) as SubtleCrypto['digest'];
    return Object.assign(window,{releasePayloadStorage:()=>{crypto.subtle.digest=original;release();}}),true;
  },
  state:()=>({outbox:readOutbox(CARD),pending:readPendingDeliveries(CARD)}),
  remount:()=>render(),switchCard:(other:boolean)=>render(other),
  mode:(next:string)=>{mode=next;},
  profile:()=>{file.model="fixture-later-model";file.effort="low";render();},
  receipts:(next:RuntimeReceipt[])=>publishReceipts(next),
  nextRevision:()=>revisionFloor()+1,
}});


/** Epoch milliseconds in this browser; canonicalFrame is a render opportunity,
 * after native bytes and outbox retirement, with no compositor timestamp claim. */
export interface NativePaintReading {
  text: string;
  prerequisites: Array<{ kind: "manager" | "bridge"; start: number; end: number }>;
  click?: number;
  request?: number;
  response?: number;
  key?: string;
  browserChunk?: number;
  optimisticFrame?: number;
  canonicalFrame?: number;
  canonicalRows?: number;
  overflowX?: number;
  visible?: boolean;
}
declare global {
  interface Window {
    nativePaintAudit?: NativePaintReading;
    nativePaintReady?: boolean;
    armNativePaintAudit(text: string, delay: number): void;
  }
}
if (nativePaint) {
  let delay = 0;
  let offset = 0;
  // A second subscriber observes the same real stream through the public bus.
  // Its offset advances too, so it cannot turn reconnects into full-file reads.
  subscribeLog({ path: PATH, getOffset: () => offset, onChunk(chunk) {
    if (!("data" in chunk)) return;
    offset = chunk.offset;
    window.nativePaintReady = true;
    const audit = window.nativePaintAudit;
    if (audit && !audit.browserChunk && chunk.data.includes(audit.text)) {
      audit.browserChunk = performance.timeOrigin + performance.now();
    }
  } });
  const now = () => performance.timeOrigin + performance.now();
  const fixtureFetch = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    const audit = window.nativePaintAudit;
    if (audit && (pathname === "/api/orchestrator/seat" || pathname === "/api/bridge")) {
      const hop = { kind: pathname === "/api/bridge" ? "bridge" as const : "manager" as const, start: now(), end: 0 };
      audit.prerequisites.push(hop);
      await new Promise(resolve => setTimeout(resolve, delay));
      hop.end = now();
      return Response.json(hop.kind === "bridge" ? { prelude: null } : { exists: false, seat: null });
    }
    if (audit && pathname === "/api/runtime/send") {
      audit.request = now();
      audit.key = JSON.parse(String(init?.body)).idempotencyKey;
      const response = await fixtureFetch(input, init);
      audit.response = now();
      return response;
    }
    return fixtureFetch(input, init);
  }) as typeof fetch;
  window.armNativePaintAudit = (text, prerequisiteDelay) => {
    resetManagerIdentityForTest();
    delay = prerequisiteDelay;
    window.nativePaintAudit = { text, prerequisites: [] };
  };
  document.addEventListener("click", event => {
    const audit = window.nativePaintAudit;
    if (!audit || !(event.target instanceof Element) || !event.target.closest('button[type="submit"]')) return;
    audit.click = now();
    let optimisticScheduled = false;
    let canonicalScheduled = false;
    const matchingRows = () => [...document.querySelectorAll('[data-message-row], [data-feed-kind="user"]')]
        // Canonical message rows sit inside a user feed wrapper. Count the
        // inner row once, while retaining the generic user renderer fallback.
        .filter(row => !row.querySelector("[data-message-row]") && row.textContent?.includes(audit.text));
    const canonical = (row: Element | undefined) => row && !row.hasAttribute("data-outbox-entry") && !row.querySelector("[data-outbox-entry]");
    const tick = () => {
      const rows = matchingRows();
      const row = rows[0];
      if (row && !optimisticScheduled) {
        optimisticScheduled = true;
        requestAnimationFrame(() => { audit.optimisticFrame = now(); });
      }
      if (canonical(row) && audit.browserChunk && !canonicalScheduled) {
        canonicalScheduled = true;
        requestAnimationFrame(() => {
          const settledRows = matchingRows();
          const settledRow = settledRows[0];
          if (!canonical(settledRow)) { canonicalScheduled = false; return; }
          const box = settledRow.getBoundingClientRect();
          const clip = settledRow.closest("[data-log-feed-scroller]")?.getBoundingClientRect();
          const visible = box.width > 0 && box.height > 0 && box.top >= Math.max(0, clip?.top ?? 0)
            && box.bottom <= Math.min(innerHeight, clip?.bottom ?? innerHeight);
          // Following the appended row can take another frame. Keep observing
          // until the canonical row is inside the feed's visible viewport.
          if (!visible) { canonicalScheduled = false; return; }
          audit.canonicalFrame = now();
          audit.canonicalRows = settledRows.length;
          audit.overflowX = Math.max(0, document.documentElement.scrollWidth - innerWidth);
          audit.visible = visible;
        });
      }
      if (!audit.canonicalFrame) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { capture: true });
}
