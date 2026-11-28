# Family copies as iCloud hands them back

Each folder is one run of the first-day check the other way round (`python3 -m harness.copy_check`, DOCS step 3e):
`created.ics` and `moved.ics` are the bodies iCloud returned for one untouched copy of Harness's, and `summary.json`
says what was written. `tests/test_family_copy_round3.py` checks every body still reads as the App's own.

- `modeled/` is made from the repo's model of how iCloud keeps a copy (`icloud_way` in the tests), not from the
  real calendar.
- A run on the real Family calendar goes in a folder of its own (for example `icloud-2026-11-29/`), copied from
  the App's `/data/copy-check` after reading the files through. They hold the throwaway copy's address, its fixed
  title, its times and iCloud's own lines, nothing of his.
