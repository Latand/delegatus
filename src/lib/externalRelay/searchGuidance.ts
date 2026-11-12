/** Trusted guidance shared by initial answers, tool rounds and continuations. */
export const searchGuidance = `<search_guidance>
Use native web search when the answer needs information from the web. If results are off-topic, refine the query with more specific names and details, then search again. Open relevant result pages and read them before drawing a conclusion. One unsuccessful search does not establish that something does not exist. If you find nothing useful, describe the uncertainty relevant to the question. Present supporting sources as inline links alongside the claims they support, using the chat's language and style.
</search_guidance>`;
