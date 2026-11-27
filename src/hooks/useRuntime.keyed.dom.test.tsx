import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { StrictMode, Suspense, startTransition } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { useAgentCapabilities } from "@/components/useAgentCapabilities";
import type { FileEntry } from "@/lib/types";
import { createRuntimeBus, setRuntimeBusForTests, setRuntimeUiEnabledForTests, type EventSourceLike } from "./runtimeBus";
import { useRuntimeSessionForConversation } from "./useRuntime";

test("a discarded concurrent reader and a StrictMode remount read the current turn and the child's current root", async () => {
  const dom = new Window({url:"https://fixture.test"});
  const globals = { window:dom, document:dom.document, navigator:dom.navigator, Node:dom.Node, HTMLElement:dom.HTMLElement, Event:dom.Event };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const source: EventSourceLike = {onopen:null,onmessage:null,onerror:null,addEventListener(){},close(){}};
  const child = {path:"/child",root:"claude-projects",kind:"subagent",engine:"claude",fmt:"claude",parent:"/root",
    title:"Child",name:"child",project:"test",mtime:0,size:0,activity:"idle",proc:null,pid:null,model:null,
    waitingInput:null,pendingQuestion:null} satisfies FileEntry;
  const sessions=["first","next","host"].map(id=>({conversationId:id,sessionKey:{engine:"claude",sessionId:id},
    artifactPath:id==="host"?"/root":"/"+id,host:"hosted",hostKind:"claude-broker",turn:"idle",provenance:"structured",
    revision:1,attentionIds:[],recentReceipts:[],activeTurnId:null,capabilities:{steer:false,structuredAttention:true}}));
  const bus=createRuntimeBus({fetch:async()=>Response.json({schemaVersion:1,snapshotSeq:10,retentionFloorSeq:0,
    runtime:{hostEpoch:1,health:"ready"},structuredHostsEnabled:true,filesRevision:1,sessions,attentions:[],recentOperations:[],edges:[],flows:[],workflows:[],tasks:[]}),
    createEventSource:()=>source,now:Date.now,setTimeout,clearTimeout,setInterval,clearInterval});
  setRuntimeUiEnabledForTests(true);setRuntimeBusForTests(bus);
  const host=dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root=createRoot(host as unknown as Element);
  const never=new Promise<void>(()=>{});
  let attempts=0, seq=10;
  function View({id,pause}:{id:string;pause:boolean}) {
    const view=useRuntimeSessionForConversation(id,null);
    const {caps}=useAgentCapabilities(child);
    if(pause){attempts++;throw never;}
    return <output data-surface={caps.surface}>{view?.session.turn}</output>;
  }
  const tree=(id:string,pause=false)=><StrictMode><Suspense fallback={<i>loading</i>}><View id={id} pause={pause}/></Suspense></StrictMode>;
  function publish(id:string,kind:string,payload:Record<string,unknown>) {
    const revision=(bus.getState().store.scopeHeads["session:"+id]??0)+1;
    source.onmessage?.({data:JSON.stringify({schemaVersion:1,seq:++seq,eventId:"test-"+seq,scope:{type:"session",id},revision,kind,payload:{conversationId:id,...payload}})});
  }
  try {
    bus.start();
    for(let i=0;i<10;i++)await Promise.resolve();
    source.onopen?.(null);
    flushSync(()=>root.render(tree("first")));
    await Bun.sleep(35);
    expect(host.querySelector("output")?.getAttribute("data-surface")).toBe("structured-subagent");
    startTransition(()=>root.render(tree("next",true)));
    for(let i=0;!attempts&&i<30;i++)await Bun.sleep(5);
    expect(attempts).toBeGreaterThan(0);
    publish("next","turn-started",{turnId:"pending-reader"});
    await Bun.sleep(30);
    expect(host.querySelector("output")?.textContent).toBe("idle");
    publish("first","session-status",{turn:"interrupt_requested"});
    await Bun.sleep(30);
    expect(host.querySelector("output")?.textContent).toBe("interrupt_requested");
    flushSync(()=>root.render(tree("next")));
    expect(host.querySelector("output")?.textContent).toBe("running");
    publish("host","session-status",{host:"dead"});
    await Bun.sleep(35);
    expect(host.querySelector("output")?.getAttribute("data-surface")).toBe("inert");
    publish("host","session-status",{host:"hosted"});
    await Bun.sleep(35);
    expect(host.querySelector("output")?.getAttribute("data-surface")).toBe("structured-subagent");
  } finally {
    flushSync(()=>root.unmount());bus.stop();
    setRuntimeBusForTests(null);setRuntimeUiEnabledForTests(null);
    // React schedules passive cleanup after the unmount commit.
    await Bun.sleep(30);
    for(const key of Object.keys(globals)) {
      const descriptor = saved.get(key);
      if(descriptor) Object.defineProperty(globalThis,key,descriptor);
      else Reflect.deleteProperty(globalThis,key);
    }
    await dom.happyDOM.close();
  }
});
