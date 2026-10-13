# Errata: things in this repo's history that are wrong and stay there

History is not rewritten, so wrong words in a commit message stay. This file says which ones.

- **1488836** (the accept of `slice/self-managed-and-guard`, 2026-10-12). The message says "0.1.1" and "reviewed three times by a fresh-context reviewer". Neither was true when written. No version had been bumped (`package.json` said 0.1.0 until the next slice). Only the first of the three reviews was a fresh context; rounds two and three were the same reviewer resumed, so it had seen the earlier version. The three records exist and say what they say, but "fresh" applies to one of them. The author of this note is the author of that message.
