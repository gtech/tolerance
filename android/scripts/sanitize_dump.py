"""Sanitize a `uiautomator dump` capture so it can be committed as a test fixture.

Structure (classes, ids, bounds, flags) is kept exactly. Text and content descriptions are
replaced by placeholders, except the app's own UI labels that the extractors depend on, which
are kept or kept in shape (see KEEP and PATTERNS). Equal strings get equal placeholders within
one run, so "the same text in two posts" survives; a fresh random salt per run means
placeholders can't be reversed by hashing guesses.

Captures of messaging screens contain people's private messages: run this on them straight
away and never save or commit the raw capture.

usage: python -X utf8 -I sanitize_dump.py <raw.xml> <fixture.xml>
"""
import hashlib
import re
import secrets
import sys
import xml.etree.ElementTree as ET
from typing import Callable

# UI labels kept verbatim
KEEP = {
    # TikTok
    "Video", "LIVE", "LIVE now", "Tap to watch LIVE", "Photo", "Contains AI-generated media",
    "Creator labeled as AI-generated", "Promotional content", "Paid partnership", "Sponsored",
    "Ad", "Promoted", "Community", "Following", "For You", "Explore", "STEM", "Search",
    "Home", "Friends", "Inbox", "Profile", "Create", "Like", "Share", "Favorites",
    # X
    "Reply", "Repost", "Impressions", "Bookmark", "Verified", "Image", "Post options", "Quote",
    "Post", "New posts", "Explain this post with Grok", "Messages", "Notifications",
    "Search and Explore", "Communities", "Grok", "Back", "More", "Show more",
    # YouTube
    "YouTube", "Subs", "Music", "Live", "Shorts", "You", "Messages inbox", "Captions",
    "Tap to mute or unmute playback audio",
}

SALT = secrets.token_hex(8)
_seen: dict[str, str] = {}


def placeholder(text: str, kind: str = "Text") -> str:
    """Stable within this run, unrelated to the text otherwise; roughly its length."""
    if text not in _seen:
        tag = hashlib.sha256((SALT + text).encode()).hexdigest()[:6]
        word = f"{kind}{tag}"
        filler = " ".join([word] * max(1, min(len(text), 200) // (len(word) + 1)))
        _seen[text] = filler if kind == "Text" else word
    return _seen[text]


# (pattern, replacement) — the first match wins; groups keep the UI's own wording
PATTERNS: list[tuple[re.Pattern[str], Callable[[re.Match[str]], str]]] = [
    (re.compile(r"^(Follow |Unfollow |Go to channel )(.+)$"), lambda m: m.group(1) + placeholder(m.group(2), "Name")),
    (re.compile(r"^(Action menu for )(.+)$"), lambda m: m.group(1) + placeholder(m.group(2))),
    (re.compile(r"^(Sound: ?)(.+)$"), lambda m: m.group(1) + placeholder(m.group(2), "Sound")),
    # "Like video. 1.3M likes", "Read or add comments. 535 comments", "Share video. 696 shares"
    (re.compile(r"^(Like video|Read or add comments|Share video|Add to Favorites)\. [\d.,]+[KMB]? \w+$"), lambda m: m.group(0)),
    (re.compile(r"^@\w+$"), lambda m: "@" + placeholder(m.group(0), "user")),
    # Counts and timestamps: "55K", "1,583", "· 5h"
    (re.compile(r"^[·\s]*[\d.,]+[KMBkmbhdws]?$"), lambda m: m.group(0)),
]


# Parts of a YouTube item description that carry no personal or content detail
YT_KEEP_PART = re.compile(
    "|".join([
        r"^(play video|play Short|Visit site|Link opens in new window|Sponsored",
        r"(\d+ hours?,? ?)?(\d+ minutes?,? ?)?(\d+ seconds?)?",
        r"[\d.,]+\s*(thousand|million|billion|K|M|B)?\s*(views?|watching)",
        r"(Streamed )?\d+ (second|minute|hour|day|week|month|year)s? ago)$",
    ]),
    re.IGNORECASE,
)


def scrub_youtube(value: str) -> str:
    """YouTube's one-line item descriptions: keep the shape, replace title and channel."""
    out: list[str] = []
    for part in value.split(" - "):
        if YT_KEEP_PART.match(part):
            out.append(part)
        elif part.startswith("Go to channel "):
            out.append("Go to channel " + placeholder(part[len("Go to channel "):], "Name"))
        elif part.endswith(", Verified"):
            out.append(placeholder(part[: -len(", Verified")], "Name") + ", Verified")
        else:
            # Ad copy spans lines; keep the line breaks, scrub each line
            out.append("\n".join(placeholder(line) for line in part.split("\n")))
    return " - ".join(out)


def scrub(value: str) -> str:
    if not value or value in KEEP:
        return value
    if " - " in value and (value.endswith(("play video", "play Short")) or value.startswith("Sponsored - ")):
        return scrub_youtube(value)
    for pattern, replace in PATTERNS:
        m = pattern.match(value)
        if m:
            return replace(m)
    # Keep TikTok's caption truncation marker
    suffix = "…more" if value.endswith("…more") else ""
    return placeholder(value[: len(value) - len(suffix)]) + suffix


def main(src: str, dst: str) -> None:
    tree = ET.parse(src)
    for node in tree.iter("node"):
        for attr in ("text", "content-desc"):
            if attr in node.attrib:
                node.attrib[attr] = scrub(node.attrib[attr])
        # Not needed by the extractors and can carry typed text
        _ = node.attrib.pop("hint", None)
    tree.write(dst, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
