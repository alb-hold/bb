# Thread list pagination

`GET /api/v1/threads` returns all matching thread entries as an array. The default excludes hidden and deleted threads and includes archived threads. Use `archived=false` for active threads, `archived=true` for the archive, and `includeHidden=true` to include hidden threads.

To read one page, pass a positive `limit`. A server supporting cursor pagination returns `X-BB-Pagination: cursor`. When another page exists, it also returns an opaque `X-BB-Next-Cursor`. Send that value as the URL-encoded `cursor` on the next request with the same filters and limit. Omit `offset` from continuation requests. Each page reflects the database at the time of that request.

The SDK and CLI collect the complete result when listing without a limit. SDK callers requesting an explicit limit receive at most that many entries. Existing offset-based requests keep their ordering.
