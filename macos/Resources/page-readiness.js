// Read-only evidence probe, shared by the released and current web pages.
(() => {
  if (document.readyState !== "complete") return "document-loading";
  if (!document.body?.innerText.trim()) return "empty";
  const visible = element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  // Both release 1.11.0 and current pages mark their loading placeholders.
  // Connection indicators can remain on a fully drawn legacy page.
  const shell = document.querySelectorAll('[aria-busy="true"], [data-skeleton], [data-kanban-skeleton], [data-kanban-columns-skeleton], .skeleton-pulse');
  return [...shell].some(visible) ? "loading-shell" : "finished";
})();
