# Scheduled Claude task: "SEO weekly Ubersuggest feed"

Create in the Claude desktop app (Scheduled tasks), weekly on **Sunday 10:00** (cron `0 10 * * 0`; Ubersuggest
refreshes rank tracking on Saturdays). Runs while the Claude app is open; a missed run fires on next launch.
Prompt:

---

You feed Ubersuggest's weekly rank-tracking data for Zoe Event Rentals into the Zoe Operations app (SEO Growth blade). Do exactly these steps. Do not change anything in Ubersuggest (no adding or removing keywords, competitors, projects or brands) and do not call Ubersuggest tools that spend daily searches (keyword_overview, keyword_suggestions, serp_analysis, domain_* and similar). Only the read tools named below.

Tools: the Ubersuggest connector (tool names contain "ubersuggest", e.g. mcp__ubersuggest__auth_status). If two Ubersuggest connectors exist, use either one.

1. Call auth_status. If it is not authenticated, run this in Bash and stop:
   node C:/Git/zoe-seo-runner/push-ubersuggest.mjs --error "Ubersuggest connector is signed out in Claude"
2. Call list_projects and pick the project whose domain is zoeeventsdmv.com. If none, run the --error command above with the message "no zoeeventsdmv.com project in Ubersuggest" and stop.
3. Call get_project for that project id and read its first entry in "locations" (loc_id and lang).
4. Call project_position_info with project_id, startDate = today minus 30 days, endDate = today (YYYY-MM-DD, local date), locId = that loc_id, language = that lang, device = "desktop".
   If the result has "done": false or the call errors, wait about 5 minutes and try once more. If it still fails, run the --error command with a one-line reason and stop.
5. Write the EXACT JSON object that project_position_info returned to C:/Git/zoe-seo-runner/last-report.json. Copy it verbatim: every keyword entry, every number and null unchanged. Do not summarize, reorder, round or drop fields.
6. Run in Bash: node C:/Git/zoe-seo-runner/push-ubersuggest.mjs C:/Git/zoe-seo-runner/last-report.json
   - If it prints "ok", you are done.
   - If it says the deployed app does not parse ubersuggest_project yet, that is expected until the SEO feed PR is deployed: just report it, do not retry.
   - Any other error: report the exact message.
7. Finish with a 2 line summary: how many keywords were pushed, how many rank in the top 100 (and the best position), and the push result. No dashes or emoji.
