// Goodshuffle email templates, filled for one project. The welcome email to a new web lead is a template the
// team keeps in Goodshuffle (Messages → Templates, "New Webform Submission"), so the wording is edited there,
// never in code. The office drainer (extension + bookmarklet) reads the template list for the project
// (GET /app/messageTemplate/list?transactionID=<id>, which returns every variable already filled in as
// templateTags[].transactionValue), swaps each #variable chip for its value, and sends it as a NEW client
// email with POST /app/conversation/sendMessage {messageID:null, templateID, ...}.
//
// The renderer has to run inside the Goodshuffle page (plain JS, no imports), so it lives here as SOURCE
// TEXT: the bookmarklet interpolates it, extension/pull-injected.js carries a verbatim copy (a parity test
// checks the copy), and the unit tests evaluate the same text. Keep it ES5-ish and free of "#" (a "#" can end
// a javascript: bookmarklet URL early).

/** gsRenderTemplate(html, templateTags): replace every mention chip
 *  (<span class="mention" data-original="FirstName" ...>...</span>, nested spans included) with its
 *  escaped value. A chip with no value becomes empty, except FirstName, which falls back to "there".
 *  gsTemplateText(html): the plain text of an HTML fragment (for the subject and for emptiness checks). */
export const GS_TEMPLATE_JS = `function gsRenderTemplate(html, tags) {
  var vals = {};
  (tags || []).forEach(function (t) { if (t && t.name) vals[String(t.name).replace(/\\s+/g, "").toLowerCase()] = t.transactionValue; });
  var FALLBACK = { firstname: "there" };
  var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var src = String(html || ""), out = "", i = 0, m;
  var re = /<span\\b[^>]*class="[^"]*\\bmention\\b[^"]*"[^>]*>/gi;
  while ((m = re.exec(src))) {
    var open = m[0], start = m.index, j = start + open.length, depth = 1, t;
    var tagRe = /<\\/?span\\b[^>]*>/gi;
    tagRe.lastIndex = j;
    while (depth > 0 && (t = tagRe.exec(src))) { depth += t[0].charAt(1) === "/" ? -1 : 1; j = tagRe.lastIndex; }
    var km = /data-original="([^"]*)"/i.exec(open) || /data-value="([^"]*)"/i.exec(open);
    var key = km ? km[1].replace(/\\s+/g, "").toLowerCase() : "";
    var v = vals[key];
    if (v == null || v === "") v = FALLBACK[key] || "";
    out += src.slice(i, start) + esc(v);
    i = j;
    re.lastIndex = j;
  }
  return out + src.slice(i);
}
function gsTemplateText(html) {
  return String(html || "").replace(/<br\\s*\\/?>/gi, " ").replace(/<\\/(div|p|li)>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/\\s+/g, " ").trim();
}`;

export interface GsTemplateTag {
  name: string;
  transactionValue: string | null;
}

type Renderers = {
  gsRenderTemplate: (html: string, tags: GsTemplateTag[]) => string;
  gsTemplateText: (html: string) => string;
};

/** The renderer as callable functions (server side + tests), built from the exact text the drainers run. */
export function gsTemplateRenderers(): Renderers {
  return new Function(`${GS_TEMPLATE_JS}\nreturn { gsRenderTemplate: gsRenderTemplate, gsTemplateText: gsTemplateText };`)() as Renderers;
}
