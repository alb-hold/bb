# Thread list pagination

`GET /api/v1/threads` returns all matching thread entries as an array. The default excludes hidden and deleted threads and includes archived threads. Use `archived=false` for active threads, `archived=true` for the archive, and `includeHidden=true` to include hidden threads.

To read one page, pass a positive `limit`. A server supporting cursor pagination returns `X-BB-Pagination: cursor`. When another page exists, it also returns an opaque `X-BB-Next-Cursor`. Send that value as the URL-encoded `cursor` on the next request with the same filters and limit. Omit `offset` from continuation requests. Each page reflects the database at the time of that request.

The SDK and CLI collect the complete result when listing without a limit. SDK callers requesting an explicit limit receive at most that many entries. Existing offset-based requests keep their ordering.

`GET /api/v1/sidebar-bootstrap` returns the personal project, public projects, sections, and their visible active threads. An explicit `limit` pages threads across all projects, up to 500 per request. Project and section metadata accompany each page. Use the same continuation headers as the thread list. Without a limit the bootstrap contains every matching thread.

Pass `fields=summary` to the threads route for the fields used by the CLI table. Its response is an object with a `rows` array and the same pagination headers. The CLI uses this projection for text output and full entries for JSON.

On the first sidebar bootstrap page, callers may request `overview=true` with
`limit`. The response adds active visible thread counts by project and read
state for unread threads and their visible ancestors. Missing counts mean
zero. Continuations omit the overview. Ordinary list and bootstrap requests
keep their original response shapes.
