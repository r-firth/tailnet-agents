# Workstation finish

Direction: the visual reference uses finely detailed beige pixel hardware, near-black
enclosures, warm white labels, and deliberate copper selection edges. Preserve
Tailnet Agents’ working layout and phone navigation; improve the materials and hierarchy.

Palette: ink `#101011`, enclosure `#181818`, raised `#242221`, rule `#353230`,
ivory `#f1efeb`, copper `#ff995f`. Online remains green; orange marks actions,
selection, and real agent activity.

Surfaces are solid colors with crisp border separation. Avoid smooth background
gradients, glossy bevels, and inset lighting on navigation, panels, and controls;
they clash with the retro-futuristic direction. Keep the flowing dither confined
to live activity.

Type: Oxanium 600 for navigation and headings; Chakra Petch for cut-corner interface lettering and readable 15px conversation text.
IBM Plex Mono for actual technical values, timestamps, and terminal text.
Avoid miniature uppercase labels on the everyday navigation.

Signature: crisp pixel-cut action buttons and fine copper brackets for selected
rows. Static stippling became distracting and has been removed. A running agent creates a flowing
pixel field in its row and coordinator header. Chat status is a quiet single line
with a small amber dot, without a card or additional animation. The field
renders on every display callback, using WebGPU when available and the same
ordered-dither formula on Canvas 2D over HTTP. It stops when work ends, pauses in
hidden tabs, and stays still for reduced motion. Pixel hardware is secondary.

Layout: sidebar lists separated by fine rules, without nested section boxes.
Use a 56px desktop navigation bar and aligned 64px conversation/terminal headers.
Messages use a compact 16px vertical rhythm, with quiet author/timestamp metadata;
the composer sits directly on the conversation surface with one crisp frame.
Single-pane phone layout retains large touch targets, keyboard-aware sizing,
and bottom navigation. Search and activity labels describe actions rather than
exposing internal event identifiers. Modal entry and drawer motion are brief,
and disabled under reduced motion.

Critique: the first pass overemphasized icons. The interface's pixel treatment
must be visible in its controls and live states, rather than depending on hardware
illustrations. Repeated static dither masks looked stamped on; use precise geometry
for idle controls and reserve the pixel fields for live activity. Keep texture out
of message text and terminal reading surfaces.
