"""UI rendering toolkit for synthetic eval video generation.

Provides reusable primitives for building realistic-looking app screens
without any external assets.  Everything is drawn with OpenCV + numpy.

Layers of abstraction:

    Primitives     _solid, _text, _rect, _circle, _divider, _noise
    Widgets        button, chip, avatar, list_item, card, text_block,
                   search_bar, input_field, icon_placeholder
    Layouts        app_chrome, sidebar_layout, feed_card,
                   settings_screen, dashboard_screen, chat_screen, form_screen
    Transitions    fade, slide_vertical, crossfade
    Scroll         tall_content_strip, scroll_crop
    Video I/O      create_writer, write_n, write_transition, write_scroll
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_FPS = 30
DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 360

HEADER_HEIGHT = 56
FOOTER_HEIGHT = 48
CONTENT_HEIGHT = DEFAULT_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT

# BGR color palette — realistic UI colors, not toy primaries
WHITE = (255, 255, 255)
OFF_WHITE = (245, 245, 245)
BLACK = (0, 0, 0)
NEAR_BLACK = (30, 30, 30)
GRAY_50 = (250, 250, 250)
GRAY_100 = (245, 245, 245)
GRAY_200 = (224, 224, 224)
GRAY_300 = (189, 189, 189)
GRAY_400 = (158, 158, 158)
GRAY_500 = (117, 117, 117)
GRAY_600 = (97, 97, 97)
GRAY_700 = (66, 66, 66)
GRAY_800 = (38, 38, 38)
GRAY_900 = (18, 18, 18)

# Material-ish accent colors (BGR)
BLUE_500 = (219, 152, 33)     # #2196F3
BLUE_700 = (181, 112, 25)     # #1976D2
RED_500 = (68, 68, 244)       # #F44336
GREEN_500 = (76, 175, 80)     # #4CAF50 (actually this is correct in BGR too)
GREEN_500_BGR = (80, 175, 76)
ORANGE_500 = (0, 152, 255)    # #FF9800
PURPLE_500 = (171, 71, 156)   # #9C27B0

# Dark theme
DARK_BG = (18, 18, 18)        # #121212
DARK_SURFACE = (30, 30, 30)   # #1E1E1E
DARK_SURFACE_2 = (40, 40, 40) # #282828
DARK_SURFACE_3 = (50, 50, 50) # #323232
DARK_TEXT = (230, 230, 230)
DARK_TEXT_SECONDARY = (160, 160, 160)
DARK_DIVIDER = (48, 48, 48)
DARK_ACCENT = (187, 134, 66)  # #4286BB


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def solid(width: int, height: int, color: tuple[int, ...]) -> np.ndarray:
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = color
    return frame


def text(
    frame: np.ndarray,
    label: str,
    x: int,
    y: int,
    *,
    color: tuple[int, ...] = BLACK,
    scale: float = 0.5,
    thickness: int = 1,
) -> np.ndarray:
    cv2.putText(frame, label, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)
    return frame


def text_centered(
    frame: np.ndarray,
    label: str,
    y: int,
    *,
    color: tuple[int, ...] = BLACK,
    scale: float = 0.5,
    thickness: int = 1,
) -> np.ndarray:
    text_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
    x = (frame.shape[1] - text_size[0]) // 2
    return text(frame, label, x, y, color=color, scale=scale, thickness=thickness)


def rect(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    color: tuple[int, ...],
    *,
    filled: bool = True,
    thickness: int = 1,
    radius: int = 0,
) -> np.ndarray:
    if radius > 0 and filled:
        _rounded_rect(frame, x, y, w, h, radius, color)
    elif filled:
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, -1)
    else:
        cv2.rectangle(frame, (x, y), (x + w, y + h), color, thickness)
    return frame


def _rounded_rect(
    frame: np.ndarray, x: int, y: int, w: int, h: int, r: int, color: tuple[int, ...]
) -> None:
    r = min(r, w // 2, h // 2)
    cv2.rectangle(frame, (x + r, y), (x + w - r, y + h), color, -1)
    cv2.rectangle(frame, (x, y + r), (x + w, y + h - r), color, -1)
    cv2.circle(frame, (x + r, y + r), r, color, -1)
    cv2.circle(frame, (x + w - r, y + r), r, color, -1)
    cv2.circle(frame, (x + r, y + h - r), r, color, -1)
    cv2.circle(frame, (x + w - r, y + h - r), r, color, -1)


def circle(
    frame: np.ndarray,
    cx: int,
    cy: int,
    radius: int,
    color: tuple[int, ...],
    *,
    filled: bool = True,
    thickness: int = 1,
) -> np.ndarray:
    cv2.circle(frame, (cx, cy), radius, color, -1 if filled else thickness)
    return frame


def divider(
    frame: np.ndarray,
    y: int,
    *,
    x_start: int = 0,
    x_end: int | None = None,
    color: tuple[int, ...] = GRAY_200,
    thickness: int = 1,
) -> np.ndarray:
    x_end = x_end or frame.shape[1]
    cv2.line(frame, (x_start, y), (x_end, y), color, thickness)
    return frame


def add_noise(frame: np.ndarray, intensity: float = 3.0, seed: int | None = None) -> np.ndarray:
    """Add Gaussian noise to simulate compression artifacts."""
    rng = np.random.default_rng(seed)
    noise = rng.normal(0, intensity, frame.shape).astype(np.int16)
    noisy = np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return noisy


# ---------------------------------------------------------------------------
# Widgets
# ---------------------------------------------------------------------------

def button(
    frame: np.ndarray,
    label: str,
    x: int,
    y: int,
    w: int = 100,
    h: int = 36,
    *,
    bg: tuple[int, ...] = BLUE_500,
    text_color: tuple[int, ...] = WHITE,
) -> np.ndarray:
    rect(frame, x, y, w, h, bg, radius=4)
    text_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
    tx = x + (w - text_size[0]) // 2
    ty = y + (h + text_size[1]) // 2
    text(frame, label, tx, ty, color=text_color, scale=0.45)
    return frame


def chip(
    frame: np.ndarray,
    label: str,
    x: int,
    y: int,
    *,
    bg: tuple[int, ...] = GRAY_200,
    text_color: tuple[int, ...] = GRAY_700,
) -> np.ndarray:
    text_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.35, 1)
    w = text_size[0] + 16
    h = 24
    rect(frame, x, y, w, h, bg, radius=12)
    text(frame, label, x + 8, y + 16, color=text_color, scale=0.35)
    return frame


def avatar(
    frame: np.ndarray,
    cx: int,
    cy: int,
    radius: int = 18,
    color: tuple[int, ...] = BLUE_500,
    letter: str = "U",
) -> np.ndarray:
    circle(frame, cx, cy, radius, color)
    text_size, _ = cv2.getTextSize(letter, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    text(frame, letter, cx - text_size[0] // 2, cy + text_size[1] // 2, color=WHITE, scale=0.5)
    return frame


def icon_placeholder(
    frame: np.ndarray,
    x: int,
    y: int,
    size: int = 24,
    color: tuple[int, ...] = GRAY_400,
) -> np.ndarray:
    """Draw a small square with an X to represent an icon."""
    rect(frame, x, y, size, size, color, filled=False, thickness=1)
    cv2.line(frame, (x + 4, y + 4), (x + size - 4, y + size - 4), color, 1)
    cv2.line(frame, (x + size - 4, y + 4), (x + 4, y + size - 4), color, 1)
    return frame


def search_bar(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int = 280,
    h: int = 36,
    *,
    placeholder: str = "Search...",
    bg: tuple[int, ...] = GRAY_100,
    text_color: tuple[int, ...] = GRAY_400,
) -> np.ndarray:
    rect(frame, x, y, w, h, bg, radius=18)
    icon_placeholder(frame, x + 10, y + 6, 24, text_color)
    text(frame, placeholder, x + 42, y + 23, color=text_color, scale=0.4)
    return frame


def input_field(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int = 260,
    h: int = 40,
    *,
    label: str = "Label",
    value: str = "",
    label_color: tuple[int, ...] = GRAY_500,
    text_color: tuple[int, ...] = BLACK,
    border_color: tuple[int, ...] = GRAY_300,
) -> np.ndarray:
    text(frame, label, x, y - 4, color=label_color, scale=0.35)
    rect(frame, x, y, w, h, border_color, filled=False, thickness=1)
    if value:
        text(frame, value, x + 8, y + 26, color=text_color, scale=0.4)
    return frame


def list_item(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    *,
    title: str = "Item",
    subtitle: str = "",
    has_avatar: bool = True,
    avatar_color: tuple[int, ...] = BLUE_500,
    avatar_letter: str = "A",
    has_divider: bool = True,
    divider_color: tuple[int, ...] = GRAY_200,
    title_color: tuple[int, ...] = NEAR_BLACK,
    subtitle_color: tuple[int, ...] = GRAY_500,
    item_height: int = 56,
) -> np.ndarray:
    text_x = x + 16
    if has_avatar:
        avatar(frame, x + 36, y + item_height // 2, 18, avatar_color, avatar_letter)
        text_x = x + 64
    text(frame, title, text_x, y + 22, color=title_color, scale=0.42, thickness=1)
    if subtitle:
        text(frame, subtitle, text_x, y + 40, color=subtitle_color, scale=0.35)
    if has_divider:
        divider(frame, y + item_height - 1, x_start=text_x, x_end=x + w, color=divider_color)
    return frame


def card(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    *,
    bg: tuple[int, ...] = WHITE,
    border_color: tuple[int, ...] = GRAY_200,
    shadow: bool = True,
) -> np.ndarray:
    if shadow:
        rect(frame, x + 2, y + 2, w, h, GRAY_300, radius=8)
    rect(frame, x, y, w, h, bg, radius=8)
    rect(frame, x, y, w, h, border_color, filled=False, thickness=1)
    return frame


def text_block(
    frame: np.ndarray,
    x: int,
    y: int,
    lines: list[str],
    *,
    color: tuple[int, ...] = NEAR_BLACK,
    scale: float = 0.4,
    line_height: int = 20,
) -> np.ndarray:
    for i, line in enumerate(lines):
        text(frame, line, x, y + i * line_height, color=color, scale=scale)
    return frame


def progress_bar(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int = 8,
    *,
    progress: float = 0.5,
    bg: tuple[int, ...] = GRAY_200,
    fill: tuple[int, ...] = BLUE_500,
) -> np.ndarray:
    rect(frame, x, y, w, h, bg, radius=4)
    fill_w = max(0, round(w * min(1.0, max(0.0, progress))))
    if fill_w > 0:
        rect(frame, x, y, fill_w, h, fill, radius=4)
    return frame


def toggle_switch(
    frame: np.ndarray,
    x: int,
    y: int,
    *,
    on: bool = False,
    track_w: int = 44,
    track_h: int = 24,
) -> np.ndarray:
    track_color = GREEN_500_BGR if on else GRAY_300
    rect(frame, x, y, track_w, track_h, track_color, radius=track_h // 2)
    knob_x = x + track_w - track_h + 2 if on else x + 2
    circle(frame, knob_x + (track_h - 4) // 2, y + track_h // 2, (track_h - 4) // 2, WHITE)
    return frame


def badge(
    frame: np.ndarray,
    x: int,
    y: int,
    count: int | str = 3,
    *,
    bg: tuple[int, ...] = RED_500,
) -> np.ndarray:
    label = str(count)
    text_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.3, 1)
    w = max(18, text_size[0] + 8)
    h = 18
    rect(frame, x, y, w, h, bg, radius=9)
    text(frame, label, x + (w - text_size[0]) // 2, y + 13, color=WHITE, scale=0.3)
    return frame


def skeleton_block(
    frame: np.ndarray,
    x: int,
    y: int,
    w: int,
    h: int,
    *,
    color: tuple[int, ...] = GRAY_200,
) -> np.ndarray:
    """Shimmer/skeleton loading placeholder."""
    rect(frame, x, y, w, h, color, radius=4)
    return frame


# ---------------------------------------------------------------------------
# Layouts — full-screen app templates
# ---------------------------------------------------------------------------

def app_chrome(
    content: np.ndarray,
    *,
    header_h: int = HEADER_HEIGHT,
    footer_h: int = FOOTER_HEIGHT,
    header_color: tuple[int, ...] = WHITE,
    footer_color: tuple[int, ...] = WHITE,
    header_text: str = "App Title",
    header_text_color: tuple[int, ...] = NEAR_BLACK,
    footer_tabs: list[str] | None = None,
    footer_text_color: tuple[int, ...] = GRAY_400,
    footer_active_idx: int = 0,
    footer_active_color: tuple[int, ...] = BLUE_500,
    header_divider: tuple[int, ...] = GRAY_200,
    footer_divider: tuple[int, ...] = GRAY_200,
    width: int = DEFAULT_WIDTH,
    total_height: int = DEFAULT_HEIGHT,
) -> np.ndarray:
    """Compose a content region within header/footer chrome."""
    frame = np.zeros((total_height, width, 3), dtype=np.uint8)
    # Header
    frame[:header_h, :] = header_color
    text(frame, header_text, 16, 36, color=header_text_color, scale=0.55, thickness=1)
    divider(frame, header_h - 1, color=header_divider)
    # Footer
    frame[total_height - footer_h :, :] = footer_color
    divider(frame, total_height - footer_h, color=footer_divider)
    tabs = footer_tabs or ["Home", "Search", "Profile"]
    tab_w = width // len(tabs)
    for i, tab in enumerate(tabs):
        tc = footer_active_color if i == footer_active_idx else footer_text_color
        text_size, _ = cv2.getTextSize(tab, cv2.FONT_HERSHEY_SIMPLEX, 0.38, 1)
        tx = i * tab_w + (tab_w - text_size[0]) // 2
        text(frame, tab, tx, total_height - footer_h + 30, color=tc, scale=0.38)
    # Content
    content_h = total_height - header_h - footer_h
    content_resized = cv2.resize(content, (width, content_h))
    frame[header_h : total_height - footer_h, :] = content_resized
    return frame


def app_chrome_dark(
    content: np.ndarray,
    *,
    header_text: str = "App Title",
    **kwargs,
) -> np.ndarray:
    """Dark-themed chrome wrapper."""
    defaults = dict(
        header_color=DARK_SURFACE,
        footer_color=DARK_SURFACE,
        header_text_color=DARK_TEXT,
        footer_text_color=DARK_TEXT_SECONDARY,
        footer_active_color=DARK_ACCENT,
        header_divider=DARK_DIVIDER,
        footer_divider=DARK_DIVIDER,
        header_text=header_text,
    )
    defaults.update(kwargs)
    return app_chrome(content, **defaults)


def settings_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    items: list[tuple[str, bool]] | None = None,
    bg: tuple[int, ...] = GRAY_50,
) -> np.ndarray:
    """A settings-style screen with toggle rows."""
    frame = solid(width, height, bg)
    items = items or [
        ("Notifications", True),
        ("Dark Mode", False),
        ("Auto-Save", True),
        ("Analytics", False),
        ("Location", True),
    ]
    y = 12
    for label, enabled in items:
        rect(frame, 12, y, width - 24, 44, WHITE, radius=0)
        text(frame, label, 20, y + 28, color=NEAR_BLACK, scale=0.42)
        toggle_switch(frame, width - 64, y + 10, on=enabled)
        divider(frame, y + 43, x_start=12, x_end=width - 12, color=GRAY_200)
        y += 44
    return frame


def dashboard_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    values: list[tuple[str, str]] | None = None,
    bg: tuple[int, ...] = GRAY_50,
) -> np.ndarray:
    """A dashboard with metric cards."""
    frame = solid(width, height, bg)
    values = values or [
        ("Users", "1,234"),
        ("Revenue", "$56.7K"),
        ("Orders", "892"),
        ("Rating", "4.8"),
    ]
    card_w = (width - 48) // 2
    card_h = 72
    for i, (label, value) in enumerate(values):
        row, col = divmod(i, 2)
        cx = 12 + col * (card_w + 12)
        cy = 12 + row * (card_h + 12)
        card(frame, cx, cy, card_w, card_h, bg=WHITE)
        text(frame, label, cx + 12, cy + 24, color=GRAY_500, scale=0.35)
        text(frame, value, cx + 12, cy + 52, color=NEAR_BLACK, scale=0.6, thickness=2)
    return frame


def chat_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    messages: list[tuple[str, str, bool]] | None = None,
    bg: tuple[int, ...] = GRAY_50,
) -> np.ndarray:
    """A chat-style screen with message bubbles.  Each tuple is (sender, text, is_self)."""
    frame = solid(width, height, bg)
    messages = messages or [
        ("Alice", "Hey, how's the project going?", False),
        ("You", "Making good progress!", True),
        ("Alice", "Great to hear. Can you share the latest?", False),
    ]
    y = 16
    for sender, msg, is_self in messages:
        bubble_w = min(width - 80, len(msg) * 8 + 24)
        bubble_h = 36
        if is_self:
            bx = width - bubble_w - 16
            rect(frame, bx, y, bubble_w, bubble_h, BLUE_500, radius=12)
            text(frame, msg, bx + 12, y + 23, color=WHITE, scale=0.38)
        else:
            bx = 48
            avatar(frame, 24, y + bubble_h // 2, 14, GRAY_400, sender[0])
            rect(frame, bx, y, bubble_w, bubble_h, WHITE, radius=12)
            text(frame, msg, bx + 12, y + 23, color=NEAR_BLACK, scale=0.38)
        y += bubble_h + 12
    return frame


def form_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    fields: list[tuple[str, str]] | None = None,
    bg: tuple[int, ...] = WHITE,
) -> np.ndarray:
    """A form with labeled input fields."""
    frame = solid(width, height, bg)
    fields = fields or [
        ("Full Name", "Jane Doe"),
        ("Email", "jane@example.com"),
        ("Phone", "+1 555-0123"),
    ]
    y = 24
    field_w = width - 48
    for label, value in fields:
        input_field(frame, 24, y, field_w, 36, label=label, value=value)
        y += 64
    button(frame, "Submit", 24, y, 120, 40)
    return frame


def list_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    items: list[tuple[str, str, str]] | None = None,
    bg: tuple[int, ...] = WHITE,
) -> np.ndarray:
    """A list view with avatar, title, subtitle rows."""
    frame = solid(width, height, bg)
    items = items or [
        ("A", "Alice Johnson", "Online - Last seen just now"),
        ("B", "Bob Smith", "Away - In a meeting"),
        ("C", "Carol White", "Offline - 2 hours ago"),
        ("D", "Dave Brown", "Online - Typing..."),
    ]
    y = 0
    item_h = 56
    for letter, title, subtitle in items:
        if y + item_h > height:
            break
        list_item(
            frame, 0, y, width,
            title=title, subtitle=subtitle,
            has_avatar=True, avatar_letter=letter,
            item_height=item_h,
        )
        y += item_h
    return frame


def feed_card_content(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    username: str = "user",
    caption: str = "Check this out!",
    likes: str = "1.2K likes",
    image_color: tuple[int, ...] = GRAY_300,
    bg: tuple[int, ...] = WHITE,
    avatar_color: tuple[int, ...] = BLUE_500,
) -> np.ndarray:
    """A social media feed card with avatar, image placeholder, and engagement."""
    frame = solid(width, height, bg)
    # User row
    avatar(frame, 28, 24, 16, avatar_color, username[0].upper())
    text(frame, username, 52, 30, color=NEAR_BLACK, scale=0.42, thickness=1)
    # Image placeholder (fills most of the card)
    img_top = 48
    img_h = height - 100
    rect(frame, 0, img_top, width, img_h, image_color)
    # Engagement row
    eng_y = img_top + img_h + 8
    icon_placeholder(frame, 12, eng_y, 22, NEAR_BLACK)
    icon_placeholder(frame, 48, eng_y, 22, NEAR_BLACK)
    icon_placeholder(frame, 84, eng_y, 22, NEAR_BLACK)
    text(frame, likes, 12, eng_y + 36, color=NEAR_BLACK, scale=0.38, thickness=1)
    text(frame, caption, 12, eng_y + 54, color=GRAY_600, scale=0.35)
    return frame


def reel_frame(
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    *,
    bg_color: tuple[int, ...] = GRAY_500,
    username: str = "creator",
    caption: str = "Check this out! #trending",
    likes: str = "42.1K",
    comments: str = "1.2K",
    shares: str = "892",
    sound: str = "Original Sound - creator",
    avatar_color: tuple[int, ...] = BLUE_500,
    show_follow: bool = True,
) -> np.ndarray:
    """Full-screen TikTok/Reels-style reel frame.

    The entire frame is content (no header/footer chrome). A semi-transparent
    overlay at the bottom contains username, caption, and sound info. A vertical
    action strip on the right side contains like/comment/share icons with counts.
    These overlay elements are positionally stable across reels — only the
    background content changes.
    """
    frame = solid(width, height, bg_color)

    # Add a subtle diagonal stripe pattern to distinguish content visually
    stripe_color = tuple(max(0, c - 20) for c in bg_color)
    for offset in range(0, width + height, 32):
        x1, y1 = offset, 0
        x2, y2 = 0, offset
        cv2.line(frame, (x1, y1), (x2, y2), stripe_color, 1, cv2.LINE_AA)

    # Bottom gradient overlay (dark fade for text legibility)
    grad_h = height // 2
    for row in range(grad_h):
        alpha = (row / grad_h) ** 1.5 * 0.75  # non-linear, max 75% opacity
        y_pos = height - grad_h + row
        overlay_color = tuple(round(c * (1 - alpha)) for c in bg_color)
        frame[y_pos, :] = overlay_color

    # ── Right-side action strip ───────────────────────────────────────────────
    icon_x = width - 44
    icon_start_y = height // 3

    def action_icon(label: str, count: str, y: int) -> None:
        circle(frame, icon_x + 18, y + 18, 20, (60, 60, 60))
        lbl_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        lx = icon_x + 18 - lbl_size[0] // 2
        text(frame, label, lx, y + 24, scale=0.5, color=WHITE)
        text_size, _ = cv2.getTextSize(count, cv2.FONT_HERSHEY_SIMPLEX, 0.3, 1)
        cx = icon_x + 18 - text_size[0] // 2
        text(frame, count, cx, y + 52, color=WHITE, scale=0.3)

    action_icon("♥", likes, icon_start_y)
    action_icon("✦", comments, icon_start_y + 70)
    action_icon("↑", shares, icon_start_y + 140)

    # Follow button on avatar
    av_y = icon_start_y - 80
    avatar(frame, icon_x + 18, av_y, 22, avatar_color, username[0].upper())
    if show_follow:
        # Small + badge below avatar
        circle(frame, icon_x + 18, av_y + 28, 9, (0, 152, 255))  # orange
        plus_size, _ = cv2.getTextSize("+", cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
        text(frame, "+", icon_x + 18 - plus_size[0] // 2, av_y + 33, scale=0.4, color=WHITE)

    # Spinning sound disc (bottom-right corner)
    sound_x = width - 38
    sound_y = height - 52
    circle(frame, sound_x, sound_y, 20, GRAY_800)
    circle(frame, sound_x, sound_y, 8, GRAY_600)

    # ── Bottom info strip ─────────────────────────────────────────────────────
    info_x = 16
    info_bottom = height - 16

    # Sound name
    text(frame, f"♫ {sound[:32]}", info_x, info_bottom - 2, color=WHITE, scale=0.32)
    # Caption (truncate at ~45 chars to fit width)
    caption_short = caption[:45] + ("..." if len(caption) > 45 else "")
    text(frame, caption_short, info_x, info_bottom - 24, color=WHITE, scale=0.38)
    # Username
    text(frame, f"@{username}", info_x, info_bottom - 52, color=WHITE, scale=0.45, thickness=2)

    return frame


def loading_skeleton_screen(
    width: int = DEFAULT_WIDTH,
    height: int = CONTENT_HEIGHT,
    *,
    bg: tuple[int, ...] = WHITE,
) -> np.ndarray:
    """A skeleton loading screen with placeholder blocks."""
    frame = solid(width, height, bg)
    # Header skeleton
    skeleton_block(frame, 16, 16, 200, 20)
    skeleton_block(frame, 16, 44, 140, 14)
    # Content skeletons
    y = 76
    for _ in range(3):
        skeleton_block(frame, 16, y, width - 32, 12)
        y += 20
    # Card skeletons
    y += 12
    skeleton_block(frame, 16, y, (width - 44) // 2, 80)
    skeleton_block(frame, (width + 12) // 2, y, (width - 44) // 2, 80)
    return frame


# ---------------------------------------------------------------------------
# Tall content for scrolling
# ---------------------------------------------------------------------------

def tall_content_strip(
    width: int,
    num_items: int = 12,
    item_height: int = 72,
    *,
    bg: tuple[int, ...] = WHITE,
) -> np.ndarray:
    """Create a tall scrollable content image with realistic list items."""
    total_h = num_items * item_height + 24  # padding
    frame = solid(width, total_h, bg)
    names = [
        ("A", "Alice Johnson", "Just now"),
        ("B", "Bob Smith", "5 min ago"),
        ("C", "Carol White", "12 min ago"),
        ("D", "Dave Brown", "1 hour ago"),
        ("E", "Eve Davis", "2 hours ago"),
        ("F", "Frank Miller", "Yesterday"),
        ("G", "Grace Lee", "Yesterday"),
        ("H", "Henry Wilson", "2 days ago"),
        ("I", "Iris Chen", "3 days ago"),
        ("J", "Jack Taylor", "1 week ago"),
        ("K", "Kim Anderson", "2 weeks ago"),
        ("L", "Leo Martinez", "1 month ago"),
    ]
    colors = [BLUE_500, GREEN_500_BGR, ORANGE_500, PURPLE_500, RED_500, GRAY_500]
    y = 12
    for i in range(num_items):
        letter, name, time_str = names[i % len(names)]
        color = colors[i % len(colors)]
        list_item(
            frame, 0, y, width,
            title=name,
            subtitle=f"Message preview... {time_str}",
            has_avatar=True,
            avatar_color=color,
            avatar_letter=letter,
            item_height=item_height,
        )
        y += item_height
    return frame


def tall_feed_strip(
    width: int,
    num_cards: int = 6,
    card_height: int = 220,
    *,
    bg: tuple[int, ...] = GRAY_50,
) -> np.ndarray:
    """Create a tall scrollable feed with social-media-style cards."""
    total_h = num_cards * (card_height + 8) + 16
    frame = solid(width, total_h, bg)
    users = ["alice", "bob_photo", "carol_art", "dave_travel", "eve_food", "frank_tech"]
    captions = [
        "Beautiful sunset today!",
        "New recipe I tried",
        "Weekend hiking trip",
        "Just launched my app!",
        "Coffee and code",
        "City lights at night",
    ]
    image_colors = [
        (180, 120, 60), (60, 140, 200), (100, 180, 80),
        (200, 100, 150), (80, 80, 180), (150, 160, 60),
    ]
    avatar_colors = [BLUE_500, RED_500, GREEN_500_BGR, ORANGE_500, PURPLE_500, GRAY_600]
    y = 8
    for i in range(num_cards):
        idx = i % len(users)
        card_content = feed_card_content(
            width - 16, card_height,
            username=users[idx],
            caption=captions[idx],
            likes=f"{(i + 1) * 234} likes",
            image_color=image_colors[idx],
            avatar_color=avatar_colors[idx],
        )
        frame[y : y + card_height, 8 : width - 8] = card_content
        y += card_height + 8
    return frame


def scroll_crop(tall_image: np.ndarray, viewport_h: int, y_offset: int) -> np.ndarray:
    """Crop a viewport-sized slice from a tall image at y_offset."""
    max_offset = max(0, tall_image.shape[0] - viewport_h)
    y = min(max(0, y_offset), max_offset)
    return tall_image[y : y + viewport_h, :].copy()


# ---------------------------------------------------------------------------
# Transition effects
# ---------------------------------------------------------------------------

def fade(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    alpha: float,
) -> np.ndarray:
    """Crossfade between two frames. alpha=0 -> frame_a, alpha=1 -> frame_b."""
    alpha = max(0.0, min(1.0, alpha))
    return cv2.addWeighted(frame_a, 1.0 - alpha, frame_b, alpha, 0)


def slide_vertical(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    progress: float,
    *,
    direction: int = 1,
) -> np.ndarray:
    """Slide transition.  direction=1 slides up (new from bottom), -1 slides down."""
    h, w = frame_a.shape[:2]
    progress = max(0.0, min(1.0, progress))
    offset = round(h * progress)
    result = frame_a.copy()
    if direction > 0:
        # New content slides up from bottom
        if offset > 0:
            result[h - offset :, :] = frame_b[:offset, :]
    else:
        # New content slides down from top
        if offset > 0:
            result[:offset, :] = frame_b[h - offset :, :]
    return result


# ---------------------------------------------------------------------------
# Video I/O helpers
# ---------------------------------------------------------------------------

def create_writer(path: Path, width: int, height: int, fps: float) -> cv2.VideoWriter:
    """Create a cv2.VideoWriter with MJPEG codec."""
    fourcc = cv2.VideoWriter_fourcc(*"MJPG")
    out_path = str(path.with_suffix(".avi"))
    writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError(f"Could not open VideoWriter at {out_path}")
    return writer


def write_n(writer: cv2.VideoWriter, frame: np.ndarray, count: int) -> None:
    """Write the same frame ``count`` times."""
    for _ in range(count):
        writer.write(frame)


def frames_for_duration(fps: float, duration_s: float) -> int:
    """Number of frames needed for a given duration."""
    return max(1, round(fps * duration_s))


def write_transition(
    writer: cv2.VideoWriter,
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    num_frames: int,
    *,
    transition: str = "fade",
) -> None:
    """Write an animated transition between two frames.

    Args:
        transition: "fade", "slide_up", "slide_down", or "cut".
    """
    if transition == "cut" or num_frames <= 1:
        writer.write(frame_b)
        return
    for i in range(num_frames):
        alpha = i / max(1, num_frames - 1)
        if transition == "fade":
            writer.write(fade(frame_a, frame_b, alpha))
        elif transition == "slide_up":
            writer.write(slide_vertical(frame_a, frame_b, alpha, direction=1))
        elif transition == "slide_down":
            writer.write(slide_vertical(frame_a, frame_b, alpha, direction=-1))
        else:
            writer.write(fade(frame_a, frame_b, alpha))


def write_scroll(
    writer: cv2.VideoWriter,
    tall_image: np.ndarray,
    viewport_h: int,
    start_y: int,
    end_y: int,
    num_frames: int,
    *,
    chrome_fn: callable | None = None,
) -> None:
    """Write scroll animation frames.

    Args:
        chrome_fn: Optional function(content) -> frame that wraps content
                   in chrome.  If None, content is written directly.
    """
    for i in range(num_frames):
        progress = i / max(1, num_frames - 1)
        y = round(start_y + (end_y - start_y) * progress)
        content = scroll_crop(tall_image, viewport_h, y)
        frame = chrome_fn(content) if chrome_fn else content
        writer.write(frame)
