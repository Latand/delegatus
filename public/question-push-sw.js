self.addEventListener("push", (event) => {
  let payload = {
    title: "Agent is waiting for a response",
    body: "Open the log viewer to respond.",
    url: "/",
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* generic fallback above */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: "agent-question",
      data: { url: payload.url },
    }),
  );
});

/* The open tab takes the link itself when it can (#2105): the page opens it
   as an in-app link, one history entry over the screen the operator was on,
   whatever a browser makes of a worker-driven navigation (one may replace
   that screen's entry). A tab that does not answer in time is navigated here,
   as before. The message type is `NOTIFICATION_OPEN_MESSAGE` in
   src/lib/navigation/fragmentNavigation.ts. */
const HAND_OFF_MS = 2500;

function handOff(client, url) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), HAND_OFF_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      client.postMessage({ type: "delegatus:open-url", url }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("navigate" in client && "focus" in client) {
          return client.focus().catch(() => null).then((focused) => handOff(focused || client, url).then((taken) => {
            if (taken) return focused || client;
            return client.navigate(url).then((navigated) => (navigated || client).focus());
          }));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
