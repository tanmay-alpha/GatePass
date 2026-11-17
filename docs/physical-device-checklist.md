# Physical device checklist (door scanner)

Automated runs cover Chromium, Firefox and WebKit on desktop plus Pixel 7
emulation, with Chromium's fake camera. None of that is a phone: real cameras,
autofocus, low light, OS permission prompts, screen locks, installed PWAs and
mobile networks behave differently. Run this list on real hardware before an
event that matters, and record the device, OS and browser versions, the GatePass
commit (`/version.json`) and the date with each result. A result that was not
observed on a physical device is not a pass.

## Devices

At least: one Android phone with current Chrome, and one iPhone with current
Safari (iOS 17 or later; also the oldest iOS the venue's staff phones run).

## Setup

Organiser: an active event with two gates (North, South), a policy limited to
North, ten passes (one per policy, one revoked, one already admitted), two
scanner devices (one per gate) and the camera test code on a second screen or on
paper. A laptop with the admin open to watch the scan feed and the audit log.

## Checks

| # | Check | Expected |
|---|---|---|
| 1 | Open the setup link on the phone (tap from chat or mail) | Setup completes; the link disappears from the address bar; "Before you scan" opens with event and gate |
| 2 | Open the same setup link again on the same phone | "Replace this scanner's setup?"; choosing the new setup says the link is used and the phone keeps its setup |
| 3 | Camera permission: deny at the prompt, then "Test camera" | Camera item explains how to allow it; no crash; manual entry still works |
| 4 | Allow the camera again in browser/site settings, return to the app, "Retry camera" | Camera starts without reinstalling or re-enrolling |
| 5 | Camera test code, portrait and landscape | "Passed: the camera read the test code"; nothing appears in the scan feed |
| 6 | Scan passes in portrait, then rotate to landscape and scan again | Verdict overlay fills the screen in both; Admit / Already used / Denied / Not verified readable at arm's length |
| 7 | Camera switching (phones with several rear cameras) | The camera list appears; switching keeps scanning; the choice survives a reload |
| 8 | Low light (dim room) with and without the flashlight button | Codes read within a few seconds with the torch; the torch button is hidden where the browser cannot switch it (record which) |
| 9 | Cracked or glare-covered screen / printed pass | Unreadable codes are found with "Find attendee" (name start, email or reference) and admitted through the normal check |
| 10 | Install the PWA (Android: Install app; iOS: Share → Add to Home Screen), open it from the home screen | Opens at /scan in standalone mode with "Loaded · opens offline" in the checklist. Android: still enrolled. iOS may give home-screen apps storage separate from Safari: if it asks for setup, paste a fresh setup link and record that it did |
| 11 | Airplane mode, then open the installed app cold | App opens; "Server verification unavailable … Do not admit anyone"; no verdict possible |
| 12 | Network loss during scanning (airplane mode mid-session), scan a pass | "Scanning paused — offline"; manual Check disabled; nothing admitted |
| 13 | Network back | Banner clears within seconds; the pass shown during the outage is checked once when presented again |
| 14 | Network loss while a verdict is pending (toggle airplane mode right after a scan) | "Not verified"; Retry verification (same request) gives the server's original verdict, never a second admission |
| 15 | Screen lock for 2+ minutes, unlock | Station resumes; the heartbeat/status is fresh; camera restarts or offers "Retry camera" |
| 16 | Revoke the device in the admin while the phone is locked, then unlock | Phone signs out at once ("This device was revoked …") without anyone being scanned |
| 17 | Move the device to the other gate (rotate + new link) / close the event while the phone is locked, then unlock | The header shows the new state at once; scans follow the server's current rules |
| 18 | Slow backend (≥ 5 s per request: throttle with a proxy or Chrome remote debugging network throttling on the phone) | "Checking… slow connection" after 1.5 s, "Not verified" after 12 s; never Admit without an answer |
| 19 | Stale credential after revocation: revoke, then scan before the phone notices | 401 → signed out; the pass stays unused in the admin |
| 20 | Sound and vibration on Admit vs refusal (silent switch on and off) | Distinct tones and vibration patterns where the OS allows them; the visual verdict never depends on them |
| 21 | Screen reader (TalkBack / VoiceOver): scan one pass of each verdict | The verdict headline and reason are announced |
| 22 | Light and dark system theme | Verdict colours, icons and words readable in both, in sunlight at the door |

## Recording results

For each check: pass / fail / not applicable, device + OS + browser version,
GatePass commit, date, tester, and a note for anything unexpected. Copy failures
into the issue tracker with a screen recording where possible.
