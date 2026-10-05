"""Work content stops at the door. Defense in depth, not a guarantee.

No work account is ever connected to the harness; that is the real
boundary. This filter catches what he might paste or forward anyway:
addresses and links on his employers' domains, and the markers that
rights-protected corporate documents carry. A hit stops the job before
anything is stored or sent to a model, keeps only a minimal rejection
record, and tells him plainly.

It cannot recognize paraphrased or unlabeled work content. That limit is
stated, not hidden.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Hit:
    kind: str        # "domain" | "marker"
    what: str


def check(text: str, *, work_domains: tuple[str, ...],
          markers: tuple[str, ...]) -> Hit | None:
    low = text.lower()
    for m in markers:
        if m.lower() in low:
            return Hit("marker", m)
    for d in work_domains:
        d = d.lower().lstrip(".@")
        # the domain itself or any subdomain, after @, //, a dot or a
        # word boundary -- never a substring of a longer domain
        if re.search(rf"(?:^|[@/\s.<(\[]){re.escape(d)}(?![a-z0-9-])", low):
            return Hit("domain", d)
    return None
