"""Synthetic UI video scenarios for evaluating the hybrid v2 detection engine.

Each scenario generates a video with known, controlled UI changes and returns
a ``ScenarioResult`` containing the video path and ground truth events.

Scenarios are organized by category and tagged with difficulty:

    easy    — high-contrast, instantaneous transitions, large affected area
    medium  — realistic transitions, moderate contrast, mixed signals
    hard    — subtle changes, dark themes, animation, noise, edge cases

Use ``all_scenarios()`` to get the full registry or filter by category.
"""

from __future__ import annotations

from functools import partial
from pathlib import Path
from typing import Callable

import numpy as np

from . import rendering as r
from .types import Category, Difficulty, GroundTruthEvent, ScenarioResult

ScenarioFactory = Callable[[Path, float], ScenarioResult]


def _result(
    path: Path,
    ground_truth: list[GroundTruthEvent],
    duration_ms: int,
    fps: float,
    description: str,
    category: Category,
    difficulty: Difficulty,
    width: int = r.DEFAULT_WIDTH,
    height: int = r.DEFAULT_HEIGHT,
) -> ScenarioResult:
    return ScenarioResult(
        video_path=path,
        ground_truth=ground_truth,
        duration_ms=duration_ms,
        fps=fps,
        width=width,
        height=height,
        description=description,
        category=category,
        difficulty=difficulty,
    )


# ═══════════════════════════════════════════════════════════════════════════
# NAVIGATION — full-screen / major layout changes
# ═══════════════════════════════════════════════════════════════════════════


def nav_basic(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Three distinct app screens with instant transitions."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "nav_basic.avi"
    writer = r.create_writer(path, w, h, fps)
    n = r.frames_for_duration(fps, 1.5)

    screens = [
        r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="Inbox"),
        r.app_chrome(r.dashboard_screen(w, r.CONTENT_HEIGHT), header_text="Dashboard"),
        r.app_chrome(r.settings_screen(w, r.CONTENT_HEIGHT), header_text="Settings"),
    ]
    for screen in screens:
        r.write_n(writer, screen, n)
    writer.release()

    return _result(
        Path(str(path)), category="navigation", difficulty="easy", fps=fps,
        duration_ms=round(len(screens) * 1.5 * 1000),
        description="3 distinct app screens (list/dashboard/settings), instant transitions, 1.5s each",
        ground_truth=[
            GroundTruthEvent("navigation", 1500, 1500, {"from": "inbox", "to": "dashboard"}, "easy"),
            GroundTruthEvent("navigation", 3000, 3000, {"from": "dashboard", "to": "settings"}, "easy"),
        ],
    )


def nav_with_fade(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Screen transitions with 300ms crossfade animation."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "nav_fade.avi"
    writer = r.create_writer(path, w, h, fps)

    screens = [
        r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="Messages"),
        r.app_chrome(r.chat_screen(w, r.CONTENT_HEIGHT), header_text="Chat"),
        r.app_chrome(r.form_screen(w, r.CONTENT_HEIGHT), header_text="New Message"),
    ]
    dwell = r.frames_for_duration(fps, 1.2)
    fade_frames = r.frames_for_duration(fps, 0.3)

    r.write_n(writer, screens[0], dwell)
    r.write_transition(writer, screens[0], screens[1], fade_frames, transition="fade")
    r.write_n(writer, screens[1], dwell)
    r.write_transition(writer, screens[1], screens[2], fade_frames, transition="fade")
    r.write_n(writer, screens[2], dwell)
    writer.release()

    t1 = round(1.2 * 1000)
    t2 = round((1.2 + 0.3 + 1.2) * 1000)
    return _result(
        Path(str(path)), category="navigation", difficulty="medium", fps=fps,
        duration_ms=round((1.2 * 3 + 0.3 * 2) * 1000),
        description="3 screens with 300ms crossfade transitions",
        ground_truth=[
            GroundTruthEvent("navigation", t1, t1 + 300, {"transition": "fade"}, "medium"),
            GroundTruthEvent("navigation", t2, t2 + 300, {"transition": "fade"}, "medium"),
        ],
    )


def nav_dark_theme(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Dark-themed navigation with subtle color differences between screens."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "nav_dark.avi"
    writer = r.create_writer(path, w, h, fps)
    n = r.frames_for_duration(fps, 1.5)

    screen1 = r.app_chrome_dark(
        r.list_screen(w, r.CONTENT_HEIGHT, bg=r.DARK_BG,
                      items=[("A", "Alice", "Online"), ("B", "Bob", "Away"), ("C", "Carol", "Offline")]),
        header_text="Dark Inbox",
    )
    screen2 = r.app_chrome_dark(
        r.dashboard_screen(w, r.CONTENT_HEIGHT, bg=r.DARK_BG,
                           values=[("Users", "1.2K"), ("Active", "340"), ("Errors", "12"), ("Uptime", "99.8%")]),
        header_text="Dark Dashboard",
    )
    screen3 = r.app_chrome_dark(
        r.settings_screen(w, r.CONTENT_HEIGHT, bg=r.DARK_BG,
                          items=[("Dark Mode", True), ("Notifications", False), ("Sync", True)]),
        header_text="Dark Settings",
    )

    for screen in [screen1, screen2, screen3]:
        r.write_n(writer, screen, n)
    writer.release()

    return _result(
        Path(str(path)), category="navigation", difficulty="hard", fps=fps,
        duration_ms=4500,
        description="3 dark-themed screens with low-contrast transitions",
        ground_truth=[
            GroundTruthEvent("navigation", 1500, 1500, {"theme": "dark"}, "hard"),
            GroundTruthEvent("navigation", 3000, 3000, {"theme": "dark"}, "hard"),
        ],
    )


def nav_rapid(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """5 screens in 3 seconds — rapid tab switching."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "nav_rapid.avi"
    writer = r.create_writer(path, w, h, fps)

    tab_names = ["Home", "Search", "Alerts", "Profile", "Settings"]
    screens = []
    for i, name in enumerate(tab_names):
        content = r.solid(w, r.CONTENT_HEIGHT, r.GRAY_50)
        r.text_centered(content, f"{name} Screen", r.CONTENT_HEIGHT // 2, color=r.NEAR_BLACK, scale=0.8, thickness=2)
        screens.append(r.app_chrome(content, header_text=name, footer_active_idx=i % 3))

    per_screen = r.frames_for_duration(fps, 0.6)
    for screen in screens:
        r.write_n(writer, screen, per_screen)
    writer.release()

    return _result(
        Path(str(path)), category="navigation", difficulty="hard", fps=fps,
        duration_ms=3000,
        description="5 screens in 3s — rapid tab switching (0.6s each)",
        ground_truth=[
            GroundTruthEvent("navigation", round(i * 600), round(i * 600), {"tab": tab_names[i]}, "hard")
            for i in range(1, len(tab_names))
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# SCROLLING — content moves within a viewport
# ═══════════════════════════════════════════════════════════════════════════


def scroll_list(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Scroll through a list view within fixed chrome."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "scroll_list.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    tall = r.tall_content_strip(w, num_items=12, item_height=64)
    chrome_fn = partial(r.app_chrome, header_text="Contacts", width=w, total_height=h)

    scroll_distance = ch * 2
    dwell = r.frames_for_duration(fps, 1.0)
    scroll_frames = r.frames_for_duration(fps, 2.0)

    # Dwell at top
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, 0)), dwell)
    # Scroll down
    r.write_scroll(writer, tall, ch, 0, scroll_distance, scroll_frames, chrome_fn=chrome_fn)
    # Dwell at bottom
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, scroll_distance)), dwell)
    writer.release()

    return _result(
        Path(str(path)), category="scrolling", difficulty="easy", fps=fps,
        duration_ms=4000,
        description="Scroll through contact list with fixed chrome",
        ground_truth=[
            GroundTruthEvent("scroll", 1000, 3000, {"scroll_dy": scroll_distance, "chrome_stable": True}, "easy"),
        ],
    )


def scroll_slow(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Very slow scroll — 1-2px per frame. Harder to detect."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "scroll_slow.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    tall = r.tall_content_strip(w, num_items=15, item_height=56)
    chrome_fn = partial(r.app_chrome, header_text="Messages", width=w, total_height=h)

    scroll_distance = 80  # only 80px over 3 seconds = ~0.9px/frame at 30fps
    dwell = r.frames_for_duration(fps, 1.0)
    scroll_frames = r.frames_for_duration(fps, 3.0)

    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, 0)), dwell)
    r.write_scroll(writer, tall, ch, 0, scroll_distance, scroll_frames, chrome_fn=chrome_fn)
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, scroll_distance)), dwell)
    writer.release()

    return _result(
        Path(str(path)), category="scrolling", difficulty="hard", fps=fps,
        duration_ms=5000,
        description="Very slow scroll (80px over 3s, ~0.9px/frame) — hard to detect",
        ground_truth=[
            GroundTruthEvent("scroll", 1000, 4000, {"scroll_dy": scroll_distance, "chrome_stable": True}, "hard"),
        ],
    )


def scroll_then_navigate(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Scroll, then immediately navigate to a different screen."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "scroll_then_nav.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    tall = r.tall_content_strip(w, num_items=10, item_height=60)
    chrome_fn = partial(r.app_chrome, header_text="Feed", width=w, total_height=h)
    detail_screen = r.app_chrome(r.chat_screen(w, ch), header_text="Detail")

    scroll_distance = ch
    dwell = r.frames_for_duration(fps, 1.0)
    scroll_frames = r.frames_for_duration(fps, 1.5)

    # Dwell, scroll, brief pause, navigate
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, 0)), dwell)
    r.write_scroll(writer, tall, ch, 0, scroll_distance, scroll_frames, chrome_fn=chrome_fn)
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, scroll_distance)), r.frames_for_duration(fps, 0.5))
    r.write_n(writer, detail_screen, r.frames_for_duration(fps, 1.5))
    writer.release()

    return _result(
        Path(str(path)), category="scrolling", difficulty="medium", fps=fps,
        duration_ms=4500,
        description="Scroll through list, brief pause, then navigate to detail view",
        ground_truth=[
            GroundTruthEvent("scroll", 1000, 2500, {"scroll_dy": scroll_distance, "chrome_stable": True}, "medium"),
            GroundTruthEvent("navigation", 3000, 3000, {"from": "feed", "to": "detail"}, "easy"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# FEED — social media card swaps and incremental scrolling
# ═══════════════════════════════════════════════════════════════════════════


def feed_card_swap(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """TikTok/Reels-style: full content swaps with slide animation, chrome fixed."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "feed_card_swap.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    cards = [
        r.feed_card_content(w, ch, username="alice", caption="Sunset vibes", likes="5.2K likes",
                            image_color=(180, 120, 60), avatar_color=r.BLUE_500),
        r.feed_card_content(w, ch, username="bob", caption="New recipe", likes="1.8K likes",
                            image_color=(60, 140, 200), avatar_color=r.RED_500),
        r.feed_card_content(w, ch, username="carol", caption="Hiking trip!", likes="3.1K likes",
                            image_color=(80, 180, 100), avatar_color=r.GREEN_500_BGR),
    ]

    chrome_fn = partial(r.app_chrome, header_text="For You", footer_tabs=["Home", "Discover", "Create", "Inbox", "Me"],
                        width=w, total_height=h)
    dwell = r.frames_for_duration(fps, 1.5)
    slide_frames = r.frames_for_duration(fps, 0.3)

    # Card 1 dwell
    r.write_n(writer, chrome_fn(cards[0]), dwell)
    # Slide to card 2
    for i in range(slide_frames):
        alpha = i / max(1, slide_frames - 1)
        content = r.slide_vertical(cards[0], cards[1], alpha, direction=1)
        writer.write(chrome_fn(content))
    # Card 2 dwell
    r.write_n(writer, chrome_fn(cards[1]), dwell)
    # Slide to card 3
    for i in range(slide_frames):
        alpha = i / max(1, slide_frames - 1)
        content = r.slide_vertical(cards[1], cards[2], alpha, direction=1)
        writer.write(chrome_fn(content))
    # Card 3 dwell
    r.write_n(writer, chrome_fn(cards[2]), dwell)
    writer.release()

    t1 = round(1.5 * 1000)
    t2 = round((1.5 + 0.3 + 1.5) * 1000)
    return _result(
        Path(str(path)), category="feed", difficulty="medium", fps=fps,
        duration_ms=round((1.5 * 3 + 0.3 * 2) * 1000),
        description="3 feed cards with slide-up transitions, fixed chrome (TikTok-style)",
        ground_truth=[
            GroundTruthEvent("card_swap", t1, t1 + 300, {"from": "alice", "to": "bob", "chrome_stable": True}, "medium"),
            GroundTruthEvent("card_swap", t2, t2 + 300, {"from": "bob", "to": "carol", "chrome_stable": True}, "medium"),
        ],
    )


def feed_scroll(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Instagram/X-style: incremental feed scroll with pause between scrolls."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "feed_scroll.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    tall = r.tall_feed_strip(w, num_cards=8, card_height=200)
    chrome_fn = partial(r.app_chrome, header_text="Feed", footer_tabs=["Home", "Search", "Post", "Notifications", "Profile"],
                        width=w, total_height=h)

    scroll_distance = 180  # roughly one card
    dwell = r.frames_for_duration(fps, 1.2)
    scroll_frames = r.frames_for_duration(fps, 0.8)

    y = 0
    # Dwell
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, y)), dwell)
    # Scroll 1
    r.write_scroll(writer, tall, ch, y, y + scroll_distance, scroll_frames, chrome_fn=chrome_fn)
    y += scroll_distance
    # Pause
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, y)), dwell)
    # Scroll 2
    r.write_scroll(writer, tall, ch, y, y + scroll_distance, scroll_frames, chrome_fn=chrome_fn)
    y += scroll_distance
    # Final dwell
    r.write_n(writer, chrome_fn(r.scroll_crop(tall, ch, y)), dwell)
    writer.release()

    t_scroll_1_start = round(1.2 * 1000)
    t_scroll_1_end = round((1.2 + 0.8) * 1000)
    t_scroll_2_start = round((1.2 + 0.8 + 1.2) * 1000)
    t_scroll_2_end = round((1.2 + 0.8 + 1.2 + 0.8) * 1000)
    return _result(
        Path(str(path)), category="feed", difficulty="medium", fps=fps,
        duration_ms=round((1.2 * 3 + 0.8 * 2) * 1000),
        description="Feed scroll with 2 scroll gestures and pauses between (Instagram-style)",
        ground_truth=[
            GroundTruthEvent("scroll", t_scroll_1_start, t_scroll_1_end, {"scroll_dy": scroll_distance, "chrome_stable": True}, "medium"),
            GroundTruthEvent("scroll", t_scroll_2_start, t_scroll_2_end, {"scroll_dy": scroll_distance, "chrome_stable": True}, "medium"),
        ],
    )


def feed_fullscreen_swipe(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """True fullscreen TikTok/Reels swipe — no chrome, overlay UI is positionally stable.

    3 reels shown in sequence. The UI overlay (username, like/comment/share icons) is
    rendered at fixed positions on every frame; only the background content color changes.
    This tests whether the detector can identify whole-frame content changes even when
    ~25% of the frame area is covered by a stable semi-transparent overlay.
    """
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "feed_fullscreen_swipe.avi"
    writer = r.create_writer(path, w, h, fps)

    reels = [
        r.reel_frame(w, h, bg_color=(50, 120, 200), username="alex_travels",
                     caption="Golden hour in Santorini #travel #greece",
                     likes="87.3K", comments="2.1K", shares="4.5K",
                     sound="Somewhere Over - DJ Mix", avatar_color=r.BLUE_500),
        r.reel_frame(w, h, bg_color=(30, 160, 90), username="chef_maria",
                     caption="5-min pasta that hits every time #cooking #food",
                     likes="134.2K", comments="8.7K", shares="22.1K",
                     sound="Italian Vibes - Lofi", avatar_color=r.GREEN_500_BGR),
        r.reel_frame(w, h, bg_color=(180, 60, 100), username="urban_lens",
                     caption="NYC at 3am is a different world #nyc #streetphoto",
                     likes="56.8K", comments="1.4K", shares="3.2K",
                     sound="City Rain - Ambient", avatar_color=r.PURPLE_500),
    ]

    dwell = r.frames_for_duration(fps, 1.5)
    slide_f = r.frames_for_duration(fps, 0.3)

    r.write_n(writer, reels[0], dwell)
    r.write_transition(writer, reels[0], reels[1], slide_f, transition="slide_up")
    r.write_n(writer, reels[1], dwell)
    r.write_transition(writer, reels[1], reels[2], slide_f, transition="slide_up")
    r.write_n(writer, reels[2], dwell)
    writer.release()

    t1 = round(1.5 * 1000)
    t2 = round((1.5 + 0.3 + 1.5) * 1000)
    return _result(
        Path(str(path)), category="feed", difficulty="medium", fps=fps,
        duration_ms=round((1.5 * 3 + 0.3 * 2) * 1000),
        description="3 fullscreen reels, slide-up swipe (TikTok/Reels), stable overlay UI, no chrome",
        ground_truth=[
            GroundTruthEvent("card_swap", t1, t1 + 300,
                             {"from": "alex_travels", "to": "chef_maria", "fullscreen": True, "chrome_stable": False}, "medium"),
            GroundTruthEvent("card_swap", t2, t2 + 300,
                             {"from": "chef_maria", "to": "urban_lens", "fullscreen": True, "chrome_stable": False}, "medium"),
        ],
    )


def feed_fullscreen_rapid(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Rapid fullscreen reel swipes — 5 reels at 0.5s dwell, 0.2s transition.

    Simulates a user quickly flicking through TikTok content. Tests detection at
    high transition frequency in fullscreen without any chrome anchors.
    """
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "feed_fullscreen_rapid.avi"
    writer = r.create_writer(path, w, h, fps)

    reel_configs = [
        {"bg_color": (40, 100, 220), "username": "creator_a", "caption": "First reel", "likes": "12K", "avatar_color": r.BLUE_500},
        {"bg_color": (200, 80, 50),  "username": "creator_b", "caption": "Second reel", "likes": "34K", "avatar_color": r.RED_500},
        {"bg_color": (60, 180, 80),  "username": "creator_c", "caption": "Third reel", "likes": "8K", "avatar_color": r.GREEN_500_BGR},
        {"bg_color": (150, 60, 180), "username": "creator_d", "caption": "Fourth reel", "likes": "91K", "avatar_color": r.PURPLE_500},
        {"bg_color": (30, 160, 180), "username": "creator_e", "caption": "Fifth reel", "likes": "55K", "avatar_color": r.ORANGE_500},
    ]
    reels = [r.reel_frame(w, h, comments="500", shares="200", sound="Trending Audio", **cfg) for cfg in reel_configs]

    dwell = r.frames_for_duration(fps, 0.5)
    slide_f = r.frames_for_duration(fps, 0.2)

    t = 0.0
    swipe_times = []
    r.write_n(writer, reels[0], dwell)
    t += 0.5
    for i in range(len(reels) - 1):
        swipe_times.append(t)
        r.write_transition(writer, reels[i], reels[i + 1], slide_f, transition="slide_up")
        t += 0.2
        r.write_n(writer, reels[i + 1], dwell)
        t += 0.5

    writer.release()

    return _result(
        Path(str(path)), category="feed", difficulty="hard", fps=fps,
        duration_ms=round(t * 1000),
        description="5 fullscreen reels, 0.5s dwell, 0.2s swipe — rapid TikTok flicking",
        ground_truth=[
            GroundTruthEvent("card_swap", round(ts * 1000), round((ts + 0.2) * 1000),
                             {"index": i + 1, "fullscreen": True, "rapid": True}, "hard")
            for i, ts in enumerate(swipe_times)
        ],
    )


def feed_reels_stable_overlay(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Fullscreen reel where the overlay UI elements are identical across swipes.

    Same username, same like/comment counts, same sound — only the background
    color/content changes. This is the hardest feed scenario: a large stable
    region (bottom overlay + right strip) covers ~30% of the frame, while the
    changing background covers the rest.  Tests whether the detector can isolate
    the content-change signal from the stable overlay regions.
    """
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "feed_reels_stable_overlay.avi"
    writer = r.create_writer(path, w, h, fps)

    shared_overlay_kwargs = dict(
        username="looped_creator",
        caption="Part of a series #loop #series",
        likes="210K", comments="4.5K", shares="12K",
        sound="Viral Song - Artist Name",
        avatar_color=r.ORANGE_500,
        show_follow=False,  # Already followed — no + badge
    )

    content_colors = [
        (70, 130, 220),   # blue-tinted scene
        (50, 170, 100),   # green scene
        (200, 100, 80),   # warm scene
    ]
    reels = [r.reel_frame(w, h, bg_color=c, **shared_overlay_kwargs) for c in content_colors]

    dwell = r.frames_for_duration(fps, 2.0)
    slide_f = r.frames_for_duration(fps, 0.3)

    r.write_n(writer, reels[0], dwell)
    r.write_transition(writer, reels[0], reels[1], slide_f, transition="slide_up")
    r.write_n(writer, reels[1], dwell)
    r.write_transition(writer, reels[1], reels[2], slide_f, transition="slide_up")
    r.write_n(writer, reels[2], dwell)
    writer.release()

    t1 = round(2.0 * 1000)
    t2 = round((2.0 + 0.3 + 2.0) * 1000)
    return _result(
        Path(str(path)), category="feed", difficulty="hard", fps=fps,
        duration_ms=round((2.0 * 3 + 0.3 * 2) * 1000),
        description="Fullscreen reels: same overlay UI, only background changes — ~30% stable region",
        ground_truth=[
            GroundTruthEvent("card_swap", t1, t1 + 300,
                             {"stable_overlay_pct": 0.30, "fullscreen": True}, "hard"),
            GroundTruthEvent("card_swap", t2, t2 + 300,
                             {"stable_overlay_pct": 0.30, "fullscreen": True}, "hard"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# OVERLAY — modals, toasts, drawers
# ═══════════════════════════════════════════════════════════════════════════


def overlay_modal(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Modal dialog with backdrop fade-in."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "overlay_modal.avi"
    writer = r.create_writer(path, w, h, fps)

    base = r.app_chrome(r.dashboard_screen(w, r.CONTENT_HEIGHT), header_text="Dashboard")

    # Build modal frame
    modal_frame = base.copy()
    overlay = np.full_like(modal_frame, 40)
    modal_frame = r.fade(modal_frame, overlay, 0.4)
    mx, my, mw, mh = (w - 320) // 2, (h - 200) // 2, 320, 200
    r.rect(modal_frame, mx, my, mw, mh, r.WHITE, radius=12)
    r.text_centered(modal_frame, "Delete Item?", my + 50, color=r.NEAR_BLACK, scale=0.6, thickness=2)
    r.text_centered(modal_frame, "This action cannot be undone.", my + 80, color=r.GRAY_500, scale=0.38)
    r.button(modal_frame, "Cancel", mx + 20, my + 140, 120, 36, bg=r.GRAY_200, text_color=r.NEAR_BLACK)
    r.button(modal_frame, "Delete", mx + 180, my + 140, 120, 36, bg=r.RED_500)

    dwell = r.frames_for_duration(fps, 2.0)
    fade_frames = r.frames_for_duration(fps, 0.25)

    r.write_n(writer, base, dwell)
    r.write_transition(writer, base, modal_frame, fade_frames, transition="fade")
    r.write_n(writer, modal_frame, dwell)
    writer.release()

    t = round(2.0 * 1000)
    return _result(
        Path(str(path)), category="overlay", difficulty="easy", fps=fps,
        duration_ms=round((2.0 + 0.25 + 2.0) * 1000),
        description="Dashboard with centered modal dialog appearing via fade",
        ground_truth=[
            GroundTruthEvent("modal", t, t + 250, {"modal_bounds": {"x": mx, "y": my, "w": mw, "h": mh}}, "easy"),
        ],
    )


def overlay_toast(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Small toast notification in bottom-right — subtle UI change."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "overlay_toast.avi"
    writer = r.create_writer(path, w, h, fps)

    base = r.app_chrome(r.form_screen(w, r.CONTENT_HEIGHT), header_text="Edit Profile")

    toast_frame = base.copy()
    tx, ty, tw, th = w - 200, h - 70, 180, 40
    r.rect(toast_frame, tx, ty, tw, th, r.NEAR_BLACK, radius=8)
    r.text(toast_frame, "Changes saved", tx + 16, ty + 26, color=r.WHITE, scale=0.4)

    dwell = r.frames_for_duration(fps, 2.0)
    toast_dwell = r.frames_for_duration(fps, 1.5)

    r.write_n(writer, base, dwell)
    r.write_n(writer, toast_frame, toast_dwell)
    r.write_n(writer, base, dwell)
    writer.release()

    t = round(2.0 * 1000)
    return _result(
        Path(str(path)), category="overlay", difficulty="hard", fps=fps,
        duration_ms=round((2.0 + 1.5 + 2.0) * 1000),
        description="Small toast notification (180x40px) appears in bottom-right for 1.5s",
        ground_truth=[
            GroundTruthEvent("small_ui_change", t, t, {"region": {"x": tx, "y": ty, "w": tw, "h": th}}, "hard"),
        ],
    )


def overlay_bottom_sheet(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Bottom sheet slides up from footer — covers lower 40% of screen."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "overlay_bottom_sheet.avi"
    writer = r.create_writer(path, w, h, fps)

    base = r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="Photos")

    sheet_h = round(h * 0.4)
    sheet_frame = base.copy()
    r.rect(sheet_frame, 0, h - sheet_h, w, sheet_h, r.WHITE, radius=0)
    r.divider(sheet_frame, h - sheet_h, color=r.GRAY_300)
    # Sheet handle
    r.rect(sheet_frame, w // 2 - 20, h - sheet_h + 8, 40, 4, r.GRAY_300, radius=2)
    # Sheet content
    r.text(sheet_frame, "Share to...", 20, h - sheet_h + 36, color=r.NEAR_BLACK, scale=0.5, thickness=1)
    icons_y = h - sheet_h + 56
    for i, label in enumerate(["Copy Link", "Messages", "Email", "More"]):
        cx = 40 + i * (w // 4)
        r.circle(sheet_frame, cx, icons_y + 20, 22, r.GRAY_200)
        r.text(sheet_frame, label, cx - 24, icons_y + 56, color=r.GRAY_600, scale=0.3)

    dwell = r.frames_for_duration(fps, 1.5)
    slide_frames = r.frames_for_duration(fps, 0.3)

    r.write_n(writer, base, dwell)
    # Slide up animation
    for i in range(slide_frames):
        progress = i / max(1, slide_frames - 1)
        anim = base.copy()
        visible_h = round(sheet_h * progress)
        if visible_h > 0:
            anim[h - visible_h:, :] = sheet_frame[h - visible_h:, :]
        writer.write(anim)
    r.write_n(writer, sheet_frame, dwell)
    writer.release()

    t = round(1.5 * 1000)
    return _result(
        Path(str(path)), category="overlay", difficulty="medium", fps=fps,
        duration_ms=round((1.5 + 0.3 + 1.5) * 1000),
        description="Bottom sheet slides up covering lower 40% of screen",
        ground_truth=[
            GroundTruthEvent("modal", t, t + 300, {"style": "bottom_sheet", "coverage": 0.4}, "medium"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# CONTENT — text/data changes, loading states
# ═══════════════════════════════════════════════════════════════════════════


def content_text_update(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Dashboard metrics update — same layout, values change."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "content_text_update.avi"
    writer = r.create_writer(path, w, h, fps)

    states = [
        [("Users", "1,234"), ("Revenue", "$56.7K"), ("Orders", "892"), ("Rating", "4.8")],
        [("Users", "1,237"), ("Revenue", "$57.1K"), ("Orders", "895"), ("Rating", "4.8")],
        [("Users", "1,245"), ("Revenue", "$58.3K"), ("Orders", "901"), ("Rating", "4.9")],
    ]
    n = r.frames_for_duration(fps, 2.0)
    for values in states:
        screen = r.app_chrome(r.dashboard_screen(w, r.CONTENT_HEIGHT, values=values), header_text="Analytics")
        r.write_n(writer, screen, n)
    writer.release()

    return _result(
        Path(str(path)), category="content", difficulty="hard", fps=fps,
        duration_ms=6000,
        description="Dashboard metrics update 3 times — layout stable, only numbers change",
        ground_truth=[
            GroundTruthEvent("content_update", 2000, 2000, {"change": "metrics_update_1"}, "hard"),
            GroundTruthEvent("content_update", 4000, 4000, {"change": "metrics_update_2"}, "hard"),
        ],
    )


def content_loading_to_data(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Skeleton loading screen transitions to real content."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "content_loading.avi"
    writer = r.create_writer(path, w, h, fps)

    loading = r.app_chrome(r.loading_skeleton_screen(w, r.CONTENT_HEIGHT), header_text="Dashboard")
    content = r.app_chrome(r.dashboard_screen(w, r.CONTENT_HEIGHT), header_text="Dashboard")

    loading_dwell = r.frames_for_duration(fps, 2.0)
    fade_frames = r.frames_for_duration(fps, 0.2)
    content_dwell = r.frames_for_duration(fps, 2.0)

    r.write_n(writer, loading, loading_dwell)
    r.write_transition(writer, loading, content, fade_frames, transition="fade")
    r.write_n(writer, content, content_dwell)
    writer.release()

    return _result(
        Path(str(path)), category="content", difficulty="easy", fps=fps,
        duration_ms=round((2.0 + 0.2 + 2.0) * 1000),
        description="Skeleton loading screen fades to dashboard content",
        ground_truth=[
            GroundTruthEvent("navigation", 2000, 2200, {"from": "loading", "to": "content"}, "easy"),
        ],
    )


def content_typing(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Typing in a text field — characters appear one at a time in a small region."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "content_typing.avi"
    writer = r.create_writer(path, w, h, fps)

    message = "Hello, how are you today?"
    chars_per_second = 6
    frames_per_char = max(1, round(fps / chars_per_second))

    # Write initial screen with empty input
    base_content = r.form_screen(w, r.CONTENT_HEIGHT, fields=[("To", "Alice"), ("Subject", "Meeting"), ("Message", "")])
    base = r.app_chrome(base_content, header_text="Compose")
    r.write_n(writer, base, r.frames_for_duration(fps, 1.0))

    # Type characters one at a time
    for i in range(len(message)):
        typed = message[: i + 1]
        content = r.form_screen(w, r.CONTENT_HEIGHT, fields=[("To", "Alice"), ("Subject", "Meeting"), ("Message", typed)])
        screen = r.app_chrome(content, header_text="Compose")
        r.write_n(writer, screen, frames_per_char)

    # Dwell after typing
    r.write_n(writer, screen, r.frames_for_duration(fps, 1.0))
    writer.release()

    typing_duration_ms = round(len(message) * (1000 / chars_per_second))
    return _result(
        Path(str(path)), category="content", difficulty="hard", fps=fps,
        duration_ms=round(1000 + typing_duration_ms + 1000),
        description="Typing 25 chars into a form field at 6 chars/sec — continuous small changes",
        ground_truth=[
            # Typing is a continuous small change — should ideally be detected as one event
            GroundTruthEvent("content_update", 1000, 1000 + typing_duration_ms,
                             {"type": "typing", "chars": len(message)}, "hard"),
        ],
    )


def content_dwell(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Long stable periods around a single navigation — tests dwell tracking."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "content_dwell.avi"
    writer = r.create_writer(path, w, h, fps)

    screen1 = r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="Inbox")
    screen2 = r.app_chrome(r.chat_screen(w, r.CONTENT_HEIGHT), header_text="Chat")

    r.write_n(writer, screen1, r.frames_for_duration(fps, 5.0))
    r.write_n(writer, screen2, r.frames_for_duration(fps, 3.0))
    writer.release()

    return _result(
        Path(str(path)), category="content", difficulty="easy", fps=fps,
        duration_ms=8000,
        description="5s stable inbox, instant navigation to chat, 3s stable chat — tests dwell measurement",
        ground_truth=[
            GroundTruthEvent("navigation", 5000, 5000, {"dwell_before_ms": 5000, "dwell_after_ms": 3000}, "easy"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# COMPOSITE — mixed multi-event sessions
# ═══════════════════════════════════════════════════════════════════════════


def composite_browse_session(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Realistic session: navigate, scroll, tap item, modal, dismiss, navigate back."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "composite_session.avi"
    writer = r.create_writer(path, w, h, fps)
    ch = r.CONTENT_HEIGHT

    # Screen A: list view
    tall = r.tall_content_strip(w, num_items=10, item_height=60)
    list_chrome = partial(r.app_chrome, header_text="Inbox", width=w, total_height=h)

    # Screen B: chat detail
    chat = r.app_chrome(r.chat_screen(w, ch), header_text="Alice")

    # Modal on chat
    modal = chat.copy()
    overlay = np.full_like(modal, 40)
    modal = r.fade(modal, overlay, 0.4)
    mx, my, mw, mh = (w - 280) // 2, (h - 160) // 2, 280, 160
    r.rect(modal, mx, my, mw, mh, r.WHITE, radius=12)
    r.text_centered(modal, "Block user?", my + 60, color=r.NEAR_BLACK, scale=0.5, thickness=1)
    r.button(modal, "No", mx + 20, my + 100, 100, 36, bg=r.GRAY_200, text_color=r.NEAR_BLACK)
    r.button(modal, "Yes", mx + 160, my + 100, 100, 36, bg=r.RED_500)

    dwell = r.frames_for_duration(fps, 1.2)
    short_dwell = r.frames_for_duration(fps, 0.8)
    scroll_frames = r.frames_for_duration(fps, 1.5)
    fade_f = r.frames_for_duration(fps, 0.2)

    t = 0.0

    # 1. Dwell on list
    r.write_n(writer, list_chrome(r.scroll_crop(tall, ch, 0)), dwell)
    t += 1.2

    # 2. Scroll down
    scroll_start = t
    r.write_scroll(writer, tall, ch, 0, ch, scroll_frames, chrome_fn=list_chrome)
    t += 1.5
    scroll_end = t

    # 3. Brief dwell
    r.write_n(writer, list_chrome(r.scroll_crop(tall, ch, ch)), short_dwell)
    t += 0.8

    # 4. Navigate to chat
    nav1_t = t
    r.write_transition(writer, list_chrome(r.scroll_crop(tall, ch, ch)), chat, fade_f, transition="fade")
    t += 0.2
    r.write_n(writer, chat, dwell)
    t += 1.2

    # 5. Open modal
    modal_t = t
    r.write_transition(writer, chat, modal, fade_f, transition="fade")
    t += 0.2
    r.write_n(writer, modal, dwell)
    t += 1.2

    # 6. Dismiss modal (back to chat)
    r.write_transition(writer, modal, chat, fade_f, transition="fade")
    t += 0.2
    r.write_n(writer, chat, short_dwell)
    t += 0.8

    # 7. Navigate back to list
    nav2_t = t
    back_frame = list_chrome(r.scroll_crop(tall, ch, ch))
    r.write_transition(writer, chat, back_frame, fade_f, transition="fade")
    t += 0.2
    r.write_n(writer, back_frame, dwell)
    t += 1.2

    writer.release()

    return _result(
        Path(str(path)), category="composite", difficulty="medium", fps=fps,
        duration_ms=round(t * 1000),
        description="Full session: dwell, scroll, navigate, modal open/dismiss, navigate back",
        ground_truth=[
            GroundTruthEvent("scroll", round(scroll_start * 1000), round(scroll_end * 1000),
                             {"scroll_dy": ch, "chrome_stable": True}, "medium"),
            GroundTruthEvent("navigation", round(nav1_t * 1000), round(nav1_t * 1000 + 200),
                             {"from": "inbox", "to": "chat"}, "easy"),
            GroundTruthEvent("modal", round(modal_t * 1000), round(modal_t * 1000 + 200),
                             {"style": "dialog"}, "easy"),
            GroundTruthEvent("navigation", round(nav2_t * 1000), round(nav2_t * 1000 + 200),
                             {"from": "chat", "to": "inbox"}, "easy"),
        ],
    )


def composite_back_and_forth(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Navigate A->B->A->B — tests deduplication and revisit detection."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "composite_back_forth.avi"
    writer = r.create_writer(path, w, h, fps)

    screen_a = r.app_chrome(r.list_screen(w, r.CONTENT_HEIGHT), header_text="Inbox")
    screen_b = r.app_chrome(r.chat_screen(w, r.CONTENT_HEIGHT), header_text="Chat")

    dwell = r.frames_for_duration(fps, 1.0)
    screens = [screen_a, screen_b, screen_a, screen_b]
    for screen in screens:
        r.write_n(writer, screen, dwell)
    writer.release()

    return _result(
        Path(str(path)), category="composite", difficulty="medium", fps=fps,
        duration_ms=4000,
        description="Navigate A->B->A->B (1s each) — tests deduplication/revisit",
        ground_truth=[
            GroundTruthEvent("navigation", 1000, 1000, {"from": "inbox", "to": "chat"}, "easy"),
            GroundTruthEvent("navigation", 2000, 2000, {"from": "chat", "to": "inbox", "revisit": True}, "medium"),
            GroundTruthEvent("navigation", 3000, 3000, {"from": "inbox", "to": "chat", "revisit": True}, "medium"),
        ],
    )


def composite_with_noise(output_dir: Path, fps: float = r.DEFAULT_FPS) -> ScenarioResult:
    """Navigation with Gaussian noise on every frame — simulates compression artifacts."""
    w, h = r.DEFAULT_WIDTH, r.DEFAULT_HEIGHT
    path = output_dir / "composite_noise.avi"
    writer = r.create_writer(path, w, h, fps)

    screen1 = r.app_chrome(r.dashboard_screen(w, r.CONTENT_HEIGHT), header_text="Analytics")
    screen2 = r.app_chrome(r.settings_screen(w, r.CONTENT_HEIGHT), header_text="Settings")

    dwell = r.frames_for_duration(fps, 2.0)

    for i in range(dwell):
        writer.write(r.add_noise(screen1, intensity=4.0, seed=i))
    for i in range(dwell):
        writer.write(r.add_noise(screen2, intensity=4.0, seed=dwell + i))
    writer.release()

    return _result(
        Path(str(path)), category="composite", difficulty="hard", fps=fps,
        duration_ms=4000,
        description="2 screens with Gaussian noise on every frame (simulates compression)",
        ground_truth=[
            GroundTruthEvent("navigation", 2000, 2000, {"noise": True}, "hard"),
        ],
    )


# ═══════════════════════════════════════════════════════════════════════════
# Scenario registry
# ═══════════════════════════════════════════════════════════════════════════

ALL_SCENARIOS: list[tuple[str, ScenarioFactory]] = [
    # Navigation
    ("nav_basic", nav_basic),
    ("nav_with_fade", nav_with_fade),
    ("nav_dark_theme", nav_dark_theme),
    ("nav_rapid", nav_rapid),
    # Scrolling
    ("scroll_list", scroll_list),
    ("scroll_slow", scroll_slow),
    ("scroll_then_navigate", scroll_then_navigate),
    # Feed
    ("feed_card_swap", feed_card_swap),
    ("feed_scroll", feed_scroll),
    ("feed_fullscreen_swipe", feed_fullscreen_swipe),
    ("feed_fullscreen_rapid", feed_fullscreen_rapid),
    ("feed_reels_stable_overlay", feed_reels_stable_overlay),
    # Overlay
    ("overlay_modal", overlay_modal),
    ("overlay_toast", overlay_toast),
    ("overlay_bottom_sheet", overlay_bottom_sheet),
    # Content
    ("content_text_update", content_text_update),
    ("content_loading_to_data", content_loading_to_data),
    ("content_typing", content_typing),
    ("content_dwell", content_dwell),
    # Composite
    ("composite_browse_session", composite_browse_session),
    ("composite_back_and_forth", composite_back_and_forth),
    ("composite_with_noise", composite_with_noise),
]


def all_scenarios() -> list[tuple[str, ScenarioFactory]]:
    """Return all registered (name, factory) pairs."""
    return list(ALL_SCENARIOS)


def scenarios_by_category(category: Category) -> list[tuple[str, ScenarioFactory]]:
    """Return scenarios filtered by category."""
    return [(n, f) for n, f in ALL_SCENARIOS if n.startswith(category)]
