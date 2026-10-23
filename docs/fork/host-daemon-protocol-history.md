# Fork Host Daemon Protocol History

| Version | Wire change |
| --- | --- |
| 239 | `terminal.open.cwd` adds the requested working directory to terminal open messages. |
| 240 | `terminal.attention` reports terminal bell and notification signals from the daemon to the server. |
| 245 | `host.move_path` is replaced by `host.move_file`: one call that opens the source without following links, accepts only a regular file, hard-links it to the destination (so a folder, link or existing destination is refused), verifies the linked inode, and removes the source only if it is still that inode. A daemon on protocol 244 is rejected at the handshake, so the server cannot reach the old browse-then-rename path. |
