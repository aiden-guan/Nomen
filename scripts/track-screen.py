#!/usr/bin/env python3
# Tracks a filmed display (a monitor or laptop screen that a phone films) through one stretch of a
# reference video and lays our product's screens into it, frame by frame. Used by the one-to-one
# remake (src/lib/creative/track.ts) when OpenCV is set up (`npm run setup:stems` installs it next to
# Demucs); without it the remake warps between the vision model's corner reads instead.
#
#   the vision model's corners, one or two per shot (stage pixels)
#     └─ each anchor snapped onto the display's own edges (the bright picture against the dark bezel)
#          └─ optical flow on the display and its bezel, a homography per frame (RANSAC), forward
#             and backward from the anchor through its shot; the corners follow, lightly smoothed
#               └─ our screens warped onto the corners, matched to how the phone saw the display
#                  (black level, white point, tint, softness), laid over the reference's own footage
#
# Usage: python track-screen.py spec.json   (the spec is written by track.ts; a JSON report on stdout)

import json
import subprocess
import sys

import cv2
import numpy as np

FPS = 30
TRACK_SCALE = 0.5


def read_frames(ffmpeg, args, width, height, count, grey=False):
    """Frames from ffmpeg as numpy arrays (BGR or grey), at most `count`."""
    fmt = "gray" if grey else "bgr24"
    proc = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", *args, "-f", "rawvideo", "-pix_fmt", fmt, "pipe:1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    size = width * height * (1 if grey else 3)
    while count > 0:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        count -= 1
        frame = np.frombuffer(buf, np.uint8)
        yield frame.reshape(height, width) if grey else frame.reshape(height, width, 3)
    proc.stdout.close()
    proc.wait()


def segment_args(spec, width, height):
    c = spec["crop"]
    return [
        "-ss", str(spec["start"]), "-t", str(spec["seconds"] + 0.5), "-i", spec["reference"],
        "-vf", f"crop={c['width']}:{c['height']}:{c['x']}:{c['y']},scale={width}:{height}:flags=lanczos,setsar=1,fps={FPS}",
        "-an",
    ]


def quad_mask(shape, quad, grow):
    """A mask of the quad grown by `grow` (a share of its size) around its centre."""
    centre = quad.mean(axis=0)
    grown = centre + (quad - centre) * (1 + grow)
    mask = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(mask, np.round(grown).astype(np.int32), 255)
    return mask


def snap_edges(grey, quad):
    """
    The anchor's sides moved onto the display's own edges: along each side that lies in the frame,
    the strongest dark-to-bright step going inward, fitted as a line. A side without a clear,
    straight edge keeps the vision model's line. Returns the refined quad and how many sides moved.
    """
    h, w = grey.shape
    smooth = cv2.GaussianBlur(grey, (5, 5), 0).astype(np.float32)
    reach = max(6.0, 0.03 * w)
    centre = quad.mean(axis=0)
    lines = []
    moved = 0
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        side = b - a
        length = float(np.hypot(*side))
        if length < 20:
            lines.append(None)
            continue
        direction = side / length
        normal = np.array([-direction[1], direction[0]])
        if np.dot(centre - (a + b) / 2, normal) < 0:
            normal = -normal  # inward
        points = []
        strengths = []
        for s in np.linspace(0.12, 0.88, 36):
            p = a + side * s
            if not (2 <= p[0] < w - 2 and 2 <= p[1] < h - 2):
                continue
            offsets = np.arange(-reach, reach + 1, 1.0)
            xs = p[0] + normal[0] * offsets
            ys = p[1] + normal[1] * offsets
            inside = (xs >= 0) & (xs < w - 1) & (ys >= 0) & (ys < h - 1)
            if inside.sum() < len(offsets) * 0.8:
                continue
            profile = cv2.remap(smooth, xs.astype(np.float32).reshape(1, -1), ys.astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).ravel()
            step = np.convolve(np.diff(profile), np.ones(3) / 3, mode="same")
            k = int(np.argmax(step))
            strengths.append(step[k])
            points.append(p + normal * (offsets[k] + 0.5))
        if len(points) < 10:
            lines.append(None)
            continue
        pts = np.array(points, np.float32)
        strong = np.array(strengths) > max(6.0, np.median(strengths) * 0.5)
        if strong.sum() < max(8, len(points) * 0.55):
            lines.append(None)
            continue
        pts = pts[strong]
        vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        residual = np.abs((pts[:, 0] - x0) * vy - (pts[:, 1] - y0) * vx)
        if np.median(residual) > 2.5:
            lines.append(None)
            continue
        # Only a refinement: a line far from the vision model's side is another edge (a window, a bar).
        mid = (a + b) / 2
        if abs((mid[0] - x0) * vy - (mid[1] - y0) * vx) > reach * 0.8:
            lines.append(None)
            continue
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
        moved += 1
    if moved == 0:
        return quad, 0
    out = quad.copy()
    for i in range(4):
        before, after = lines[(i - 1) % 4], lines[i]
        # Corner i sits between side i-1 (ending at it) and side i (starting at it).
        la = before if before is not None else (quad[(i - 1) % 4], (quad[i] - quad[(i - 1) % 4]) / max(1e-6, np.hypot(*(quad[i] - quad[(i - 1) % 4]))))
        lb = after if after is not None else (quad[i], (quad[(i + 1) % 4] - quad[i]) / max(1e-6, np.hypot(*(quad[(i + 1) % 4] - quad[i]))))
        (p, r), (q, s) = la, lb
        denom = r[0] * s[1] - r[1] * s[0]
        if abs(denom) < 1e-6:
            continue
        t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom
        corner = p + r * t
        if np.hypot(*(corner - quad[i])) < reach * 1.5:
            out[i] = corner
    return out, moved


def feature_grow(shape, quad):
    """
    How far past the display features are taken: a monitor filling the frame has texture enough on
    and around its screen; a small device's display (a desk phone's) needs the device body around it
    (keys, logo, bezel), which moves with it.
    """
    a, b = quad[2] - quad[0], quad[3] - quad[1]
    area = abs(float(a[0] * b[1] - a[1] * b[0])) / 2
    share = area / float(shape[0] * shape[1])
    return 0.12 if share >= 0.08 else 0.7


def flow_step(prev, cur, points, threshold):
    """One optical-flow step with the forward-backward check: the points that held, and where they went."""
    moved, status, _ = cv2.calcOpticalFlowPyrLK(prev, cur, points, None, winSize=(21, 21), maxLevel=3)
    back, status_back, _ = cv2.calcOpticalFlowPyrLK(cur, prev, moved, None, winSize=(21, 21), maxLevel=3)
    good = (status.ravel() == 1) & (status_back.ravel() == 1) & (np.linalg.norm(points - back, axis=2).ravel() < threshold)
    return moved, good


def track_run(frames, anchor_index, anchor_quad, indices, exclude=None):
    """
    The quad through `indices` (in order, starting next to the anchor), by optical flow on the
    display and its bezel (a small device's body too) and a homography per step. `exclude(i)` gives
    frame i's mask of places with no features to take (the reference's burned-in captions, which
    stay put while the display moves). A step where too few points hold (motion blur, the display
    lighting up) is tried again from fresh points with a looser check before giving up. Returns
    {index: quad} and the inlier shares.
    """
    out = {}
    shares = []
    prev = frames[anchor_index]
    to_anchor = np.eye(3)
    grow = feature_grow(prev.shape, anchor_quad)
    feature_mask = lambda i, quad: quad_mask(frames[i].shape, quad, grow) & ~exclude(i) if exclude else quad_mask(frames[i].shape, quad, grow)
    detect = lambda image, i, quad: cv2.goodFeaturesToTrack(image, maxCorners=600, qualityLevel=0.005, minDistance=6, mask=feature_mask(i, quad))
    points = detect(prev, anchor_index, anchor_quad)
    last_quad = anchor_quad
    last_index = anchor_index
    for i in indices:
        cur = frames[i]
        if points is None or len(points) < 12:
            points = detect(prev, last_index, last_quad)
            if points is None or len(points) < 12:
                return out, shares, f"lost the display at frame {i}"
        moved, good = flow_step(prev, cur, points, 1.0)
        if good.sum() < 10:
            fresh = detect(prev, last_index, last_quad)
            if fresh is not None and len(fresh) >= 12:
                points = fresh
                moved, good = flow_step(prev, cur, points, 2.0)
        if good.sum() < 10:
            return out, shares, f"too few points held at frame {i}"
        step, inliers = cv2.findHomography(points[good], moved[good], cv2.RANSAC, 1.5)
        if step is None:
            return out, shares, f"no homography at frame {i}"
        shares.append(float(inliers.sum()) / max(1, good.sum()))
        to_anchor = step @ to_anchor
        quad = cv2.perspectiveTransform(anchor_quad.reshape(-1, 1, 2).astype(np.float64), to_anchor).reshape(4, 2)
        out[i] = quad
        last_quad = quad
        keep = good.copy()
        keep[good] = inliers.ravel() == 1
        points = moved[keep].reshape(-1, 1, 2)
        if len(points) < 120:
            fresh = detect(cur, i, quad)
            if fresh is not None:
                points = np.concatenate([points, fresh]).astype(np.float32) if len(points) else fresh
        prev = cur
        last_index = i
    return out, shares, None


def erase_boxes(spec, i, scale=(1.0, 1.0)):
    """The places where the reference has burned-in captions or labels at frame i (stage pixels, scaled)."""
    t = spec["start"] + i / FPS
    out = []
    for e in spec.get("erase", []):
        if e["start"] - 0.05 <= t < e["end"] + 0.05:
            out.append((int(e["x"] * scale[0]), int(e["y"] * scale[1]), max(1, int(e["width"] * scale[0])), max(1, int(e["height"] * scale[1])), e.get("background")))
    return out


def exclusion(spec, shape, scale):
    """exclude(i) for track_run: a mask of frame i's caption boxes at the tracking scale."""
    def exclude(i):
        mask = np.zeros(shape, np.uint8)
        for x, y, w, h, _ in erase_boxes(spec, i, scale):
            mask[max(0, y):y + h, max(0, x):x + w] = 255
        return mask
    return exclude


def text_mask(roi):
    """
    The letters of a burned-in caption in a box: white, yellow or red fills that touch a dark
    outline (a caption's heavy stroke), plus the outline, plus a saturated red highlight box. A
    large bright area with no outline nearby (a lit display, a lamp) is left alone.
    """
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    hh, ss, vv = cv2.split(hsv)
    white = (vv > 185) & (ss < 80)
    yellow = (hh > 18) & (hh < 38) & (ss > 110) & (vv > 150)
    red = ((hh < 10) | (hh > 160)) & (ss > 110) & (vv > 100)
    dark = (vv < 70).astype(np.uint8)
    ellipse = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    near_dark = cv2.dilate(dark, ellipse(4)) > 0
    # Letters are thin strokes: a bright area much thicker than a stroke (a lit display) is no letter.
    fill = (white | yellow).astype(np.uint8)
    count, labels = cv2.connectedComponents(fill, connectivity=8)
    depth = cv2.distanceTransform(fill, cv2.DIST_L2, 3)
    deepest = np.zeros(count, np.float32)
    np.maximum.at(deepest, labels.ravel(), depth.ravel())
    thin = (deepest[labels] <= max(4.0, 0.07 * roi.shape[0])) & (fill > 0)
    seeds = thin & near_dark
    letters = thin & (cv2.dilate(seeds.astype(np.uint8), ellipse(6)) > 0)
    mask = (letters | red).astype(np.uint8) * 255
    return cv2.dilate(mask, ellipse(3))


def box_mask(roi, background):
    """Text on a solid box (black letters on white boxes): the box's colour, its letters closed in, a little grown."""
    bg = np.array([int(background[5:7], 16), int(background[3:5], 16), int(background[1:3], 16)], np.int32)
    near = (np.abs(roi.astype(np.int32) - bg).sum(axis=2) < 110).astype(np.uint8) * 255
    k = max(9, (roi.shape[0] // 12) | 1)
    closed = cv2.morphologyEx(near, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    # Only areas that are mostly the box colour count (not a stray bright pixel in the scene).
    count, labels, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    keep = np.zeros_like(closed)
    for i in range(1, count):
        if stats[i, cv2.CC_STAT_AREA] >= 0.002 * roi.shape[0] * roi.shape[1] and stats[i, cv2.CC_STAT_HEIGHT] >= 6:
            keep[labels == i] = 255
    return cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))


def erase_text(frame, boxes):
    """The frame with the burned-in captions in `boxes` painted out from their surroundings."""
    if not boxes:
        return frame
    out = frame.copy()
    H, W = out.shape[:2]
    for x, y, w, h, background in boxes:
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        roi = out[y0:y1, x0:x1]
        mask = box_mask(roi, background) if background else text_mask(roi)
        if mask.any():
            out[y0:y1, x0:x1] = cv2.inpaint(roi, mask, 5, cv2.INPAINT_TELEA)
    return out


def track_span(frames, f, quad, lo, hi, exclude):
    """
    The quad from the anchor at frame f through [lo, hi), forward and backward. The flow lost in
    the stretch's last few frames (a cut a frame off, a blurred frame) holds the corners found
    rather than failing it. Returns {frame: quad}, the inlier shares, a problem or None, what was held.
    """
    slack = max(4, int(0.12 * (hi - lo)))
    forward, fshares, fwhy = track_run(frames, f, quad, range(f + 1, hi), exclude)
    backward, bshares, bwhy = track_run(frames, f, quad, range(f - 1, lo - 1, -1), exclude)
    held = []
    if fwhy and hi - 1 - (max(forward) if forward else f) <= slack:
        held.append(fwhy)
        fwhy = None
    if bwhy and (min(backward) if backward else f) - lo <= slack:
        held.append(bwhy)
        bwhy = None
    return {f: quad, **forward, **backward}, fshares + bshares, fwhy or bwhy, held


def smooth(quads, radius=2):
    """
    A centred moving average of each corner over up to 2*radius+1 frames. Near a shot's ends the
    window shrinks on both sides, so the average never lags behind fast motion.
    """
    if len(quads) <= 2:
        return quads
    arr = np.array(quads)
    out = np.empty_like(arr)
    for i in range(len(arr)):
        r = min(radius, i, len(arr) - 1 - i)
        out[i] = arr[i - r:i + r + 1].mean(axis=0)
    return list(out)


def interpolate(keys, count):
    """Corners between the vision model's reads, linearly (the fallback for a shot that cannot be tracked)."""
    keys = sorted(keys, key=lambda k: k[0])
    out = []
    for i in range(count):
        if i <= keys[0][0]:
            out.append(keys[0][1])
        elif i >= keys[-1][0]:
            out.append(keys[-1][1])
        else:
            for (fa, qa), (fb, qb) in zip(keys, keys[1:]):
                if fa <= i <= fb:
                    p = (i - fa) / max(1, fb - fa)
                    out.append(qa + (qb - qa) * p)
                    break
    return out


def track(spec):
    W, H = spec["size"]["width"], spec["size"]["height"]
    n = int(round(spec["seconds"] * FPS))
    tw, th = int(round(W * TRACK_SCALE / 2) * 2), int(round(H * TRACK_SCALE / 2) * 2)
    scale = np.array([tw / W, th / H])
    frames = list(read_frames(spec["ffmpeg"], segment_args(spec, tw, th), tw, th, n, grey=True))
    n = len(frames)
    if n == 0:
        raise SystemExit("no frames could be read from the reference")
    cut_frames = sorted({int(round((c - spec["start"]) * FPS)) for c in spec.get("cuts", []) if 0 < (c - spec["start"]) * FPS < n})
    bounds = [0, *cut_frames, n]
    anchors = []
    for a in spec["anchors"]:
        f = int(round((a["t"] - spec["start"]) * FPS))
        if 0 <= f < n:
            anchors.append((f, np.array(a["quad"], np.float64) * scale))
    quads = [None] * n
    shots = []
    for s0, s1 in zip(bounds, bounds[1:]):
        if s1 <= s0:
            continue
        mine = [a for a in anchors if s0 <= a[0] < s1]
        report = {"from": s0, "to": s1, "anchors": len(mine)}
        if not mine:
            # A shot the vision model never saw: the nearest earlier shot's last corners hold.
            report["fallback"] = "no corners read in this shot"
            shots.append(report)
            continue
        # The anchor: the read nearest the shot's middle (the start of a shot is often blurred by the cut).
        middle = (s0 + s1) / 2
        mine.sort(key=lambda a: a[0])
        f0, q0 = min(mine, key=lambda a: abs(a[0] - middle))
        snap = (lambda f, q: snap_edges(frames[f], q)) if spec.get("snap", True) else (lambda f, q: (q, 0))
        snapped, moved = snap(f0, q0)
        report["anchor"] = f0
        report["sides_snapped"] = moved
        exclude = exclusion(spec, frames[0].shape, scale) if spec.get("erase") else None
        tracked, shares, problem, held = track_span(frames, f0, snapped, s0, s1, exclude)
        report["inliers"] = round(float(np.mean(shares)), 3) if shares else None
        if held:
            report["held"] = held
        if problem or (shares and np.mean(shares) < 0.5):
            report["fallback"] = problem or "the flow did not agree on one plane"
            series = interpolate(mine, s1 - s0) if len(mine) > 1 else [q0] * (s1 - s0)
            for k, q in enumerate(series):
                quads[s0 + k] = q
        else:
            # The other reads that agree with the flow re-anchor their own stretch of a long shot,
            # so drift cannot build up; a read far from the flow is a misread and is left out.
            width = frames[0].shape[1]
            good = [(f0, snapped)]
            for f, q in mine:
                if f == f0 or f not in tracked:
                    continue
                sq, _ = snap(f, q)
                if np.abs(tracked[f] - sq).max() < 0.04 * width:
                    good.append((f, sq))
            good.sort(key=lambda a: a[0])
            report["anchors_used"] = len(good)
            if len(good) > 1:
                final = {}
                for k, (f, q) in enumerate(good):
                    lo = s0 if k == 0 else (good[k - 1][0] + f) // 2
                    hi = s1 if k == len(good) - 1 else (f + good[k + 1][0]) // 2
                    part = None
                    if f != f0:
                        part, _, why, _ = track_span(frames, f, q, lo, hi, exclude)
                        if why:
                            part = None
                    final.update(part if part is not None else {i: tracked[i] for i in range(lo, hi) if i in tracked})
                tracked = final or tracked
            first, last = min(tracked), max(tracked)
            series = smooth([tracked[min(max(i, first), last)] if i in tracked or i < first or i > last else tracked[max(j for j in tracked if j < i)] for i in range(s0, s1)], radius=3)
            for k, q in enumerate(series):
                quads[s0 + k] = q
            # How far the tracked corners sit from the vision model's other reads (diagnostic only).
            report["residual_px"] = [round(float(np.abs(quads[f] - q).max() / TRACK_SCALE), 1) for f, q in mine if f != f0]
        shots.append(report)
    # Shots with no read hold the nearest corners found.
    known = [i for i, q in enumerate(quads) if q is not None]
    if not known:
        raise SystemExit("no shot could be tracked")
    for i in range(n):
        if quads[i] is None:
            j = min(known, key=lambda k: (abs(k - i), k > i))
            quads[i] = quads[j]
    return [q / scale for q in quads], shots, n


def screen_look(frame, quad):
    """How the phone saw the display: the black level and white point per channel inside it."""
    mask = quad_mask(frame.shape[:2], quad, -0.06)
    pixels = frame[mask > 0]
    if len(pixels) < 500:
        return None
    lo = np.percentile(pixels, 1.5, axis=0)
    hi = np.percentile(pixels, 99.5, axis=0)
    return lo, hi


def composite(spec, quads, n):
    W, H = spec["size"]["width"], spec["size"]["height"]
    sw, sh = spec["screen_size"]["width"], spec["screen_size"]["height"]
    src = np.array([[0, 0], [sw, 0], [sw, sh], [0, sh]], np.float64)
    base = read_frames(spec["ffmpeg"], segment_args(spec, W, H), W, H, n)
    screens = read_frames(spec["ffmpeg"], ["-i", spec["screen"], "-vf", f"scale={sw}:{sh},setsar=1,fps={FPS},tpad=stop_mode=clone:stop_duration={spec['seconds'] + 1}", "-an"], sw, sh, n)
    writer = subprocess.Popen(
        [spec["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "pipe:0",
         "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", spec["out"]],
        stdin=subprocess.PIPE,
    )
    match = float(spec.get("match", 0.7))
    grow = float(spec.get("grow", 0.006))
    look = None
    look_shot = -1
    cut_frames = sorted({int(round((c - spec["start"]) * FPS)) for c in spec.get("cuts", [])})
    last_screen = None
    written = 0
    for i, frame in enumerate(base):
        if i >= n:
            break
        screen = next(screens, None)
        if screen is None:
            screen = last_screen
        last_screen = screen
        quad = quads[i]
        frame = erase_text(frame, erase_boxes(spec, i))
        shot = sum(1 for c in cut_frames if c <= i)
        if shot != look_shot:
            look = screen_look(frame, quad)
            look_shot = shot
        centre = quad.mean(axis=0)
        target = centre + (quad - centre) * (1 + grow)
        # Shrink our screen close to the size it lands at first, so the warp does not alias.
        span = max(np.hypot(*(target[1] - target[0])), np.hypot(*(target[2] - target[3])))
        factor = min(1.0, span * 1.15 / sw)
        if factor < 0.95:
            small = cv2.resize(screen, (max(2, int(sw * factor)), max(2, int(sh * factor))), interpolation=cv2.INTER_AREA)
            m = cv2.getPerspectiveTransform((src * factor).astype(np.float32), target.astype(np.float32))
        else:
            small = screen
            m = cv2.getPerspectiveTransform(src.astype(np.float32), target.astype(np.float32))
        img = small.astype(np.float32)
        if look is not None and match > 0:
            lo, hi = look
            mapped = lo + (hi - lo) * (img / 255.0)
            img = img * (1 - match) + mapped * match
        warped = cv2.warpPerspective(img, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        alpha = cv2.warpPerspective(np.full(small.shape[:2], 255, np.uint8), m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        warped = cv2.GaussianBlur(warped, (0, 0), 0.7)
        a = (cv2.GaussianBlur(alpha, (0, 0), 0.8).astype(np.float32) / 255.0)[..., None]
        out = frame.astype(np.float32) * (1 - a) + warped * a
        writer.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
        written += 1
    while written < n and last_screen is not None:
        # The reference ran short: hold the last frame (the edit trims to length anyway).
        writer.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
        written += 1
    writer.stdin.close()
    writer.wait()
    if writer.returncode != 0:
        raise SystemExit("ffmpeg could not write the tracked clip")
    return written


def main():
    spec = json.load(open(sys.argv[1]))
    quads, shots, n = track(spec)
    if spec.get("quads_out"):
        with open(spec["quads_out"], "w") as f:
            json.dump([[[round(float(v), 2) for v in p] for p in q] for q in quads], f)
    frames = composite(spec, quads, n)
    print(json.dumps({"ok": True, "frames": frames, "shots": shots}))


if __name__ == "__main__":
    main()
