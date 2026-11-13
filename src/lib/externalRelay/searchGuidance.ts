/** Trusted guidance shared by initial answers, tool rounds and continuations. */
export const searchGuidance = `<search_guidance>
Use web search when the answer needs information from the web. If results are off-topic, refine the query with more specific names and details, then search again. Open relevant result pages and read them before drawing a conclusion. One unsuccessful search does not establish that something does not exist. If you find nothing useful, describe the uncertainty relevant to the question. Write relay replies as self-contained chat prose, integrating each source link immediately after the clause it supports in the same sentence. The final explanatory sentence carries its citation with it and completes the message.
</search_guidance>`;
