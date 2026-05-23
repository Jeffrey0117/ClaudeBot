"""
Instagram automation helper - run with: start /min py scripts/ig-auto.py <action>
Actions:
  capture  - Capture screen + find sidebar icons
  click_create - Click Create button
  click_post - Click 貼文 in expanded sidebar
  post_flow - Full posting flow
"""

import sys
import ctypes
from ctypes import wintypes
import time
import json
import os

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'ig-templates')
RESULT_FILE = os.path.join(DATA_DIR, 'ig-auto-result.json')

def minimize_console():
    hwnd = kernel32.GetConsoleWindow()
    if hwnd:
        user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE

def focus_chrome():
    """Find and focus the Instagram Chrome window."""
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    chrome_windows = []

    def enum_cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if 'Instagram' in title and 'Chrome' in title:
                    rect = wintypes.RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rect))
                    chrome_windows.append((hwnd, title, rect.top))
        return True

    user32.EnumWindows(EnumWindowsProc(enum_cb), 0)

    if not chrome_windows:
        # Try any Chrome window on primary monitor
        def enum_cb2(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    if 'Chrome' in buf.value:
                        rect = wintypes.RECT()
                        user32.GetWindowRect(hwnd, ctypes.byref(rect))
                        if rect.top < 100:  # Primary monitor
                            chrome_windows.append((hwnd, buf.value, rect.top))
            return True
        user32.EnumWindows(EnumWindowsProc(enum_cb2), 0)

    if chrome_windows:
        hwnd = chrome_windows[0][0]
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        return hwnd
    return None

def write_result(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(RESULT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def capture_and_analyze():
    """Capture screen and find sidebar icon positions."""
    import mss
    from PIL import Image

    minimize_console()
    time.sleep(0.3)

    chrome_hwnd = focus_chrome()
    time.sleep(1)

    sct = mss.mss()
    region = {'left': 0, 'top': 0, 'width': 1920, 'height': 1080}
    img = sct.grab(region)
    pil = Image.frombytes('RGB', (img.width, img.height), img.rgb)
    pil.save(os.path.join(DATA_DIR, 'ig-analysis.png'))

    # Scan for sidebar: find a vertical column that's mostly white (sidebar bg)
    # The sidebar should have white background with dark icons
    sidebar_x = None
    for x in range(0, 400):
        white_count = 0
        total = 0
        for y in range(100, 500, 3):
            r, g, b = pil.getpixel((x, y))
            total += 1
            if r > 240 and g > 240 and b > 240:
                white_count += 1
        if white_count > total * 0.5:
            sidebar_x = x
            break

    if sidebar_x is None:
        write_result({'error': 'Could not find sidebar white background', 'chrome_hwnd': chrome_hwnd})
        return

    # Find the icon center x by scanning for the column with most dark pixels within the sidebar
    max_dark = 0
    icon_x = sidebar_x + 20
    for x in range(sidebar_x, min(sidebar_x + 50, 400)):
        dark_count = 0
        for y in range(100, 500, 2):
            r, g, b = pil.getpixel((x, y))
            if r < 100 and g < 100 and b < 100:
                dark_count += 1
        if dark_count > max_dark:
            max_dark = dark_count
            icon_x = x

    # Find individual icon regions along this x column
    icon_rows = []
    for y in range(100, 510):
        # Check a few pixels around icon_x
        has_dark = False
        for dx in range(-8, 9, 2):
            r, g, b = pil.getpixel((icon_x + dx, y))
            if r < 100 and g < 100 and b < 100:
                has_dark = True
                break
        if has_dark:
            icon_rows.append(y)

    # Group into regions
    regions = []
    if icon_rows:
        start = icon_rows[0]
        prev = icon_rows[0]
        for y in icon_rows[1:]:
            if y - prev > 8:
                regions.append({'start': start, 'end': prev, 'center_y': (start + prev) // 2})
                start = y
            prev = y
        regions.append({'start': start, 'end': prev, 'center_y': (start + prev) // 2})

    result = {
        'sidebar_x': sidebar_x,
        'icon_x': icon_x,
        'icon_regions': regions,
        'chrome_hwnd': chrome_hwnd,
        'total_icons': len(regions),
    }

    # The Create (+) button is typically the 7th icon (after logo, home, search, explore, reels, messages, heart)
    # Or we can identify it by looking for the "+" shape
    if len(regions) >= 7:
        result['create_icon'] = regions[6]  # 7th region (0-indexed: 6)
        result['create_y'] = regions[6]['center_y']

    write_result(result)
    print(json.dumps(result, indent=2))

def do_click_create():
    """Click the Create button and capture the expanded sidebar."""
    import pyautogui
    import mss
    from PIL import Image

    minimize_console()
    time.sleep(0.3)

    # Read previous analysis
    with open(RESULT_FILE, 'r') as f:
        data = json.load(f)

    icon_x = data.get('icon_x', 315)
    create_y = data.get('create_y', 332)

    focus_chrome()
    time.sleep(0.5)

    # Click Create
    pyautogui.click(icon_x, create_y)
    time.sleep(1)

    # Capture the expanded sidebar
    sct = mss.mss()
    region = {'left': 0, 'top': 0, 'width': 400, 'height': 500}
    img = sct.grab(region)
    pil = Image.frombytes('RGB', (img.width, img.height), img.rgb)
    pil.save(os.path.join(DATA_DIR, 'ig-expanded.png'))

    write_result({**data, 'status': 'expanded_sidebar_captured'})
    print('Expanded sidebar captured')

def do_full_create_click():
    """Click Create then immediately click 貼文 in one rapid sequence."""
    import pyautogui
    import mss
    from PIL import Image

    minimize_console()
    time.sleep(0.3)

    with open(RESULT_FILE, 'r') as f:
        data = json.load(f)

    icon_x = data.get('icon_x', 315)
    create_y = data.get('create_y', 332)

    focus_chrome()
    time.sleep(0.5)

    # Step 1: Move mouse to Create icon area
    pyautogui.moveTo(icon_x, create_y)
    time.sleep(0.2)

    # Step 2: Click Create
    pyautogui.click()

    # Step 3: The sidebar expands - items appear ABOVE the Create button
    # In expanded mode, the sidebar gets wider and shows text labels
    # The menu items (貼文, 直播, 廣告) appear around the Create button area
    # Move SLIGHTLY UP to where 貼文 should be (about 25-30px below 建立)
    # Based on previous session: expanded sidebar items are at lower x (around 40-100)
    # and 貼文 is about 26px below 建立
    time.sleep(0.5)

    # Capture to see what expanded looks like
    sct = mss.mss()
    region = {'left': 0, 'top': 0, 'width': 500, 'height': 500}
    img = sct.grab(region)
    pil = Image.frombytes('RGB', (img.width, img.height), img.rgb)
    pil.save(os.path.join(DATA_DIR, 'ig-after-create-click.png'))
    print('Captured after Create click')

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'capture'

    if action == 'capture':
        capture_and_analyze()
    elif action == 'click_create':
        do_click_create()
    elif action == 'full_create':
        do_full_create_click()
    else:
        print(f'Unknown action: {action}')
