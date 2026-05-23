#!/usr/bin/env python3
"""
Fast Instagram posting flow — single process, ~15s total.

Usage:
  py scripts/ig-post-flow.py --video "filename.mp4" --caption "text" --videos-dir "~/Videos"

Returns JSON to stdout:
  {"success": true, "duration_s": 15.2}
  {"success": false, "error": "...", "step": "share"}
"""

import sys
import os
import time
import json
import argparse
import ctypes
from ctypes import wintypes

import pyautogui
import pyperclip
import mss
from PIL import Image

# --- Win32 setup ---

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Keep fail-safe enabled (move mouse to corner to abort), reduce pause for speed
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

# --- Constants for 1920x1080 maximized Chrome ---

# Dialog header blue text y-range (下一步 / 分享)
HEADER_Y_MIN = 235
HEADER_Y_MAX = 275

# Caption area (right panel of create dialog)
CAPTION_X = 1200
CAPTION_Y = 380

# Aspect ratio icon (bottom-left of crop dialog overlay)
ASPECT_ICON_X = 655
ASPECT_ICON_Y = 908

# Blue color thresholds (Instagram's blue buttons/text)
BLUE_MIN = (0, 100, 200)   # R, G, B minimum
BLUE_MAX = (120, 180, 255)  # R, G, B maximum


def result_json(success, duration_s=0, error="", step=""):
    """Print result as JSON and exit."""
    out = {"success": success, "duration_s": round(duration_s, 1)}
    if error:
        out["error"] = error
    if step:
        out["step"] = step
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if success else 1)


def minimize_console():
    """Minimize this console window so it doesn't interfere."""
    hwnd = kernel32.GetConsoleWindow()
    if hwnd:
        user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE


def find_chrome_hwnd():
    """Find the largest visible Chrome_WidgetWin_1 window."""
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    best_hwnd = None
    best_area = 0

    def enum_cb(hwnd, _):
        nonlocal best_hwnd, best_area
        if not user32.IsWindowVisible(hwnd):
            return True

        class_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buf, 256)
        if class_buf.value != "Chrome_WidgetWin_1":
            return True

        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        area = rect.right * rect.bottom
        if area > best_area:
            best_area = area
            best_hwnd = hwnd
        return True

    user32.EnumWindows(EnumWindowsProc(enum_cb), 0)
    return best_hwnd


def activate_chrome(hwnd):
    """Bring Chrome to foreground using Alt key trick."""
    # Alt key trick bypasses Windows restriction on SetForegroundWindow from background
    user32.keybd_event(0x12, 0, 0, 0)  # ALT down
    user32.keybd_event(0x12, 0, 2, 0)  # ALT up
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.3)


def maximize_chrome(hwnd):
    """Maximize the Chrome window to ensure consistent coordinates."""
    user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
    time.sleep(0.5)


def grab_screen():
    """Capture primary monitor as PIL Image."""
    with mss.mss() as sct:
        mon = sct.monitors[1]  # Primary monitor
        shot = sct.grab(mon)
        return Image.frombytes("RGB", (shot.width, shot.height), shot.rgb)


def is_blue_pixel(r, g, b):
    """Check if a pixel is Instagram's blue color."""
    return (
        BLUE_MIN[0] <= r <= BLUE_MAX[0]
        and BLUE_MIN[1] <= g <= BLUE_MAX[1]
        and BLUE_MIN[2] <= b <= BLUE_MAX[2]
    )


def scan_for_blue_text(img, x_min, x_max, y_min, y_max, min_cluster=5):
    """Scan a region for a cluster of blue pixels (button/text).
    Returns center (x, y) of the largest blue cluster, or None."""
    blue_pixels = []
    for y in range(y_min, min(y_max, img.height)):
        for x in range(x_min, min(x_max, img.width)):
            r, g, b = img.getpixel((x, y))
            if is_blue_pixel(r, g, b):
                blue_pixels.append((x, y))

    if len(blue_pixels) < min_cluster:
        return None

    # Return center of mass
    avg_x = sum(p[0] for p in blue_pixels) // len(blue_pixels)
    avg_y = sum(p[1] for p in blue_pixels) // len(blue_pixels)
    return (avg_x, avg_y)


def scan_for_blue_button(img, x_min, x_max, y_min, y_max, min_cluster=50):
    """Scan for a large blue button (like 從電腦選擇)."""
    return scan_for_blue_text(img, x_min, x_max, y_min, y_max, min_cluster)


def find_create_icon(img):
    """Find the Create (+) icon in the Instagram sidebar.
    Scans the left sidebar for the + icon shape."""
    # Sidebar is typically 0-75px wide (collapsed) or 0-245px (expanded)
    # The Create (+) icon is around y=650-680 in collapsed mode
    # Look for dark pixels forming the + shape in the sidebar

    # Strategy: scan sidebar area for icon-like dark pixel clusters
    for x_center in range(15, 250, 5):
        for y_center in range(600, 750, 5):
            # Check if there's a dark icon-like cluster here
            dark_count = 0
            for dx in range(-10, 11, 2):
                for dy in range(-10, 11, 2):
                    px = x_center + dx
                    py = y_center + dy
                    if 0 <= px < img.width and 0 <= py < img.height:
                        r, g, b = img.getpixel((px, py))
                        if r < 60 and g < 60 and b < 60:
                            dark_count += 1
            # A + icon has roughly 20-50 dark pixels in an 20x20 area
            if 15 <= dark_count <= 80:
                # Verify it looks like a + (more dark in cross pattern)
                horiz = 0
                vert = 0
                for dx in range(-8, 9):
                    px = x_center + dx
                    if 0 <= px < img.width:
                        r, g, b = img.getpixel((px, y_center))
                        if r < 60 and g < 60 and b < 60:
                            horiz += 1
                for dy in range(-8, 9):
                    py = y_center + dy
                    if 0 <= py < img.height:
                        r, g, b = img.getpixel((x_center, py))
                        if r < 60 and g < 60 and b < 60:
                            vert += 1
                if horiz >= 5 and vert >= 5:
                    return (x_center, y_center)
    return None


def wait_for_element(scan_fn, timeout_s=10, interval_s=0.5, label="element"):
    """Repeatedly scan until element found or timeout."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        img = grab_screen()
        result = scan_fn(img)
        if result:
            return result
        time.sleep(interval_s)
    return None


def wait_for_shared(timeout_s=30, interval_s=1.0):
    """Wait for the '已分享貼文' (post shared) confirmation.
    Instagram shows a checkmark + text after successful share."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        img = grab_screen()
        # After sharing, the dialog shows a centered checkmark animation
        # The dialog area is roughly x:650-1280, y:300-700
        # Look for the green/dark checkmark or the disappearance of the blue Share button
        header_blue = scan_for_blue_text(img, 600, 1350, HEADER_Y_MIN, HEADER_Y_MAX, min_cluster=3)
        if header_blue is None:
            # Blue header text gone = sharing completed (or dialog closed)
            return True
        time.sleep(interval_s)
    return False


def paste_text(text):
    """Paste text using clipboard (IME-safe)."""
    pyperclip.copy(text)
    time.sleep(0.1)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.2)


def navigate_to_instagram():
    """Navigate Chrome to instagram.com via address bar."""
    pyperclip.copy("https://www.instagram.com/")
    time.sleep(0.1)
    pyautogui.hotkey("ctrl", "l")
    time.sleep(0.3)
    pyautogui.hotkey("ctrl", "v")
    time.sleep(0.2)
    pyautogui.press("enter")
    time.sleep(2.0)  # Wait for page load


def click_create():
    """Find and click the Create (+) button."""
    img = grab_screen()
    pos = find_create_icon(img)
    if pos:
        pyautogui.click(pos[0], pos[1])
        return pos

    # Fallback: try common positions for collapsed sidebar
    for fallback_y in [665, 650, 680, 640, 695]:
        for fallback_x in [26, 36, 130]:
            img2 = grab_screen()
            r, g, b = img2.getpixel((fallback_x, fallback_y))
            if r < 80 and g < 80 and b < 80:
                pyautogui.click(fallback_x, fallback_y)
                return (fallback_x, fallback_y)

    return None


def click_post_option():
    """Click 貼文 in the expanded Create menu (appears below Create icon)."""
    time.sleep(0.5)
    img = grab_screen()

    # After clicking Create, a popup menu appears near the icon
    # 貼文 is the first item, typically ~50px below where we clicked
    # Look for text "貼文" or just the first menu item

    # The popup menu has white background with dark text
    # Scan for menu items in the sidebar area
    for y in range(400, 800):
        for x in range(10, 300):
            r, g, b = img.getpixel((x, y))
            # Look for dark text on white/light background
            if r < 50 and g < 50 and b < 50:
                # Check if surrounding area is light (menu background)
                bg_count = 0
                for dx in [-20, -15, 15, 20]:
                    px = x + dx
                    if 0 <= px < img.width:
                        br, bg, bb = img.getpixel((px, y))
                        if br > 230 and bg > 230 and bb > 230:
                            bg_count += 1
                if bg_count >= 3:
                    # Found dark text on light background - likely menu item
                    pyautogui.click(x, y)
                    return (x, y)

    # Fallback: click slightly below last known Create position
    # The popup 貼文 item is usually the first option
    return None


def handle_file_dialog(file_path):
    """Handle the Windows file open dialog.
    Uses Alt+N to focus filename field, then pastes path."""
    time.sleep(1.0)

    # Alt+N focuses the filename input in Windows file dialog
    pyautogui.hotkey("alt", "n")
    time.sleep(0.3)

    # Clear existing text and paste file path
    pyautogui.hotkey("ctrl", "a")
    time.sleep(0.1)
    paste_text(file_path)
    time.sleep(0.3)

    # Press Enter to confirm
    pyautogui.press("enter")
    time.sleep(0.5)


def set_original_aspect_ratio():
    """Click the aspect ratio icon and select 原始 (original) ratio.
    This ensures the full video/image is shown without cropping."""
    time.sleep(0.5)
    img = grab_screen()

    # The aspect ratio icon is in the bottom-left of the crop dialog
    # It's a small circular icon with crop lines inside
    # Located around (655, 908) for the dialog overlay area

    # Check a few candidate positions
    candidates = [
        (655, 908), (650, 905), (660, 910), (645, 900),
        (655, 895), (665, 908), (640, 908),
    ]

    for cx, cy in candidates:
        if 0 <= cx < img.width and 0 <= cy < img.height:
            r, g, b = img.getpixel((cx, cy))
            # The icon area should be darker (overlay) or have icon pixels
            if r < 200 or g < 200 or b < 200:
                pyautogui.click(cx, cy)
                time.sleep(0.5)

                # Now click "原始" — first item in the dropdown, ~40px above
                pyautogui.click(cx, cy - 40)
                return True

    # Fallback: just click the known position
    pyautogui.click(655, 908)
    time.sleep(0.5)
    pyautogui.click(655, 868)
    return True


def click_next_button(x_min=600, x_max=1350):
    """Find and click the blue 下一步 text in dialog header."""
    pos = wait_for_element(
        lambda img: scan_for_blue_text(img, x_min, x_max, HEADER_Y_MIN, HEADER_Y_MAX, min_cluster=3),
        timeout_s=15,
        label="下一步",
    )
    if pos:
        pyautogui.click(pos[0], pos[1])
        return pos
    return None


def click_share_button():
    """Find and click the blue 分享 text in dialog header."""
    pos = wait_for_element(
        lambda img: scan_for_blue_text(img, 600, 1350, HEADER_Y_MIN, HEADER_Y_MAX, min_cluster=3),
        timeout_s=10,
        label="分享",
    )
    if pos:
        pyautogui.click(pos[0], pos[1])
        return pos
    return None


def run_posting_flow(video_path, caption):
    """Execute the full Instagram posting flow.
    Returns (success, error_msg, failed_step)."""

    # Step 0: Validate resolution
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    if w != 1920 or h != 1080:
        return (False, f"Expected 1920x1080, got {w}x{h}", "resolution")

    # Step 0b: Find & activate Chrome
    hwnd = find_chrome_hwnd()
    if not hwnd:
        return (False, "Chrome not found", "chrome")

    minimize_console()
    activate_chrome(hwnd)
    maximize_chrome(hwnd)

    # Step 1: Navigate to Instagram
    navigate_to_instagram()

    # Step 2: Click Create (+)
    create_pos = click_create()
    if not create_pos:
        return (False, "Create (+) button not found", "create")
    time.sleep(0.8)

    # Step 3: Click 貼文 in expanded menu
    post_pos = click_post_option()
    if not post_pos:
        # Try clicking slightly below Create position as fallback
        pyautogui.click(create_pos[0], create_pos[1] + 50)
    time.sleep(1.0)

    # Step 4: Click "從電腦選擇" (Select from computer) blue button
    select_pos = wait_for_element(
        lambda img: scan_for_blue_button(img, 500, 1400, 400, 800, min_cluster=30),
        timeout_s=10,
        label="從電腦選擇",
    )
    if not select_pos:
        return (False, "Select from computer button not found", "select-file")
    pyautogui.click(select_pos[0], select_pos[1])

    # Step 5: Handle file dialog
    handle_file_dialog(video_path)
    time.sleep(2.0)  # Wait for file to load/process

    # Step 6: Set original aspect ratio (optional, skip if it causes issues)
    # set_original_aspect_ratio()

    # Step 7: Click 下一步 (crop step)
    next1 = click_next_button()
    if not next1:
        return (False, "Next button (crop) not found", "next-crop")
    time.sleep(1.0)

    # Step 8: Click 下一步 (edit/filter step)
    next2 = click_next_button()
    if not next2:
        return (False, "Next button (edit) not found", "next-edit")
    time.sleep(1.0)

    # Step 9: Click caption area and paste caption
    pyautogui.click(CAPTION_X, CAPTION_Y)
    time.sleep(0.3)
    paste_text(caption)
    time.sleep(0.3)

    # Step 10: Click 分享 (Share)
    share_pos = click_share_button()
    if not share_pos:
        return (False, "Share button not found", "share")

    # Step 11: Wait for completion
    if wait_for_shared(timeout_s=30):
        return (True, "", "")
    else:
        return (False, "Share confirmation timeout (30s)", "wait-shared")


def main():
    parser = argparse.ArgumentParser(description="Fast Instagram posting flow")
    parser.add_argument("--video", required=True, help="Video/image filename")
    parser.add_argument("--caption", required=True, help="Post caption text")
    parser.add_argument("--videos-dir", default=os.path.join(os.path.expanduser("~"), "Videos"),
                        help="Directory containing the video file")
    args = parser.parse_args()

    # Build full path
    video_path = args.video
    if not os.path.isabs(video_path):
        video_path = os.path.join(args.videos_dir, video_path)

    if not os.path.exists(video_path):
        result_json(False, error=f"File not found: {video_path}", step="file-check")

    start_time = time.time()
    try:
        success, error, step = run_posting_flow(video_path, args.caption)
        duration = time.time() - start_time
        if success:
            result_json(True, duration_s=duration)
        else:
            result_json(False, duration_s=duration, error=error, step=step)
    except Exception as e:
        duration = time.time() - start_time
        result_json(False, duration_s=duration, error=str(e), step="unknown")


if __name__ == "__main__":
    main()
