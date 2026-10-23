# Fork Host Daemon Protocol History

| Version | Wire change |
| --- | --- |
| 239 | `terminal.open.cwd` adds the requested working directory to terminal open messages. |
| 240 | `terminal.attention` reports terminal bell and notification signals from the daemon to the server. |
| 245 | `host.move_path` is replaced by `host.move_file`: one call that refuses Windows hosts, refuses any path that reaches its target through a symbolic link or alias (the resolved path must equal the given path), opens the source with `O_NOFOLLOW`, accepts only a regular file, refuses an existing destination, and renames it on one filesystem (a cross-filesystem move is refused, never copied). If the renamed object is not the file it opened, it is renamed back when the source slot is still free. A daemon on protocol 244 is rejected at the handshake, so the server cannot reach the old browse-then-rename path. `host.remove_path` gains the same Windows and alias refusals. |
