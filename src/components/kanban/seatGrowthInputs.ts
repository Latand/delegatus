/** The transcript and each form row can give space back to the seat. Follow
 * their sizes across portal mounts, accessory insertions and removals. */
export function observeSeatGrowthInputs(section: HTMLElement, measure: () => void): () => void {
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  let watched = new Set<Element>();
  let transcript: Element | null = null;
  let form: Element | null = null;

  function follow(): boolean {
    const conversation = section.querySelector("[data-orchestrator-conversation]");
    form = conversation?.querySelector("form") ?? null;
    transcript = conversation?.querySelector("[data-composer-yields]") ?? null;
    const next = new Set<Element>();
    if (transcript) next.add(transcript);
    if (form) {
      next.add(form);
      for (const child of form.children) next.add(child);
    }
    let changed = false;
    for (const element of watched) if (!next.has(element)) { observer?.unobserve(element); changed = true; }
    for (const element of next) if (!watched.has(element)) { observer?.observe(element); changed = true; }
    watched = next;
    return changed;
  }

  follow();
  const mutations = new MutationObserver(records => {
    if (transcript && records.every(record => transcript!.contains(record.target))) return;
    const topologyChanged = follow();
    // Without size observations the form's own content is the remaining signal.
    const formMutation = !observer && form && records.some(record => form!.contains(record.target));
    if (topologyChanged || formMutation) measure();
  });
  mutations.observe(section, observer ? { subtree: true, childList: true }
    : { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
  return () => { mutations.disconnect(); observer?.disconnect(); };
}
