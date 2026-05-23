#!/usr/bin/env python3
"""
Template matching for Instagram automation.
Usage: py ig-find.py <template_path> [threshold]
Output: x,y,confidence  OR  NOT_FOUND
"""

import sys
import cv2
import numpy as np
import mss


def find_template(template_path: str, threshold: float = 0.7) -> str:
    """Find template on screen, return 'x,y,confidence' or 'NOT_FOUND'."""
    template = cv2.imread(template_path, cv2.IMREAD_COLOR)
    if template is None:
        return f"ERROR:Cannot read template: {template_path}"

    with mss.mss() as sct:
        monitor = sct.monitors[0]  # full virtual screen
        screen = np.array(sct.grab(monitor))
        screen = cv2.cvtColor(screen, cv2.COLOR_BGRA2BGR)
        ox, oy = monitor["left"], monitor["top"]

    result = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)

    if max_val >= threshold:
        th, tw = template.shape[:2]
        cx = max_loc[0] + tw // 2 + ox
        cy = max_loc[1] + th // 2 + oy
        return f"{cx},{cy},{max_val:.3f}"

    return "NOT_FOUND"


def capture_screen(output_path: str) -> str:
    """Capture full screen and save to output_path."""
    with mss.mss() as sct:
        monitor = sct.monitors[0]
        screen = sct.grab(monitor)
        img = np.array(screen)
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        cv2.imwrite(output_path, img)
        return f"OK:{monitor['width']},{monitor['height']}"


def crop_screen(cx: int, cy: int, output_path: str, pad: int = 40) -> str:
    """Capture screen and crop a region around (cx, cy), save as template."""
    with mss.mss() as sct:
        monitor = sct.monitors[0]
        screen = np.array(sct.grab(monitor))
        screen = cv2.cvtColor(screen, cv2.COLOR_BGRA2BGR)
        ox, oy = monitor["left"], monitor["top"]

    # Convert absolute screen coords to image coords
    ix = cx - ox
    iy = cy - oy
    h, w = screen.shape[:2]
    x1 = max(0, ix - pad)
    y1 = max(0, iy - pad)
    x2 = min(w, ix + pad)
    y2 = min(h, iy + pad)
    crop = screen[y1:y2, x1:x2]
    cv2.imwrite(output_path, crop)
    return f"OK:{x2-x1},{y2-y1}"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: ig-find.py <template_path> [threshold]")
        print("       ig-find.py --capture <output_path>")
        print("       ig-find.py --crop <cx> <cy> <output_path> [pad]")
        sys.exit(1)

    if sys.argv[1] == "--capture":
        if len(sys.argv) < 3:
            print("ERROR:Missing output path")
            sys.exit(1)
        print(capture_screen(sys.argv[2]))
    elif sys.argv[1] == "--crop":
        if len(sys.argv) < 5:
            print("ERROR:Usage: --crop <cx> <cy> <output_path> [pad]")
            sys.exit(1)
        cx, cy = int(sys.argv[2]), int(sys.argv[3])
        out = sys.argv[4]
        pad = int(sys.argv[5]) if len(sys.argv) > 5 else 40
        print(crop_screen(cx, cy, out, pad))
    else:
        tmpl_path = sys.argv[1]
        thresh = float(sys.argv[2]) if len(sys.argv) > 2 else 0.7
        print(find_template(tmpl_path, thresh))
