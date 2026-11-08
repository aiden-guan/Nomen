#!/usr/bin/env python3
"""
synth.py - procedural sound design + score renderer (numpy/scipy only, fully deterministic)

Vendored into Nomen from ED Studio (audio/synth.py at 6122035, Dylan's project) for code ads. Nomen's only change: --out.
    python3 -I src/lib/codeads/synth.py --cues <dir>/cues.json --out <dir> --no-pack   (src/lib/codeads/job.ts runs this)

    python3 -I audio/synth.py                 # render everything + self-verify
    python3 -I audio/synth.py --no-pack       # skip writing the reusable SFX pack
    python3 -I audio/synth.py --no-verify     # skip measurements
    python3 -I audio/synth.py --cues my.json  # render another video from a JSON cue sheet
    python3 -I audio/synth.py --dump-cues     # print the built-in cue sheet as JSON and exit

Layout of this file
    1. bootstrap / paths / utilities (noise, filters, envelopes, panning, wav io)
    2. DSP building blocks (modal impacts, friction creaks, swept filters, reverb IRs)
    3. SFX library            - one function per sound, all parameterised, peak-normalised
    4. Ambience library       - beds/loops rendered to an arbitrary length
    5. Music                  - additive piano, string pad, chord-symbol composer
    6. Cue sheet (DEFAULT_CUES) - the only part that is specific to this video
    7. Mixer / master (BS.1770 loudness, true-peak limiter) / SFX-pack export / verification
"""
import os
import sys
import json
import math
import re
import struct
import argparse
import subprocess
import time

try:  # `python3 -I` drops the user site-packages, which is where numpy/scipy live here
    import numpy as np
except ImportError:  # pragma: no cover
    import site
    sys.path.append(site.getusersitepackages())
    import numpy as np
from scipy import signal, ndimage

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "out")
STEM_DIR = os.path.join(OUT_DIR, "stems")
PACK_DIR = os.path.join(HERE, "sfx")
import platform as _pf
_ffdir = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}.get(_pf.system(), "linux") + "-" + ("arm64" if _pf.machine().lower() in ("arm64", "aarch64") else "x64")
FFMPEG = os.environ.get("FFMPEG_PATH") or next((p for p in (os.path.join(ROOT, "node_modules", "@ffmpeg-installer", _ffdir, n) for n in ("ffmpeg", "ffmpeg.exe")) if os.path.exists(p)), "ffmpeg")

# =============================================================================
# 1. utilities
# =============================================================================


def seeded(*keys):
    """Deterministic RNG from any keys (FNV-1a over repr; independent of PYTHONHASHSEED)."""
    h = 0xCBF29CE484222325
    for b in repr(keys).encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return np.random.default_rng(h)


def nsamp(sec):
    return int(round(sec * SR))


def tvec(n):
    return np.arange(n) / SR


def db2lin(db):
    return 10.0 ** (db / 20.0)


def lin2db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-12))


def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-30))


def norm(x, peak=1.0):
    m = float(np.max(np.abs(x))) if np.size(x) else 0.0
    return x * (peak / m) if m > 0 else x


def unit_rms(x):
    return x / rms(x)


_SOS = {}


def _sos(kind, f, order):
    f = np.atleast_1d(np.asarray(f, float))
    f = np.clip(f, 5.0, SR * 0.49)
    key = (kind, tuple(np.round(f, 3)), order)
    if key not in _SOS:
        _SOS[key] = signal.butter(order, f if len(f) > 1 else f[0], btype=kind, fs=SR, output="sos")
    return _SOS[key]


def lp(x, f, order=2):
    return signal.sosfilt(_sos("lowpass", f, order), x, axis=-1)


def hp(x, f, order=2):
    return signal.sosfilt(_sos("highpass", f, order), x, axis=-1)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bandpass", [lo, hi], order), x, axis=-1)


def white(n, rng):
    return rng.standard_normal(n)


def colored(n, rng, slope_db_oct, fmin=20.0):
    """Gaussian noise with a spectral slope (dB/oct): pink = -3, brown = -6. Unit std."""
    m = max(int(n), 64)
    X = np.fft.rfft(rng.standard_normal(m))
    f = np.maximum(np.fft.rfftfreq(m, 1.0 / SR), fmin)
    X *= (f / 1000.0) ** (slope_db_oct / 6.0206)
    X[0] = 0.0
    x = np.fft.irfft(X, m)[:n]
    return x / (np.std(x) + 1e-12)


def pink(n, rng):
    return colored(n, rng, -3.0)


def brown(n, rng):
    return colored(n, rng, -6.0)


def smooth_rand(n, rate, rng, lo=-1.0, hi=1.0):
    """Smooth random curve (cosine-interpolated random points at `rate` Hz)."""
    k = int(n / SR * rate) + 3
    pts = rng.uniform(lo, hi, k)
    x = np.arange(n) / SR * rate
    i = np.floor(x).astype(int)
    fr = x - i
    w = (1.0 - np.cos(np.pi * fr)) * 0.5
    return pts[i] * (1.0 - w) + pts[i + 1] * w


def fades(x, fin=0.002, fout=0.006):
    """Raised-cosine fade in/out (first and last sample are exactly 0)."""
    x = np.array(x, dtype=float, copy=True)
    n = x.shape[-1]
    a = min(nsamp(fin), n // 2)
    b = min(nsamp(fout), n // 2)
    if a > 0:
        x[..., :a] *= (1.0 - np.cos(np.pi * np.arange(a) / a)) * 0.5
    if b > 0:
        x[..., n - b:] *= (1.0 + np.cos(np.pi * (np.arange(b) + 1) / b)) * 0.5
    return x


def pan2(x, p=0.0):
    """Constant-power pan of a mono signal -> (2, n). p in [-1, 1]."""
    th = (np.clip(p, -1, 1) + 1.0) * np.pi / 4.0
    return np.vstack([x * np.cos(th), x * np.sin(th)])


def balance(x, p=0.0):
    p = float(np.clip(p, -1, 1))
    return np.vstack([x[0] * min(1.0, 1.0 - p), x[1] * min(1.0, 1.0 + p)])


def as_stereo(x, pan=0.0):
    x = np.asarray(x, float)
    return pan2(x, pan) if x.ndim == 1 else balance(x, pan)


def place(dst, x, start_sample, gain=1.0):
    """Add x (2, m) into dst (2, n) at start_sample, clipped to bounds."""
    m = x.shape[-1]
    n = dst.shape[-1]
    a0 = max(0, -start_sample)
    a1 = min(m, n - start_sample)
    if a1 > a0:
        dst[:, start_sample + a0:start_sample + a1] += gain * x[:, a0:a1]


def seg_env(n_total, t0, t1, fin, fout):
    """Envelope for a region: 0 before t0, raised-cosine fade in, 1, fade out ending at t1."""
    t = tvec(n_total)
    e = np.zeros(n_total)
    a = (t >= t0) & (t < t1)
    e[a] = 1.0
    if fin > 0:
        m = (t >= t0) & (t < t0 + fin)
        e[m] = (1 - np.cos(np.pi * (t[m] - t0) / fin)) * 0.5
    if fout > 0:
        m = (t >= t1 - fout) & (t < t1)
        e[m] *= (1 + np.cos(np.pi * (t[m] - (t1 - fout)) / fout)) * 0.5
    return e


def write_wav(path, x, bits=24):
    """Write mono (n,) or multichannel (ch, n) float audio as PCM16/PCM24/float32 WAV."""
    x = np.atleast_2d(np.asarray(x, float))
    if x.shape[0] > 8:
        x = x.T
    ch, n = x.shape
    inter = x.T.reshape(-1)
    if bits == 16:
        data = np.clip(np.round(inter * 32767.0), -32768, 32767).astype("<i2").tobytes()
        fmt_tag, bps = 1, 16
    elif bits == 24:
        q = np.clip(np.round(inter * 8388607.0), -8388608, 8388607).astype("<i4")
        data = q.view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
        fmt_tag, bps = 1, 24
    elif bits == 32:
        data = inter.astype("<f4").tobytes()
        fmt_tag, bps = 3, 32
    else:
        raise ValueError(bits)
    block = ch * bps // 8
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
        f.write(b"fmt " + struct.pack("<IHHIIHH", 16, fmt_tag, ch, SR, SR * block, block, bps))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


def read_wav(path):
    """Minimal reader for the files written above. Returns (sr, bits, float array (ch, n))."""
    with open(path, "rb") as f:
        buf = f.read()
    assert buf[:4] == b"RIFF" and buf[8:12] == b"WAVE"
    pos = 12
    fmt = None
    while pos < len(buf):
        cid = buf[pos:pos + 4]
        size = struct.unpack("<I", buf[pos + 4:pos + 8])[0]
        body = buf[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
        elif cid == b"data":
            tag, ch, sr, _, _, bps = fmt
            if bps == 24:
                b = np.frombuffer(body, np.uint8).reshape(-1, 3).astype(np.int32)
                v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
                v = np.where(v >= 1 << 23, v - (1 << 24), v)
                y = v / 8388608.0
            elif bps == 16:
                y = np.frombuffer(body, "<i2") / 32768.0
            else:
                y = np.frombuffer(body, "<f4").astype(float)
            return sr, bps, y.reshape(-1, ch).T
        pos += 8 + size + (size & 1)
    raise ValueError("no data chunk")


class Sound:
    """A rendered sound. x: mono (n,) or stereo (2, n); anchor: seconds into x that lands on the
    cue time; onsets: seconds relative to the anchor where audible transients happen (for QA)."""

    def __init__(self, x, anchor=0.0, onsets=(0.0,)):
        self.x = np.asarray(x, float)
        self.anchor = float(anchor)
        self.onsets = list(onsets)


# =============================================================================
# 2. DSP building blocks
# =============================================================================


def modal(freqs, decays, amps, dur, contact=0.0):
    """Sum of exponentially decaying sines (modal synthesis of an impact). `contact` (s) smooths
    the excitation with a Hann window = softer mallet / finger / sock."""
    n = nsamp(dur)
    t = tvec(n)
    y = np.zeros(n)
    for f, d, a in zip(freqs, decays, amps):
        if f <= 0 or f >= 0.45 * SR:
            continue
        m = min(n, nsamp(d * 9.3))
        y[:m] += a * np.exp(-t[:m] / d) * np.sin(2 * np.pi * f * t[:m])
    if contact > 0:
        k = max(3, nsamp(contact))
        w = np.hanning(k + 2)[1:-1]
        y = np.convolve(y, w / w.sum())[:n]
    return y


def rbj(kind, f, q):
    f = float(np.clip(f, 10.0, SR * 0.45))
    w0 = 2 * np.pi * f / SR
    cw, sw = np.cos(w0), np.sin(w0)
    al = sw / (2 * q)
    if kind == "bp":
        b = np.array([al, 0.0, -al])
    elif kind == "lp":
        b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2])
    elif kind == "hp":
        b = np.array([(1 + cw) / 2, -(1 + cw), (1 + cw) / 2])
    else:
        raise ValueError(kind)
    a = np.array([1 + al, -2 * cw, 1 - al])
    return b / a[0], a / a[0]


def peak_eq(x, f, q, gain_db):
    """RBJ peaking EQ (static)."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * f / SR
    al = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b = np.array([1 + al * A, -2 * cw, 1 - al * A])
    a = np.array([1 + al / A, -2 * cw, 1 - al / A])
    return signal.lfilter(b / a[0], a / a[0], x, axis=-1)


def sweep_filter(x, fc, q=0.8, kind="bp", block=128):
    """Time-varying biquad (block-wise coefficient update with state carry-over)."""
    fc = np.broadcast_to(np.asarray(fc, float), x.shape)
    y = np.empty_like(x)
    zi = np.zeros(2)
    for s in range(0, len(x), block):
        e = min(len(x), s + block)
        b, a = rbj(kind, fc[(s + e) // 2], q)
        y[s:e], zi = signal.lfilter(b, a, x[s:e], zi=zi)
    return y


def resonate(x, freqs, qs, gains):
    y = np.zeros_like(x)
    for f, q, g in zip(freqs, qs, gains):
        if f >= 0.45 * SR:
            continue
        b, a = signal.iirpeak(f, q, fs=SR)
        y += g * signal.lfilter(b, a, x)
    return y


def speed_curve(n, shape):
    a, b = shape
    u = np.linspace(1e-6, 1 - 1e-6, n)
    s = u ** a * (1 - u) ** b
    return s / s.max()


def friction_creak(dur, rng, rate_lo, rate_hi, res, q, g, shape=(0.6, 1.0), wobble=0.22,
                   jitter=0.25, grit=0.35, body_lp=4200.0, buzz=0.2, phase0=0.0):
    """Stick-slip friction (hinge / floorboard / spring creak): an irregular pulse train whose
    rate follows the movement speed, exciting a bank of wooden/metal resonances."""
    n = nsamp(dur)
    sp = speed_curve(n, shape)
    wob = smooth_rand(n, 7.0, rng) * wobble + smooth_rand(n, 1.7, rng) * wobble
    rate = (rate_lo + (rate_hi - rate_lo) * sp) * 2.0 ** wob
    ph = np.cumsum(rate / SR) + phase0
    idx = np.nonzero(np.diff(np.floor(ph)))[0] + 1
    exc = np.zeros(n)
    if len(idx):
        amp = np.clip(1 + jitter * rng.standard_normal(len(idx)), 0.25, 2.0)
        exc[idx] = amp * (0.3 + 0.7 * sp[idx])
    if grit > 0:
        k = nsamp(0.0012)
        kern = rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 4.0))
        exc = exc + grit * np.convolve(exc, kern)[:n]
    y = resonate(exc, res, q, g) + buzz * lp(exc, 1100)
    y = lp(y, body_lp)
    y *= (0.25 + 0.75 * sp) * (1 + 0.22 * smooth_rand(n, 9.0, rng))
    return fades(y, 0.02, 0.06)


def make_ir(rt_bands, length, rng, predelay=0.015, early=()):
    """Stereo synthetic reverb IR: band-split decaying noise (per-band RT60) + early taps.
    rt_bands: [(lo, hi, rt60), ...]. Energy-normalised per channel."""
    n = nsamp(length)
    t = tvec(n)
    pd = nsamp(predelay)
    out = np.zeros((2, n + pd))
    for ch in range(2):
        nz = rng.standard_normal(n)
        y = np.zeros(n)
        for lo, hi, rt in rt_bands:
            if lo <= 0:
                band = signal.sosfiltfilt(_sos("lowpass", hi, 4), nz)
            elif hi >= SR / 2:
                band = signal.sosfiltfilt(_sos("highpass", lo, 4), nz)
            else:
                band = signal.sosfiltfilt(_sos("bandpass", [lo, hi], 4), nz)
            y += band * np.exp(-6.9078 * t / rt)
        y *= 1 - np.exp(-t / 0.004)  # soft onset of the diffuse tail
        for dt, a in early:
            k = nsamp(dt * (1 + 0.07 * (ch - 0.5)))
            if k < n:
                y[k] += a * (1 if rng.random() > 0.5 else -1) * 3.0
        y = fades(y, 0.0, length * 0.15)
        out[ch, pd:] = y / np.sqrt(np.sum(y ** 2))
    return out


_IR = {}


def hall_ir():
    if "hall" not in _IR:
        _IR["hall"] = make_ir([(0, 250, 2.5), (250, 1000, 2.2), (1000, 4000, 1.7), (4000, SR / 2, 1.0)],
                              3.2, seeded("ir", "hall"), predelay=0.02,
                              early=[(0.011, 0.5), (0.019, 0.35), (0.027, 0.3), (0.041, 0.22)])
    return _IR["hall"]


def room_ir():
    if "room" not in _IR:
        _IR["room"] = make_ir([(0, 250, 0.45), (250, 1000, 0.38), (1000, 4000, 0.3), (4000, SR / 2, 0.2)],
                              0.6, seeded("ir", "room"), predelay=0.003,
                              early=[(0.004, 0.6), (0.007, 0.45), (0.011, 0.35), (0.016, 0.25)])
    return _IR["room"]


def outdoor_ir():
    if "out" not in _IR:
        _IR["out"] = make_ir([(0, 400, 1.0), (400, 2000, 0.8), (2000, SR / 2, 0.5)], 1.2,
                             seeded("ir", "out"), predelay=0.03)
    return _IR["out"]


def convolve(x, ir):
    """x mono or (2, n); ir (2, m). Returns (2, n) (tail truncated to len(x))."""
    x = np.asarray(x, float)
    if x.ndim == 1:
        x = np.vstack([x, x])
    n = x.shape[-1]
    return np.vstack([signal.fftconvolve(x[c], ir[c])[:n] for c in range(2)])


def with_tail(x, seconds):
    x = np.asarray(x, float)
    pad = np.zeros(x.shape[:-1] + (nsamp(seconds),))
    return np.concatenate([x, pad], axis=-1)


def make_loop(x, xfade):
    """Seamless loop: x is rendered `xfade` seconds longer than wanted; tail is crossfaded into head."""
    k = nsamp(xfade)
    body = np.array(x[..., :-k], copy=True)
    tail = x[..., -k:]
    w = np.sin(np.linspace(0, np.pi / 2, k))
    body[..., :k] = body[..., :k] * w + tail * np.cos(np.linspace(0, np.pi / 2, k))
    return body


# =============================================================================
# 3. SFX library (each returns a Sound; x is peak-normalised to 1.0)
# =============================================================================


def sfx_latch_click(rng, kind="close", bright=1.0, strength=1.0):
    """Door latch. kind='open': handle turn + bolt retract (2 clicks); 'close': bolt slides over
    the strike plate then snaps in (anchor = snap)."""
    dur = 0.18
    n = nsamp(dur)
    u = rng.uniform
    fm = np.array([1750, 2950, 4400, 6100]) * bright * rng.uniform(0.95, 1.05, 4)
    dm = np.array([0.020, 0.013, 0.008, 0.005])
    am = np.array([1.0, 0.75, 0.45, 0.22])
    fw = np.array([u(190, 240), u(430, 520), u(780, 900)])
    y = np.zeros(n)
    anchor = 0.0
    if kind == "open":
        c1 = modal(fm * 0.93, dm * 0.8, am * 0.5, dur, contact=0.0007)
        c2 = modal(fm, dm, am, dur, contact=0.0005)
        w = modal(fw, [0.03, 0.018, 0.01], [0.8, 0.5, 0.25], dur, contact=0.0015)
        off = nsamp(u(0.035, 0.055))
        y += 0.45 * c1 + 0.3 * w
        y[off:] += (0.9 * c2 + 0.5 * w)[: n - off]
        anchor = off / SR
    else:
        sl = nsamp(0.026)
        slide = bp(white(sl, rng), 2500, 7000) * np.linspace(0.1, 1.0, sl) ** 2 * 0.12
        c = modal(fm * 1.05, dm * 1.2, am, dur, contact=0.0004)
        w = modal(fw * 0.9, [0.045, 0.025, 0.012], [1.0, 0.6, 0.3], dur, contact=0.0013)
        y[:sl] += slide
        y[sl:] += (c + (0.7 + 0.3 * strength) * w)[: n - sl]
        anchor = sl / SR
    y = lp(y, 9500)
    return Sound(norm(fades(y, 0.0005, 0.03)), anchor=anchor)


def hinge_creak(dur, rng, rate=(38, 95), shape=(0.55, 1.1), pitch=1.0, wobble=0.22):
    """Wooden door hinge creak (gentle, not horror): rate = stick-slip pulses/s (slow->fast)."""
    res = np.array([360, 820, 1300, 2050, 3100]) * pitch * rng.uniform(0.97, 1.03, 5)
    y = friction_creak(dur, rng, rate[0], rate[1], res, [7, 11, 12, 13, 12], [0.8, 1.0, 0.7, 0.42, 0.2],
                       shape=shape, wobble=wobble, grit=0.35, body_lp=4000)
    # wooden groan undertone (sub-rate, low resonances)
    y2 = friction_creak(dur, rng, rate[0] * 0.5, rate[1] * 0.5, np.array([170, 330, 560]) * pitch,
                        [5, 7, 8], [1.0, 0.8, 0.5], shape=shape, wobble=wobble * 0.6, grit=0.1, body_lp=1500,
                        buzz=0.1)
    n = nsamp(dur)
    air = lp(bp(pink(n, rng), 60, 500), 400) * speed_curve(n, shape)
    return norm(unit_rms(y) + 0.45 * unit_rms(y2) + 0.25 * unit_rms(air))


def sfx_door_open(rng, creak=1.5, rate=(38, 95), pitch=1.0):
    """Latch click + hinge creak + air of the door moving. Anchor = latch (cue time)."""
    total = creak + 0.3
    lc = sfx_latch_click(rng, kind="open")
    a0 = nsamp(lc.anchor)  # handle-turn pre-click sits a few ms before the cue
    y = np.zeros(nsamp(total) + a0)
    y[: len(lc.x)] += 0.8 * lc.x
    c0 = a0 + nsamp(0.08)
    cr = hinge_creak(creak, rng, rate=rate, shape=(0.55, 1.1), pitch=pitch)
    y[c0:c0 + len(cr)] += 0.55 * cr
    return Sound(norm(fades(y, 0.0005, 0.05)), anchor=lc.anchor, onsets=[0.0])


def sfx_door_close(rng, creak=0.45, final=False):
    """Short creak (cue time) then latch snap + soft frame thud at `creak` seconds."""
    total = creak + 0.35
    y = np.zeros(nsamp(total))
    cr = hinge_creak(max(0.12, creak - 0.02), rng, rate=(30, 80), shape=(0.35, 1.3), pitch=1.03)
    y[: len(cr)] += (0.5 if not final else 0.45) * cr
    lc = sfx_latch_click(rng, kind="close", strength=1.3 if final else 1.0)
    s = nsamp(creak) - nsamp(lc.anchor)
    y[s:s + len(lc.x)] += lc.x[: len(y) - s]
    u = rng.uniform
    th = modal([u(85, 105), u(170, 210), u(380, 440)], [0.07, 0.045, 0.02], [1.0, 0.55, 0.3], 0.3, contact=0.007)
    k = nsamp(creak)
    y[k:k + len(th)] += (0.75 if final else 0.5) * th[: len(y) - k]
    return Sound(norm(fades(y, 0.002, 0.05)), anchor=0.0, onsets=[(0.0, "soft"), creak])


def sfx_footstep(rng, weight=1.0, scuff=1.0):
    """Mom in socks on a wooden floor: soft heel thump, mid 'tuk', fabric scuff, toe roll."""
    dur = 0.36
    n = nsamp(dur)
    t = tvec(n)
    u = rng.uniform
    heel = modal([u(80, 115), u(170, 230), u(330, 430)], [0.05, 0.03, 0.016], [1.0, 0.5, 0.35], dur,
                 contact=u(0.007, 0.011))
    body = lp(white(n, rng) * np.exp(-t / 0.018) * (1 - np.exp(-t / 0.003)), 520)
    tuk = modal([u(320, 420), u(640, 820), u(1100, 1350)], [0.022, 0.012, 0.007], [1.0, 0.45, 0.2], dur,
                contact=u(0.0025, 0.0035))
    sc_env = (1 - np.exp(-t / 0.008)) * np.exp(-t / u(0.05, 0.09))
    scf = bp(white(n, rng), 1200, 6000) * sc_env
    heel, body, tuk, scf = norm(heel), norm(body), norm(tuk), norm(scf)
    y = weight * (0.5 * heel + 0.3 * body) + 0.75 * tuk + 0.28 * scuff * scf
    off = nsamp(u(0.07, 0.12))
    toe = 0.4 * norm(modal([u(110, 150), u(360, 460)], [0.035, 0.015], [1.0, 0.8], dur, contact=0.005))
    toe += 0.12 * scuff * norm(bp(white(n, rng), 1500, 5500) * np.exp(-t / 0.04) * (1 - np.exp(-t / 0.006)))
    y[off:] += toe[: n - off]
    if rng.random() < 0.3:  # occasional tiny board tick
        tick = 0.12 * norm(modal([u(900, 1400)], [0.01], [1.0], 0.05, contact=0.001))
        k = nsamp(u(0.01, 0.05))
        y[k:k + len(tick)] += tick
    return Sound(norm(fades(y, 0.001, 0.04)))


def sfx_floorboard_creak(rng, dur=0.42):
    y = friction_creak(dur, rng, 16, 38, np.array([160, 310, 560, 980, 1600]) * rng.uniform(0.95, 1.05),
                       [5, 7, 8, 9, 9], [1.0, 0.9, 0.7, 0.4, 0.2], shape=(0.3, 0.9), wobble=0.18, grit=0.25,
                       body_lp=2600, buzz=0.15, phase0=0.9)
    return Sound(norm(y), onsets=[(0.0, "soft")])


def sfx_blanket_rustle(rng, dur=0.8, intensity=1.0, softness=0.5, strokes=1, contact=0.6):
    """Fabric rustle: band-limited noise under a movement envelope + fibre micro-crackle grains.
    softness 0..1 (fleece baby blanket ~0.8, cotton duvet ~0.4)."""
    n = nsamp(dur)
    t = tvec(n)
    env = np.zeros(n)
    for i in range(strokes):
        c = (i + 0.35) / strokes * dur + rng.uniform(-0.05, 0.05) * dur / strokes
        w = dur / strokes * 0.9 / 3.0
        env += np.exp(-0.5 * ((t - c) / w) ** 2)
    env = np.maximum(env, contact * np.exp(-t / (0.25 * dur)))  # hand/fabric contact right at the cue
    env *= np.sin(np.pi / 2 * np.clip(t / 0.03, 0, 1)) ** 2 * np.cos(np.pi / 2 * np.clip((t - dur + 0.12) / 0.12, 0, 1)) ** 2
    env *= 0.65 + 0.35 * smooth_rand(n, 14.0, rng)
    env = np.clip(env, 0, None)
    env /= env.max()
    hi = 1800 + 5200 * (1 - softness)
    base = unit_rms(bp(pink(n, rng), 280, hi))
    rate = (900 * (1 - softness) + 150) * intensity
    imp = (rng.random(n) < rate * env / SR) * rng.exponential(1.0, n)
    k = nsamp(0.002)
    kern = rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 5.0))
    gr = bp(np.convolve(imp, kern)[:n], 1500, min(9000, hi * 1.4))
    gr = unit_rms(gr) if np.any(gr) else gr
    low = unit_rms(lp(brown(n, rng), 350))
    y = env * (base + 0.7 * (1 - 0.6 * softness) * gr) + 0.4 * env ** 2 * low
    return Sound(norm(fades(y, 0.01, 0.04)), onsets=[(0.0, "soft")])


def sfx_car_pass(rng, dur=1.4, size=1.0):
    """A car driving past close: tyre noise + engine hum whose pitch drops (Doppler) under a pass-by swell.
    The event time t = the moment the car is closest. anchor = dur/2."""
    n = nsamp(dur)
    t = tvec(n) - dur / 2
    env = 1 / (1 + (t / (0.22 * dur)) ** 2)
    tyre = unit_rms(bp(pink(n, rng), 300, 2600))
    f = (70 + 30 * size) * (1.08 - 0.16 / (1 + np.exp(-t / 0.08)))  # higher approaching, lower leaving
    ph = 2 * np.pi * np.cumsum(f) / SR
    eng = np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)
    y = env * (tyre + 0.6 * unit_rms(eng)) + 0.3 * env ** 2 * unit_rms(lp(brown(n, rng), 120))
    return Sound(norm(fades(y, 0.05, 0.08)), anchor=dur / 2, onsets=[(0.0, "soft")])


def sfx_chalk_write(rng, dur=0.9, strokes=5):
    """Chalk on a board: dry scratchy strokes + little taps at stroke starts. Kept soft (band-limited, no squeal)."""
    n = nsamp(dur)
    t = tvec(n)
    env = np.zeros(n)
    for i in range(strokes):
        c = (i + 0.2) / strokes * dur
        w = dur / strokes * 0.7
        env += np.clip(1 - np.abs(t - c - w / 2) / (w / 2), 0, 1) ** 0.6
    scratch = unit_rms(bp(white(n, rng), 1500, 4200)) * (0.5 + 0.5 * smooth_rand(n, 40, rng) ** 2)
    taps = np.zeros(n)
    for i in range(strokes):
        st = nsamp((i + 0.2) / strokes * dur)
        k = nsamp(0.01)
        if st + k < n:
            taps[st:st + k] += np.exp(-np.arange(k) / (k / 6)) * rng.standard_normal(k)
    y = env * scratch + 1.5 * bp(taps, 800, 3000)
    return Sound(norm(fades(y, 0.005, 0.03)), onsets=[(0.0, "soft")])


def sfx_pen_scribble(rng, dur=0.7):
    """Pen signing on paper on a table: quick soft scribble."""
    n = nsamp(dur)
    t = tvec(n)
    env = np.clip(np.sin(np.pi * t / dur), 0, 1) * (0.5 + 0.5 * np.abs(np.sin(2 * np.pi * 7.5 * t)))
    y = env * unit_rms(bp(white(n, rng), 900, 3500)) + 0.4 * env * unit_rms(lp(pink(n, rng), 500))
    return Sound(norm(fades(y, 0.005, 0.03)), onsets=[(0.0, "soft")])


def sfx_low_swell(rng, dur=1.6, pitch=1.0):
    """A soft rising filtered-noise + sub swell that peaks at the end (anchor = end) — for a reveal, never harsh."""
    n = nsamp(dur)
    t = tvec(n)
    env = (t / dur) ** 2.2
    fc = 200 + 1600 * (t / dur) ** 2
    nz = sweep_filter(pink(n, rng), fc * pitch, q=0.9, kind="bp")
    sub = np.sin(2 * np.pi * 55 * pitch * t)
    y = env * (unit_rms(nz) + 0.6 * sub)
    return Sound(norm(fades(y, 0.02, 0.02)), anchor=dur, onsets=[(0.0, "soft")])


def sfx_mattress_sit(rng, dur=0.85):
    n = nsamp(dur)
    t = tvec(n)
    u = rng.uniform
    sink = norm(lp(white(n, rng), 220) * (1 - np.exp(-t / 0.04)) * np.exp(-t / 0.16))
    thump = norm(modal([u(60, 80), u(120, 150)], [0.12, 0.07], [1.0, 0.5], dur, contact=0.03))
    y = 0.6 * sink + 0.7 * thump
    for st, a in ((0.06, 0.2), (0.3, 0.13)):
        sp = norm(friction_creak(0.15, rng, 150, 230, [1250, 2200, 3300], [25, 28, 30], [1, 0.6, 0.3],
                                 shape=(0.5, 0.8), body_lp=5000))
        k = nsamp(st)
        y[k:k + len(sp)] += a * sp[: n - k]
    fr = norm(friction_creak(0.3, rng, 25, 45, [210, 420, 780], [6, 8, 9], [1, 0.7, 0.4], body_lp=1800))
    k = nsamp(0.08)
    y[k:k + len(fr)] += 0.25 * fr
    ru = sfx_blanket_rustle(rng, 0.7, intensity=0.8, softness=0.55).x
    k = nsamp(0.02)
    y[k:k + len(ru)] += 0.5 * ru[: n - k]
    return Sound(norm(fades(y, 0.004, 0.05)), onsets=[(0.0, "soft")])


def sfx_plush_squeak(rng, dur=0.17, pitch=1.0):
    """Tiny squeaker inside a plush toy: pitched reed tone + air, muffled by the stuffing."""
    n = nsamp(dur)
    t = tvec(n)
    uu = t / dur
    f = 1250 * pitch * (1 + 0.18 * np.sin(np.pi * uu)) * (1 + 0.01 * smooth_rand(n, 30.0, rng))
    ph = 2 * np.pi * np.cumsum(f) / SR
    tone = sum(k ** -1.4 * np.sin(k * ph) for k in range(1, 7))
    tone *= 1 + 0.25 * np.sin(2 * np.pi * 35 * t)
    env = np.minimum(np.sin(np.pi / 2 * np.clip(t / 0.025, 0, 1)) ** 2,
                     np.sin(np.pi / 2 * np.clip((dur - t) / 0.06, 0, 1)) ** 2)
    air = 0.3 * unit_rms(bp(white(n, rng), 900, 4000))
    y = lp((unit_rms(tone) + air) * env, 3200)
    return Sound(norm(fades(y, 0.002, 0.01)))


def sfx_plush_pickup(rng):
    """Plush toy lifted off the floor: soft fur brush + a tiny squeak."""
    ru = sfx_blanket_rustle(rng, 0.36, intensity=0.7, softness=0.8).x
    sq = sfx_plush_squeak(rng, 0.15, pitch=rng.uniform(0.95, 1.08)).x
    y = np.zeros(nsamp(0.5))
    y[: len(ru)] += ru
    k = nsamp(0.08)
    y[k:k + len(sq)] += 0.55 * sq
    tap = norm(modal([rng.uniform(140, 180), rng.uniform(380, 450)], [0.03, 0.015], [1, 0.4], 0.12, contact=0.006))
    y[: len(tap)] += 1.0 * tap
    return Sound(norm(fades(y, 0.002, 0.04)))


def sfx_plush_place(rng):
    dur = 0.36
    n = nsamp(dur)
    t = tvec(n)
    th = norm(lp(white(n, rng) * (1 - np.exp(-t / 0.006)) * np.exp(-t / 0.05), 450))
    md = norm(modal([rng.uniform(100, 125), rng.uniform(210, 250)], [0.05, 0.03], [1.0, 0.4], dur, contact=0.012))
    ru = sfx_blanket_rustle(rng, 0.25, intensity=0.6, softness=0.8).x
    y = 0.7 * th + 0.6 * md
    y[: len(ru)] += 0.4 * ru
    return Sound(norm(fades(y, 0.002, 0.04)))


def sfx_phone_pickup(rng):
    """Phone lifted off a blanket: fingernail/case tick + short fabric slide."""
    n = nsamp(0.45)
    u = rng.uniform
    tick = norm(modal(np.array([2600, 4100, 5900]) * u(0.95, 1.05), [0.004, 0.003, 0.002], [1.0, 0.6, 0.3],
                      0.05, contact=0.0004))
    sl = sfx_blanket_rustle(rng, 0.32, intensity=0.8, softness=0.5).x
    y = np.zeros(n)
    y[: len(tick)] += tick
    k = nsamp(0.03)
    y[k:k + len(sl)] += 0.55 * sl
    return Sound(norm(fades(y, 0.0005, 0.04)))


def sfx_phone_set_down_wood(rng):
    """Phone set down on a wooden nightstand: hollow wooden 'tock' + case click, edge then flat."""
    dur = 0.32
    u = rng.uniform

    def hit(s):
        wood = modal([u(170, 200), u(500, 560), u(860, 940), u(1400, 1520), u(2250, 2400)],
                     [0.05, 0.04, 0.028, 0.014, 0.008], [0.45, 1.0, 0.8, 0.4, 0.18], dur, contact=0.0009)
        case = modal(np.array([u(3000, 3300), u(5000, 5500)]), [0.006, 0.004], [0.5, 0.25], dur, contact=0.0003)
        return s * (norm(wood) + 0.35 * norm(case))

    y = hit(1.0)
    k = nsamp(u(0.012, 0.022))
    y[k:] += hit(0.38)[: len(y) - k]
    y = lp(y, 10000)
    return Sound(norm(fades(y, 0.0005, 0.04)))


def sfx_lamp_switch_click(rng):
    dur = 0.14
    u = rng.uniform

    def click(s):
        a = modal(np.array([2300, 3600, 5400, 7600]) * s, [0.006, 0.005, 0.0035, 0.002], [1, 0.8, 0.5, 0.25], dur,
                  contact=0.00025)
        b = modal([u(820, 900) * s, u(1500, 1650) * s], [0.012, 0.008], [0.5, 0.3], dur, contact=0.0006)
        return norm(a) + 0.6 * norm(b)

    y = click(u(0.97, 1.03))
    k = nsamp(u(0.03, 0.045))
    y[k:] += 0.5 * click(u(1.02, 1.08))[: len(y) - k]
    return Sound(norm(fades(lp(y, 10000), 0.0003, 0.03)))


def sfx_counter_tick(rng, bright=1.0, gold=False):
    """Soft odometer/mechanical counter tick."""
    dur = 0.06
    s = rng.uniform(0.97, 1.03) * bright
    y = norm(modal(np.array([3300, 4950, 7050]) * s, [0.004, 0.003, 0.0018], [1.0, 0.55, 0.25], dur, contact=0.0003))
    y += 0.45 * norm(modal([1250 * s], [0.006], [1.0], dur, contact=0.0005))
    if gold:
        y += 0.5 * norm(modal([880 * s, 2100 * s], [0.012, 0.008], [1.0, 0.7], dur, contact=0.0004))
    return Sound(norm(fades(lp(y, 9000), 0.0003, 0.01)))


def celesta_note(midi, vel=0.5, dur=1.8, decay=1.0):
    f = mtof(midi)
    n = nsamp(dur)
    t = tvec(n)
    tau = 1.1 * decay * 2 ** (-(midi - 84) / 24.0)
    y = np.zeros(n)
    for r, a, df in ((1.0, 1.0, 1.0), (1.0 + 0.9 / f, 0.3, 1.0), (2.0, 0.22, 0.45), (3.0, 0.06, 0.25),
                     (4.02, 0.05, 0.12), (2.756, 0.07, 0.05)):
        if f * r < 0.45 * SR:
            y += a * np.exp(-t / (tau * df)) * np.sin(2 * np.pi * f * r * t)
    k = nsamp(0.0006)
    w = np.hanning(k + 2)[1:-1]
    y = np.convolve(y, w / w.sum())[:n]
    return fades(y, 0.0, 0.2) * vel ** 1.3


def mallet_note(midi, vel=0.5, hold=0.4):
    """Soft marimba-like mallet (world/explainer tone): wooden fundamental + the 3.93x and 9.2x bar modes,
    a felt-soft attack, damped after `hold` s. Low-passed so it stays gentle (house style: nothing bright)."""
    key = ("mallet", int(midi), round(float(vel), 2), round(float(hold), 2))
    if key in _PIANO_CACHE:
        return _PIANO_CACHE[key]
    f = mtof(midi)
    dur = min(hold, 1.2) + 0.25
    n = nsamp(dur)
    t = tvec(n)
    tau = 0.55 * 2 ** (-(midi - 60) / 30.0)
    y = np.zeros(n)
    for r, a, df in ((1.0, 1.0, 1.0), (3.93, 0.16, 0.18), (9.2, 0.035, 0.05)):
        if f * r < 0.45 * SR:
            y += a * np.exp(-t / (tau * df)) * np.sin(2 * np.pi * f * r * t)
    y *= np.clip(t / 0.004, 0, 1)                                   # felt attack (no click)
    y *= np.where(t < hold, 1.0, np.exp(-(t - hold) / 0.06))       # damp after the hold
    y = lp(y, 3200)
    y = fades(y, 0.0, 0.03) * vel ** 1.2 * 0.9
    _PIANO_CACHE[key] = y
    return y


def string_note(midi, vel=0.5, hold=0.12, rng=None):
    """Cinematic string-section note (world/dramatic tone): 3 detuned PolyBLEP saws, bowed attack, velocity-dependent
    low-pass. Short holds = spiccato ostinato (the 'Zimmer drive'); long holds = sustained section."""
    key = ("str", int(midi), round(float(vel), 2), round(float(hold), 3))
    if key in _PIANO_CACHE:
        return _PIANO_CACHE[key]
    f = mtof(midi)
    rel = 0.09 if hold < 0.4 else 0.35
    n = nsamp(hold + rel)
    t = tvec(n)
    y = np.zeros(n)
    for c, ph in ((-7, 0.1), (0, 0.5), (6, 0.8)):
        y += saw_blep(f * 2 ** (c / 1200), n, ph)
    att = 0.012 if hold < 0.4 else 0.08
    env = np.clip(t / att, 0, 1) * (0.75 + 0.25 * np.exp(-t / 0.06))
    env *= np.where(t < hold, 1.0, np.exp(-(t - hold) / (rel / 3)))
    y = hp(lp(lp(y, 700 + 2600 * vel), 2400), 45) * env
    y = fades(y, 0.0, 0.02) * vel * 0.45
    _PIANO_CACHE[key] = y
    return y


def drum_hit(kind="taiko", vel=0.6):
    """Soft cinematic drums (no snap/crack, house style): 'taiko' (warm low boom), 'tom' (shorter, higher),
    'boom' (huge sub hit for a reveal), 'tick' (felt rim for an ostinato pulse). Pitch-swept sines + low-passed noise."""
    key = ("drum", kind, round(float(vel), 2))
    if key in _PIANO_CACHE:
        return _PIANO_CACHE[key]
    if kind == "clap":   # (019) a soft, low-passed dance clap: three quick noise bursts + a short tail, band-limited (no crack)
        n = nsamp(0.35)
        t = tvec(n)
        env = sum(np.exp(-np.clip(t - d, 0, None) / 0.006) * (t >= d) for d in (0.0, 0.011, 0.023)) + 0.55 * np.exp(-np.clip(t - 0.03, 0, None) / 0.085) * (t >= 0.03)
        y = bp(seeded("drum", kind).standard_normal(n), 700, 2300) * env
        y = np.tanh(1.4 * y / (np.max(np.abs(y)) + 1e-9)) / np.tanh(1.4)
        y = fades(lp(y, 2600), 0.0, 0.05) * vel
        _PIANO_CACHE[key] = y
        return y
    f0, f1, sw, dec, nz, nzf, dur = {"taiko": (150, 62, 0.08, 0.7, 0.45, 450, 1.6), "tom": (170, 95, 0.06, 0.32, 0.3, 600, 0.8),
                                     "boom": (75, 34, 0.35, 2.4, 0.25, 180, 4.0), "tick": (900, 700, 0.01, 0.05, 0.6, 2500, 0.2),
                                     "kick": (120, 48, 0.035, 0.2, 0.12, 300, 0.5)}[kind]   # kick (019): a short, round four-on-the-floor thump
    n = nsamp(dur)
    t = tvec(n)
    f = f1 + (f0 - f1) * np.exp(-t / sw)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / dec)
    rng = seeded("drum", kind)
    y += nz * lp(rng.standard_normal(n), nzf) * np.exp(-t / 0.04)
    y = np.tanh(1.6 * y) / np.tanh(1.6)
    y = lp(y, 2800) * np.clip(t / 0.002, 0, 1)
    y = fades(y, 0.0, 0.1) * vel
    _PIANO_CACHE[key] = y
    return y


def sfx_gold_chime(rng, notes=(84, 89, 93, 96), spacing=0.065, vel=0.55, shimmer=0.0, dur=2.2, decay=1.0):
    """Warm celesta/bell sparkle arpeggio (notes = MIDI)."""
    n = nsamp(dur + spacing * len(notes))
    y = np.zeros(n)
    for i, m in enumerate(notes):
        v = vel * (1 - 0.1 * i) * rng.uniform(0.92, 1.05)
        x = celesta_note(m, v, dur, decay)
        k = nsamp(i * spacing * rng.uniform(0.9, 1.1))
        y[k:k + len(x)] += x
    if shimmer > 0:
        t = tvec(n)
        y += shimmer * norm(bp(white(n, rng), 6000, 11000) * np.exp(-t / 0.35) * (1 - np.exp(-t / 0.05))) * 0.15
    return Sound(norm(fades(y, 0.0005, 0.25)))


def sfx_whoosh_timeskip(rng, pre=0.4, post=0.25):
    """Soft reversed swell building into the cut (anchor = peak), airy tail after. Stereo."""
    npre = nsamp(pre)
    npost = nsamp(post * 2.2)
    n = npre + npost
    t = (np.arange(n) - npre) / SR
    up = np.clip(1 + t / pre, 0, 1)
    env = np.where(t < 0, up ** 2.6, np.exp(-t / (post / 3.2)))
    fc = np.where(t < 0, 350 * (2800 / 350) ** up, 2800 + 1700 * (1 - np.exp(-t / 0.1)))
    nz = np.vstack([sweep_filter(pink(n, rng), fc, 0.9), sweep_filter(pink(n, rng), fc * 1.06, 0.9)])
    nz = unit_rms(nz) * env
    # reversed reverb of a soft F-major tone
    tl = nsamp(0.25)
    tt = tvec(tl)
    tone = sum(np.sin(2 * np.pi * mtof(m) * tt) for m in (77, 81, 84)) * np.exp(-tt / 0.06)
    tone = fades(tone, 0.002, 0.02)
    wet = convolve(with_tail(tone, 1.3), hall_ir())
    rev = wet[:, ::-1]
    sw = np.zeros((2, n))
    seg = rev[:, -npre:]
    sw[:, :npre] = seg * up[:npre] ** 1.5
    fw = np.zeros(n)
    fw[npre:npre + tl] = tone[: min(tl, n - npre)]
    sw += 0.25 * np.vstack([fw, fw]) * np.exp(-np.clip(t, 0, None) / 0.05)
    y = nz + 0.6 * sw / rms(sw[:, :npre])
    y = lp(y, 9000)
    return Sound(norm(fades(y, 0.004, 0.03)), anchor=pre)


def sfx_flash_swish(rng, dur=0.2, peak=0.07):
    n = nsamp(dur)
    t = tvec(n)
    env = np.where(t < peak, np.sin(np.pi / 2 * t / peak) ** 2, np.exp(-(t - peak) / 0.045))
    fc = np.where(t < peak, 1400 * (5200 / 1400) ** (t / peak), 2600 + 2600 * np.exp(-(t - peak) / 0.05))
    L = sweep_filter(white(n, rng), fc, 1.2)
    R = sweep_filter(white(n, rng), fc * 1.05, 1.2)
    pp = np.linspace(-0.5, 0.5, n)
    th = (pp + 1) * np.pi / 4
    y = np.vstack([L * np.cos(th), R * np.sin(th)]) * env
    return Sound(norm(fades(lp(y, 9000), 0.002, 0.01)), anchor=peak)


# =============================================================================
# 4. Ambience library (render to any length; peak-normalised; stereo unless noted)
# =============================================================================


def sfx_car_horn(rng, dur=0.42, pitch=1.0, distance=1.0):
    """A far-off car horn (two detuned reedy tones), low-passed + outdoor verb so it sits behind the scene (006)."""
    n = nsamp(dur)
    t = tvec(n)
    x = np.zeros(n)
    for f in (412.0 * pitch, 518.0 * pitch):
        ph = 2 * np.pi * f * t + 0.003 * np.sin(2 * np.pi * 5.5 * t)
        x += np.tanh(2.2 * np.sin(ph)) + 0.25 * np.sin(2 * ph)
    env = np.minimum(1.0, t / 0.012) * np.minimum(1.0, (dur - t) / 0.07)
    x = lp(hp(x * env, 180), 2400 / max(1.0, distance), 2)
    x = with_tail(x, 1.2)
    x = x + 3.0 * convolve(x, outdoor_ir())          # (2, n)
    return Sound(norm(x, 0.9), anchor=0.0, onsets=[0.0])


def sfx_snore(rng, dur=2.2, size=1.0):
    """One soft cartoon snore cycle (010): a low nasal buzz on the in-breath + an airy out-breath. Gentle, never rude."""
    n = nsamp(dur)
    t = tvec(n)
    inb = np.clip(t / (0.45 * dur), 0, 1) * (t < 0.55 * dur)
    f = 62 / size * (1 + 0.05 * np.sin(2 * np.pi * 3.0 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    buzz = np.sign(np.sin(ph)) * 0.5 + np.sin(2 * ph) * 0.3
    buzz = bp(buzz * (0.6 + 0.4 * rng.random(n)), 90, 900) * np.sin(np.pi * np.clip(t / (0.55 * dur), 0, 1)) ** 2
    out = bp(pink(n, rng), 300, 2200) * np.sin(np.pi * np.clip((t - 0.6 * dur) / (0.38 * dur), 0, 1)) ** 2
    y = 0.9 * norm(buzz) + 0.35 * norm(out)
    return Sound(norm(fades(lp(y, 2500), 0.02, 0.1)), onsets=[(0.0, "soft")])


def sfx_dog_bark(rng, pitch=1.0):
    """A small dog's soft "boof" (010) — rounded, low-passed, no yap."""
    dur = 0.3
    n = nsamp(dur)
    t = tvec(n)
    f = 420 * pitch * (1 + 0.25 * np.exp(-t / 0.03)) * (1 - 0.15 * t / dur)
    ph = 2 * np.pi * np.cumsum(f) / SR
    v = np.sin(ph) + 0.6 * np.sin(2 * ph) + 0.3 * np.sin(3 * ph) + 0.4 * bp(white(n, rng), 600, 2400)
    env = (1 - np.exp(-t / 0.006)) * np.exp(-t / 0.07)
    return Sound(norm(fades(lp(v * env, 3000), 0.001, 0.04)), onsets=[(0.0, "transient")])


def sfx_slurp(rng, dur=0.8):
    """A polite coffee sip (010): a short airy slurp with a tiny liquid gurgle."""
    n = nsamp(dur)
    t = tvec(n)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5
    air = bp(white(n, rng), 900, 3500) * env * (0.6 + 0.4 * np.sin(2 * np.pi * 9 * t))
    gur = np.sin(2 * np.pi * (300 + 120 * np.sin(2 * np.pi * 6 * t)) * t) * env * 0.4
    return Sound(norm(fades(lp(air + gur, 3800), 0.01, 0.05)), onsets=[(0.0, "soft")])


def sfx_giant_step(rng, size=1.0, surface="ground"):
    """A 3-meter person's footfall (010): a deep sub thud + a low-passed body knock + a tiny settle of grit. No click.
    size scales the weight (pitch drops, tail lengthens). surface 'wood' adds a floorboard groan."""
    dur = 0.7
    n = nsamp(dur)
    t = tvec(n)
    f0 = (58 - 14 * (size - 1)) * rng.uniform(0.92, 1.08)
    sub = np.sin(2 * np.pi * f0 * t * (1 - 0.25 * np.clip(t / 0.25, 0, 1))) * np.exp(-t / (0.12 * size)) * (1 - np.exp(-t / 0.004))
    knock = norm(modal([rng.uniform(110, 150), rng.uniform(230, 290)], [0.05, 0.025], [1.0, 0.4], dur, contact=0.008))
    grit = lp(white(n, rng), 1800) * np.exp(-t / 0.06) * (1 - np.exp(-t / 0.01))
    y = 1.0 * sub + 0.5 * knock + 0.12 * norm(grit)
    if surface == "wood":                                   # the floor takes it: a short low groan of boards
        y += 0.25 * norm(lp(white(n, rng), 600) * np.exp(-t / 0.2))
    return Sound(norm(fades(lp(y, 2500), 0.001, 0.08)), onsets=[(0.0, "soft")])


def sfx_wood_snap(rng, dur=0.9, size=1.0):
    """Furniture breaking under weight (010 bed frame, park bench): a dry crack (band-limited, not bright) + splinter
    crackle + a low thud as it drops. anchor = the crack."""
    n = nsamp(dur)
    t = tvec(n)
    crack = bp(white(n, rng), 700, 3800) * np.exp(-t / 0.018) * (1 - np.exp(-t / 0.0015))
    imp = (rng.random(n) < 420.0 / SR * np.exp(-t / 0.15)) * rng.exponential(1.0, n)
    crackle = bp(np.convolve(imp, np.exp(-np.arange(nsamp(0.003)) / nsamp(0.0006)))[:n], 900, 3600)
    k = nsamp(0.09)
    thud = np.zeros(n)
    thud[k:] = (np.sin(2 * np.pi * 70 * size ** -0.3 * t[:n - k]) * np.exp(-t[:n - k] / 0.09))
    y = 0.9 * norm(crack) + 0.45 * (norm(crackle) if np.any(crackle) else crackle) + 0.8 * thud
    return Sound(norm(fades(lp(y, 4200), 0.0005, 0.06)), onsets=[(0.0, "transient")])


def sfx_bonk(rng, dur=0.6):
    """Head meets ceiling (010): a soft hollow knock (low modal) + a little plaster dust trickle. Cartoon, never painful."""
    n = nsamp(dur)
    t = tvec(n)
    knock = norm(modal([rng.uniform(150, 175), rng.uniform(330, 380), rng.uniform(610, 690)], [0.08, 0.04, 0.02], [1.0, 0.5, 0.2], dur, contact=0.006))
    dust = lp(white(n, rng), 2600) * np.exp(-((t - 0.25) / 0.12) ** 2) * 0.25
    return Sound(norm(fades(knock + dust, 0.0005, 0.05)), onsets=[(0.0, "transient")])


def sfx_keyboard_type(rng, dur=1.2, rate=11.0):
    """Office typing (013): soft plastic key taps (low modal clicks, low-passed), slightly irregular. Never clicky-bright."""
    n = nsamp(dur)
    y = np.zeros(n)
    tk = 0.01
    while tk < dur - 0.05:
        k = modal([rng.uniform(900, 1300), rng.uniform(2100, 2600)], [0.012, 0.006], [1.0, 0.35], 0.06, contact=0.002)
        i0 = nsamp(tk)
        m = min(len(k), n - i0)
        y[i0:i0 + m] += rng.uniform(0.5, 1.0) * norm(k)[:m]
        tk += rng.uniform(0.6, 1.4) / rate
    return Sound(norm(fades(lp(y, 3200), 0.001, 0.02)), onsets=[(0.0, "transient")])


def sfx_crow_caw(rng, pitch=1.0):
    """A crow's caw (013) — kept soft and round: a nasal buzzy tone through two formants, quick pitch fall, low-passed."""
    dur = 0.36
    n = nsamp(dur)
    t = tvec(n)
    f = 520 * pitch * (1.08 - 0.22 * t / dur)
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 9))
    v = 0.7 * bp(saw, 700, 1500) + 0.4 * bp(saw, 1900, 2600) + 0.15 * bp(white(n, rng), 800, 2400)
    env = (1 - np.exp(-t / 0.012)) * np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.6
    return Sound(norm(fades(lp(v * env, 2800), 0.002, 0.05)), onsets=[(0.0, "soft")])


def sfx_cat_meow(rng, pitch=1.0, dur=0.55):
    """A soft cat "mrrow" (016): a harmonic voice whose pitch rises then falls while the mouth opens (a formant sweeping
    up from 'ee' to 'ow'), purry onset, low-passed. Never a shrill yowl."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    f = 430 * pitch * (1 + 0.35 * np.sin(np.pi * np.clip(u * 1.1, 0, 1)) - 0.12 * u)
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 10))
    fc = 650 + 700 * np.sin(np.pi * np.clip(u, 0, 1)) ** 0.7
    v = sweep_filter(saw, fc, q=1.4, kind="bp") + 0.25 * bp(saw, 1800, 2600)
    purr = 1 + 0.35 * np.sin(2 * np.pi * 26 * t) * np.exp(-t / 0.08)
    env = (1 - np.exp(-t / 0.03)) * np.sin(np.pi * np.clip(u, 0, 1)) ** 0.5
    return Sound(norm(fades(lp(v * env * purr, 2600), 0.003, 0.06)), onsets=[(0.0, "soft")])


def sfx_parrot_chirp(rng, pitch=1.0, dur=0.32):
    """A parrot's "rrawk" (016), kept round: a buzzy tone with a fast warble and a quick pitch flip, two soft formants,
    low-passed hard so it reads as a bird without any squawk-shriek."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    f = 780 * pitch * (1.0 + 0.18 * np.sin(np.pi * u) - 0.1 * u) * (1 + 0.04 * np.sin(2 * np.pi * 32 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 7))
    v = 0.7 * bp(saw, 800, 1700) + 0.35 * bp(saw, 2000, 2700)
    env = (1 - np.exp(-t / 0.01)) * np.sin(np.pi * np.clip(u, 0, 1)) ** 0.7 * (0.75 + 0.25 * np.sin(2 * np.pi * 30 * t))
    return Sound(norm(fades(lp(v * env, 2900), 0.002, 0.04)), onsets=[(0.0, "soft")])


def sfx_fish_blub(rng, n_bub=3, dur=0.5):
    """A goldfish "talking" (016): a few soft underwater bubble plops (sine chirps that rise as they pop), low-passed."""
    n = nsamp(dur)
    y = np.zeros(n)
    tk = 0.0
    for _ in range(int(n_bub)):
        m = nsamp(0.09)
        tt = tvec(m)
        f0 = rng.uniform(260, 420)
        b = np.sin(2 * np.pi * np.cumsum(f0 * (1 + 2.2 * tt / 0.09)) / SR) * np.exp(-tt / 0.03) * (1 - np.exp(-tt / 0.003))
        i0 = nsamp(tk)
        k = min(m, n - i0)
        if k > 0:
            y[i0:i0 + k] += rng.uniform(0.6, 1.0) * b[:k]
        tk += rng.uniform(0.08, 0.14)
    return Sound(norm(fades(lp(y, 2200), 0.001, 0.03)), onsets=[(0.0, "soft")])


def sfx_hamster_squeak(rng, pitch=1.0, dur=0.13):
    """A tiny hamster squeak (016): a short sine chirp with a little bend, round and low-passed (no whistle)."""
    n = nsamp(dur)
    t = tvec(n)
    f = 1050 * pitch * (1 + 0.25 * np.sin(np.pi * np.clip(t / dur, 0, 1)))
    v = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.25 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.2
    return Sound(norm(fades(lp(v * env, 3000), 0.002, 0.02)), onsets=[(0.0, "soft")])


def sfx_metal_groan(rng, dur=1.4, pitch=1.0):
    """A vehicle's suspension bottoming out (010 bus): a low metallic groan + a clunk at the start."""
    n = nsamp(dur)
    t = tvec(n)
    f = 85 * pitch * (1 - 0.18 * np.clip(t / dur, 0, 1))
    ph = 2 * np.pi * np.cumsum(f) / SR
    groan = (np.sin(ph) + 0.5 * np.sin(2.01 * ph) + 0.3 * np.sin(3.03 * ph)) * (0.6 + 0.4 * smooth_rand(n, 7, rng)) * np.exp(-t / (0.45 * dur))
    clunk = norm(modal([rng.uniform(90, 110), rng.uniform(260, 300)], [0.06, 0.03], [1.0, 0.5], dur, contact=0.006))
    y = 0.7 * norm(lp(groan, 900)) + 0.8 * clunk
    return Sound(norm(fades(y, 0.001, 0.1)), onsets=[(0.0, "transient")])


def sfx_metal_clang(rng, size=1.0, pitch=1.0, dur=1.1):
    """A body (or a cart, a chair) slamming onto steel (018 magnetic): a soft low "CLONG" — inharmonic steel modes with
    a padded thump in front, low-passed hard so it lands as weight, never as a bright ping. size > 1 = bigger + darker."""
    n = nsamp(dur)
    t = tvec(n)
    f0 = 190 * pitch / size ** 0.5
    ring = modal([f0, f0 * 2.71, f0 * 4.43, f0 * 6.9], [0.55 * size, 0.32 * size, 0.18, 0.1], [1.0, 0.55, 0.3, 0.14], dur, contact=0.004)
    thump = np.sin(2 * np.pi * (70 + 60 * np.exp(-t / 0.03)) * t) * np.exp(-t / (0.07 * size))
    rattle = bp(white(n, rng), 400, 2200) * np.exp(-t / 0.04) * 0.25
    x = 0.75 * norm(ring) + 0.9 * thump * size ** 0.3 + rattle
    x = lp(x, 2600 / size ** 0.25, 2)
    return Sound(norm(fades(x, 0.0008, 0.15)), onsets=[(0.0, "transient")])


def sfx_car_crash(rng, dur=1.2, weight=1.0):
    """A car collision heard from across the street: a low body thump + a short crunch of bent metal + a few settling
    rattles. Kept dark (low-passed) so it lands as weight, not as a harsh bang (006)."""
    n = nsamp(dur)
    t = tvec(n)
    thump = np.sin(2 * np.pi * (55 + 40 * np.exp(-t / 0.05)) * t) * np.exp(-t / 0.12) * weight
    crunch = bp(white(n, rng), 300, 2600) * np.exp(-t / 0.09)
    metal = modal([173, 412, 689, 1130], [0.25, 0.18, 0.12, 0.08], [0.5, 0.35, 0.25, 0.15], dur) * 0.35
    rattle = np.zeros(n)
    for k in range(5):
        t0 = 0.12 + 0.11 * k + rng.uniform(0, 0.05)
        i0 = nsamp(t0)
        burst = bp(white(nsamp(0.04), rng), 900, 3000) * np.exp(-tvec(nsamp(0.04)) / 0.01) * (0.4 / (k + 1))
        rattle[i0:i0 + len(burst)] += burst[: max(0, n - i0)]
    x = 1.1 * thump + 0.8 * crunch + metal + rattle
    x = lp(x, 3200, 2)
    x = x + 2.0 * convolve(x, outdoor_ir())          # (2, n)
    return Sound(norm(fades(x, 0.001, 0.2), 0.9), anchor=0.0, onsets=[0.0])


def sfx_distant_boom(rng, dur=3.5, size=1.0):
    """A far-away explosion / impact over a city: a slow low rumble with a soft onset (no crack), long outdoor tail (006)."""
    n = nsamp(dur)
    t = tvec(n)
    env = (1 - np.exp(-t / 0.06)) * np.exp(-t / (0.9 * size))
    body = lp(brown(n, rng), 140, 2) * env
    sub = np.sin(2 * np.pi * (38 + 12 * np.exp(-t / 0.4)) * t) * env * 0.6
    x = unit_rms(body) * 0.8 + sub
    x = x + 2.5 * convolve(x, outdoor_ir())          # (2, n)
    return Sound(norm(fades(x, 0.002, 0.5), 0.9), anchor=0.0, onsets=[0.0])


# ---------------------------------------------------------------- Pip the puppy (021): soft puppy voices + a muffled alarm
def sfx_whimper(rng, pitch=1.0, dur=0.45):
    """A puppy's soft whimper (021): a breathy, rounded "hnn" that rises then sags. Low-passed hard so it never pierces —
    keep it at or under the bed (≈ −28…−32 dB)."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    f = 560 * pitch * (1 + 0.18 * np.sin(np.pi * np.clip(u * 1.2, 0, 1)) - 0.12 * u) * (1 + 0.012 * np.sin(2 * np.pi * 11 * t))
    ph = 2 * np.pi * np.cumsum(f) / SR
    v = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)
    breath = bp(pink(n, rng), 700, 2600) * 0.35
    env = np.sin(np.pi * np.clip(u, 0, 1)) ** 1.5
    y = lp((v + breath) * env, 1900, 2)
    return Sound(norm(fades(y, 0.01, 0.06)), onsets=[(0.0, "soft")])


def sfx_puppy_howl(rng, dur=1.3, pitch=1.0):
    """A tiny puppy "awoo" (021): rises, holds with a wobble, falls; nasal but round (low-passed)."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    f = pitch * (430 + 260 * np.sin(np.pi * np.clip(u * 1.6, 0, 1)) ** 0.7 - 140 * np.clip((u - 0.62) / 0.38, 0, 1))
    f *= 1 + 0.02 * np.sin(2 * np.pi * 6.5 * t) * np.clip(u * 3, 0, 1)
    ph = 2 * np.pi * np.cumsum(f) / SR
    v = np.sin(ph) + 0.45 * np.sin(2 * ph) + 0.18 * np.sin(3 * ph)
    v = v + 0.25 * bp(v, 900, 1600)
    env = np.clip(u / 0.12, 0, 1) * np.clip((1 - u) / 0.25, 0, 1)
    y = lp(v * env + 0.1 * bp(pink(n, rng), 600, 2000) * env, 2300, 2)
    return Sound(norm(fades(y, 0.02, 0.08)), onsets=[(0.0, "soft")])


def sfx_alarm_muffled(rng, dur=1.8):
    """A twin-bell wind-up alarm clock ringing under a towel (021): fast hammer strikes on two bells, dulled to a soft
    rattle (low-passed ~1.5 kHz) — the joke is the panic, not the noise. Keep it ≈ −24 dB."""
    n = nsamp(dur)
    t = tvec(n)
    y = np.zeros(n)
    k, rate = 0, 17.0
    while k / rate < dur - 0.05:
        f = 1180 if k % 2 else 1420
        st = nsamp(k / rate)
        m = nsamp(0.18)
        tt = tvec(m)
        hit = (np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * f * 2.7 * tt)) * np.exp(-tt / 0.05)
        y[st:st + m] += hit[: max(0, min(m, n - st))] * rng.uniform(0.8, 1.0)
        k += 1
    y += 0.4 * bp(white(n, rng), 300, 1800) * (0.5 + 0.5 * np.sin(2 * np.pi * rate * t))
    y = lp(y, 1500, 2) * np.clip(t / 0.03, 0, 1) * np.clip((dur - t) / 0.12, 0, 1)
    return Sound(norm(fades(y, 0.002, 0.05)), onsets=[(0.0, "transient")])


def sfx_heartbeat(rng, size=1.0):
    """A soft "lub-dub" (021: the ticking clock that's meant to sound like Mom's heartbeat). Two round low thumps."""
    n = nsamp(0.6)
    t = tvec(n)
    y = np.zeros(n)
    for off, a in ((0.0, 1.0), (0.21, 0.7)):
        k = nsamp(off)
        tt = t[: n - k]
        th = (np.sin(2 * np.pi * 70 * size * tt) + 0.5 * np.sin(2 * np.pi * 140 * size * tt)) * np.exp(-tt / 0.06) * (1 - np.exp(-tt / 0.006))
        y[k:] += a * th
    y = lp(y + 0.15 * lp(white(n, rng), 300) * np.exp(-t / 0.05), 900)
    return Sound(norm(fades(y, 0.001, 0.05)), onsets=[(0.0, "soft")])


# ---- 017 (gravity off): water, a kick, the moment the weight goes away -----------------------------------------------
def sfx_water_splash(rng, dur=1.6, size=1.0):
    """Something big lands in water (017): a low hollow 'whump' + a soft hiss of spray + a few droplets falling back.
    size 0.2 = a coffee splat, 1 = a diver, 3 = the ocean slamming down. Low-passed and round, never a sharp slap."""
    dur = dur * (0.6 + 0.4 * size)
    n = nsamp(dur)
    t = tvec(n)
    whump = np.sin(2 * np.pi * (70 / (0.7 + 0.3 * size) + 60 * np.exp(-t / 0.04)) * t) * np.exp(-t / (0.09 * (0.6 + 0.4 * size)))
    spray = bp(white(n, rng), 600, 4200) * (1 - np.exp(-t / 0.01)) * np.exp(-t / (0.22 * size ** 0.5))
    body = lp(pink(n, rng), 900) * np.exp(-t / (0.35 * size ** 0.6))
    drops = np.zeros(n)
    for k in range(int(10 * min(size, 2) + 4)):
        t0 = 0.15 + rng.uniform(0, dur * 0.6)
        i0 = nsamp(t0); m = nsamp(0.035)
        d = np.sin(2 * np.pi * rng.uniform(700, 1500) * tvec(m) * (1 + 2 * tvec(m))) * np.exp(-tvec(m) / 0.008) * rng.uniform(0.05, 0.15)
        drops[i0:i0 + m] += d[: max(0, n - i0)]
    x = 1.1 * whump + 0.55 * unit_rms(spray) * 0.4 + 0.6 * unit_rms(body) * 0.5 + drops
    x = lp(x, 3600 if size < 2 else 2400, 2)
    x = x + (0.6 + 0.6 * min(size, 2)) * convolve(x, outdoor_ir())
    return Sound(norm(fades(x, 0.001, 0.3), 0.9), anchor=0.0, onsets=[0.0])


def sfx_kick(rng, dur=0.35):
    """A football struck cleanly (017): a short low leather thump with a soft click on top, low-passed."""
    n = nsamp(dur)
    t = tvec(n)
    thump = np.sin(2 * np.pi * (95 + 80 * np.exp(-t / 0.012)) * t) * np.exp(-t / 0.045)
    click = lp(bp(white(n, rng), 1200, 3200) * np.exp(-t / 0.006), 3000) * 0.35
    x = thump + click
    x = x + 0.8 * convolve(x, outdoor_ir())
    return Sound(norm(fades(x, 0.0005, 0.05), 0.85), onsets=[(0.0, "transient")])


def sfx_pressure_drop(rng, dur=2.2):
    """The moment the weight goes away (017): a sub that sinks in pitch + a soft inward rush of filtered air that thins out.
    Peaks at the start (anchor 0) and fades; deep and smooth, no whoosh."""
    n = nsamp(dur)
    t = tvec(n)
    f = 62 * 2 ** (-1.2 * t / dur)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.45 * dur))
    fc = 900 * 2 ** (-2.5 * t / dur)
    air = sweep_filter(pink(n, rng), fc, q=0.7, kind="bp") * (1 - np.exp(-t / 0.05)) * np.exp(-t / (0.3 * dur))
    x = sub + 0.5 * unit_rms(air) * 0.5
    return Sound(norm(fades(x, 0.01, 0.2), 0.9), anchor=0.0, onsets=[(0.0, "soft")])


def amb_surf(dur, rng, size=1.0):
    """Ocean / water bed (017): slow swelling waves of filtered noise every ~5–8 s (size 1 = sea against rocks,
    0.3 = a pool or a fountain's gentle wash). Dark and soft."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        base = 0.55 * brown(n, rng) + 0.45 * pink(n, rng)
        sw = np.zeros(n)
        tt = rng.uniform(0, 2)
        while tt < dur + 6:
            per = rng.uniform(5, 8) / max(0.5, size)
            env = np.exp(-((t - tt) / (0.9 * per * 0.35)) ** 2)
            sw += env * rng.uniform(0.6, 1.0)
            tt += per
        fc = 500 + 1400 * size * np.clip(sw, 0, 1.2)
        y = unit_rms(sweep_filter(base, fc, 0.6, kind="lp")) * (0.35 + 0.65 * np.clip(sw, 0, 1))
        out.append(lp(y, 2600 if size >= 0.6 else 4200))
    return norm(np.vstack(out))


def sfx_candy_rattle(rng, dur=0.8, density=26.0, size=1.0):
    """Wrapped candies pouring into a plastic pail (023): a stream of soft hollow plastic taps (low modal grains) that thins
    out at the end, plus a little crinkle. Low-passed — never clicky-bright; keep it around −30 dB."""
    n = nsamp(dur + 0.25)
    t = tvec(n)
    y = np.zeros(n)
    tk = 0.0
    while tk < dur:
        u = tk / dur
        k = modal([rng.uniform(650, 1050) / size, rng.uniform(1500, 2200) / size], [0.018, 0.008], [1.0, 0.3], 0.07, contact=0.002)
        i0 = nsamp(tk)
        m = min(len(k), n - i0)
        y[i0:i0 + m] += rng.uniform(0.35, 1.0) * (1 - 0.6 * u) * norm(k)[:m]
        tk += rng.exponential(1.0 / density)
    crinkle = bp(white(n, rng), 1200, 3000) * 0.12 * np.clip(1 - t / (dur + 0.1), 0, 1)
    return Sound(norm(fades(lp(y + crinkle, 3000), 0.001, 0.06)), onsets=[(0.0, "transient")])


def sfx_deflate(rng, dur=1.3):
    """A giant lawn inflatable losing its air (023): the blower winds down (a falling low hum), a soft airy hiss, the fabric
    flapping as it folds, and a round floomp when it lands. All low-passed — a comic sigh, not a hiss in the ear."""
    n = nsamp(dur + 0.4)
    t = tvec(n)
    u = np.clip(t / dur, 0, 1)
    hum_f = 95 * (1 - 0.55 * u)
    hum = np.sin(2 * np.pi * np.cumsum(hum_f) / SR) * (1 - u) * 0.5
    hiss = bp(pink(n, rng), 350, 1300) * (1 - u) ** 1.5 * 0.6
    flap = lp(pink(n, rng), 500) * (0.5 + 0.5 * np.sin(2 * np.pi * (7 - 4 * u) * t)) * np.sin(np.pi * u) * 0.8
    land = np.zeros(n)
    k = nsamp(dur * 0.62)
    tt = t[: n - k]
    land[k:] = (np.sin(2 * np.pi * 58 * tt) + 0.4 * lp(white(n - k, rng), 260)) * np.exp(-tt / 0.13) * (1 - np.exp(-tt / 0.01))
    return Sound(norm(fades(lp(hum + hiss + flap + 1.2 * land, 1800), 0.03, 0.15)), onsets=[(0.0, "soft")])


def sfx_bone_clatter(rng, dur=0.9, n_hits=14):
    """A plastic porch skeleton collapsing (023): a quick cascade of hollow plastic clacks (bones hitting the porch boards),
    bunched at the start, plus a skull roll. Soft, woody, low-passed — slapstick, never spooky."""
    n = nsamp(dur + 0.3)
    t = tvec(n)
    y = np.zeros(n)
    for i in range(n_hits):
        tk = dur * (rng.uniform(0, 1) ** 1.8)
        f0 = rng.uniform(280, 620)
        k = modal([f0, f0 * rng.uniform(2.3, 2.8), f0 * 4.1], [0.05, 0.025, 0.012], [1.0, 0.45, 0.15], 0.18, contact=0.003)
        i0 = nsamp(tk)
        m = min(len(k), n - i0)
        y[i0:i0 + m] += rng.uniform(0.4, 1.0) * norm(k)[:m]
    roll = lp(pink(n, rng), 700) * np.clip((t - 0.25) / 0.1, 0, 1) * np.clip((dur + 0.2 - t) / 0.3, 0, 1) * 0.15 * (0.6 + 0.4 * np.sin(2 * np.pi * 9 * t))
    return Sound(norm(fades(lp(y + roll, 2600), 0.001, 0.08)), onsets=[(0.0, "transient")])


def sfx_alarm_beep(rng, dur=1.4, n=3, pitch=1.0):
    """Bedside alarm clock (020): n soft round double-beeps (sine ~1.3 kHz, rounded envelope, low-passed). Gentle, never piercing."""
    ns = nsamp(dur)
    t = tvec(ns)
    y = np.zeros(ns)
    f = 1250.0 * pitch
    for k in range(n):
        for j in range(2):
            t0 = k * 0.42 + j * 0.13
            if t0 > dur - 0.12:
                continue
            e = np.clip((t - t0) / 0.008, 0, 1) * np.exp(-np.clip(t - t0 - 0.05, 0, None) / 0.03) * (t >= t0)
            y += e * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t))
    return Sound(norm(fades(lp(y, 2600), 0.001, 0.03)), onsets=[(0.0, "transient")])


def sfx_scan_beep(rng, pitch=1.0, dur=0.22):
    """Supermarket barcode beep (031): ONE soft round sine "boop" (~880 Hz, rounded 8 ms attack, short decay), low-passed, with
    a faint octave-down body so it reads as a till, not an alarm. Gentle at the house's -30 dB; never piercing."""
    ns = nsamp(dur)
    t = tvec(ns)
    f = 880.0 * pitch
    e = np.clip(t / 0.008, 0, 1) * np.exp(-np.clip(t - 0.07, 0, None) / 0.03)
    y = e * (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 0.5 * f * t) + 0.12 * np.sin(2 * np.pi * 2 * f * t))
    return Sound(norm(fades(lp(y, 2200), 0.001, 0.03)), onsets=[(0.0, "transient")])


def sfx_cartoon_splash(rng, dur=2.2, size=1.0):
    """A big cartoon splash (020; named cartoon_splash — 017's water_splash is a different sound): a soft low 'whump' + a wide burst of filtered water noise that rises then rains back down.
    Everything low-passed (no hiss); size 0.3 = a bucket, 1 = a pool, 2 = an ocean."""
    n = nsamp(dur)
    t = tvec(n)
    whump = np.sin(2 * np.pi * (70 + 40 * np.exp(-t / 0.08)) * t) * np.exp(-t / (0.18 * size)) * 0.8
    burst_env = (1 - np.exp(-t / 0.03)) * np.exp(-t / (0.35 * size))
    burst = lp(hp(white(n, rng), 300), 2600) * burst_env
    rain_env = np.clip((t - 0.35) / 0.3, 0, 1) * np.exp(-np.clip(t - 0.6, 0, None) / (0.5 * size))
    rain = lp(hp(pink(n, rng), 600), 3400) * rain_env * 0.45
    x = unit_rms(burst) * 0.9 + unit_rms(rain) * 0.5 + whump
    return Sound(norm(fades(x, 0.002, 0.3), 0.9), onsets=[(0.0, "transient")])


def amb_room_tone(dur, rng):
    n = nsamp(dur)
    out = []
    for ch in range(2):
        x = 0.75 * brown(n, rng) + 0.5 * pink(n, rng)
        x = hp(lp(x, 380), 28)
        x = unit_rms(x) * (1 + 0.1 * smooth_rand(n, 0.08, rng))
        x += 0.05 * unit_rms(lp(pink(n, rng), 2200))
        out.append(x)
    return norm(np.vstack(out))


def amb_city_day(dur, rng, murmur=0.5, traffic=0.6):
    """Soft daytime street: far traffic rumble + an indistinct crowd murmur (no horns, no birds - house style)."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        rumble = unit_rms(hp(lp(brown(n, rng), 220), 35)) * (1 + 0.25 * smooth_rand(n, 0.07, rng))
        talk = unit_rms(bp(pink(n, rng), 320, 1400)) * (0.6 + 0.4 * np.abs(smooth_rand(n, 3.5, rng)))
        out.append(traffic * rumble + murmur * 0.55 * talk)
    return norm(np.vstack(out))


def amb_cabin_hum(dur, rng):
    """Airliner cabin (010): broadband engine roar, low-passed, plus a faint 115 Hz drone."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        x = unit_rms(lp(pink(n, rng), 900)) + 0.35 * unit_rms(lp(brown(n, rng), 200)) + 0.12 * np.sin(2 * np.pi * 115 * t + ch)
        out.append(x * (1 + 0.04 * smooth_rand(n, 0.3, rng)))
    return norm(np.vstack(out))


def amb_applause(dur, rng, density=40.0, swell=0.6):
    """Crowd applause: many independent hand-claps (short band-passed noise bursts) at `density` claps/s."""
    n = nsamp(dur)
    out = np.zeros((2, n))
    k = nsamp(0.012)
    for ch in range(2):
        imp = (rng.random(n) < density / SR) * rng.uniform(0.3, 1.0, n)
        kern = rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 4.0))
        x = bp(np.convolve(imp, kern)[:n], 700, 3800)
        x += 0.25 * unit_rms(bp(pink(n, rng), 500, 2500)) * np.std(x)
        out[ch] = x
    t = tvec(n)
    out *= (1 - swell) + swell * np.clip(t / max(dur * 0.25, 0.01), 0, 1)
    return norm(out)


def amb_crowd_cheer(dur, rng, excite=1.0):
    """Outdoor crowd celebrating: vowel-ish murmur formants that swell + applause underneath (no screams)."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        v = 0.6 * unit_rms(bp(pink(n, rng), 450, 900)) + 0.4 * unit_rms(bp(pink(n, rng), 1000, 1900))
        v *= 0.55 + 0.45 * np.abs(smooth_rand(n, 2.5, rng))
        out.append(v)
    out = np.vstack(out)
    out = unit_rms(out) * excite + 0.8 * unit_rms(amb_applause(dur, rng, density=55.0))
    return norm(out)


def amb_traffic_flow(dur, rng, density=0.6):
    """Busy-but-calm traffic bed: tyre roar + low engine rumble with slow surges."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        tyre = unit_rms(bp(pink(n, rng), 250, 2200)) * (0.6 + 0.4 * np.abs(smooth_rand(n, 0.5 + density, rng)))
        eng = unit_rms(lp(brown(n, rng), 160))
        out.append(0.7 * tyre + 0.6 * eng)
    return norm(np.vstack(out))


def amb_rocket_rumble(dur, rng, rise=1.0):
    """Rocket launch from a distance: sub rumble swelling in + crackle (the 'tearing' of the exhaust), all low-passed."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        sub = unit_rms(lp(brown(n, rng), 90))
        mid = unit_rms(bp(pink(n, rng), 120, 700))
        imp = (rng.random(n) < 260.0 / SR) * rng.exponential(1.0, n)
        crack = bp(np.convolve(imp, np.exp(-np.arange(nsamp(0.004)) / nsamp(0.0008)))[:n], 300, 2400)
        crack = unit_rms(crack) * (0.5 + 0.5 * np.abs(smooth_rand(n, 6.0, rng)))
        out.append(1.0 * sub + 0.55 * mid + 0.35 * crack)
    out = np.vstack(out) * np.clip(t / max(dur * 0.35 * rise, 0.01), 0, 1) ** 1.5
    return norm(out)


def amb_turbines(dur, rng, rate=0.55):
    """Wind on a roof + the slow rhythmic swish of distant turbine blades."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        wind = unit_rms(lp(pink(n, rng), 700)) * (0.7 + 0.3 * smooth_rand(n, 0.2, rng))
        sw = unit_rms(bp(pink(n, rng), 300, 1400)) * (0.5 + 0.5 * np.sin(2 * np.pi * rate * t + ch * 1.3)) ** 3
        out.append(0.8 * wind + 0.5 * sw)
    return norm(np.vstack(out))


def amb_crickets(dur, rng, count=4, density=0.6, fc_range=(3700, 4700)):
    """Distant summer crickets heard through a window: sparse chirp bouts, lowpassed, outdoor verb."""
    n = nsamp(dur)
    t = tvec(n)
    out = np.zeros((2, n))
    for i in range(count):
        r = seeded("cricket", i, int(rng.integers(1 << 30)))
        fc = r.uniform(*fc_range)
        prate = r.uniform(26, 34)
        pulses = int(r.integers(3, 6))
        plen = r.uniform(0.012, 0.018)
        period = r.uniform(0.45, 0.95)
        kl = nsamp(plen)
        win = np.hanning(kl)
        env = np.zeros(n)
        tc = r.uniform(0, period)
        on = r.random() < density
        bout_end = tc + r.uniform(2.0, 7.0)
        while tc < dur:
            if tc > bout_end:
                on = r.random() < density
                bout_end = tc + (r.uniform(2.0, 7.0) if on else r.uniform(1.0, 4.0))
            if on:
                for p in range(pulses):
                    s = nsamp(tc + p / prate)
                    if s + kl < n:
                        env[s:s + kl] += max(0.2, 1 - 0.12 * p + r.normal(0, 0.05)) * win
            tc += period * r.uniform(0.92, 1.08)
        car = np.sin(2 * np.pi * fc * t + 0.4 * np.sin(2 * np.pi * prate * t))
        car += 0.05 * np.sin(4 * np.pi * fc * t)
        out += pan2(env * car * r.uniform(0.4, 1.0), r.uniform(-0.7, 0.7))
    out = lp(hp(out, 1200), 5200, order=1)
    out = out + db2lin(-7) * convolve(out, outdoor_ir()) * 3.0
    return norm(out)


def clock_tick_one(rng, tock=False):
    s = rng.uniform(0.98, 1.02) * (0.86 if tock else 1.0)
    y = norm(modal(np.array([2900, 4300, 6100]) * s, [0.005, 0.004, 0.003], [1.0, 0.6, 0.3], 0.08, contact=0.0003))
    y += 0.5 * norm(modal([620 * s, 1240 * s], [0.014, 0.009], [1.0, 0.5], 0.08, contact=0.0007))
    return fades(lp(y, 9000), 0.0003, 0.01)


def amb_clock(dur, rng, rate=1.0, offset=0.35):
    n = nsamp(dur)
    y = np.zeros(n)
    k = 0
    tt = offset
    while tt < dur - 0.1:
        x = clock_tick_one(rng, tock=bool(k % 2)) * rng.uniform(0.9, 1.0)
        s = nsamp(tt)
        y[s:s + len(x)] += x[: n - s]
        k += 1
        tt = offset + k / rate
    y = y + 0.25 * convolve(y, room_ir())[0]
    return norm(y)


def amb_rain_window(dur, rng, intensity=1.0):
    n = nsamp(dur)
    out = []
    for ch in range(2):
        wash = unit_rms(bp(pink(n, rng), 350, 4500)) * (0.85 + 0.15 * smooth_rand(n, 0.3, rng))
        imp = (rng.random(n) < 160 * intensity / SR) * rng.exponential(1.0, n) ** 1.6
        k = nsamp(0.003)
        kern = rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 6.0))
        drops = unit_rms(bp(np.convolve(imp, kern)[:n], 1800, 7000))
        timp = (rng.random(n) < 4.0 * intensity / SR) * rng.uniform(0.3, 1.0, n)
        taps = resonate(timp, [2200 * rng.uniform(0.9, 1.1), 3400, 4700], [18, 18, 18], [1, 0.6, 0.4])
        taps = unit_rms(taps) if np.any(taps) else taps
        out.append(lp(0.55 * wash + 0.5 * drops + 0.25 * taps, 7000))
    return norm(np.vstack(out))


def amb_wind(dur, rng, darkness=0.5, gust=0.5, whistle=0.15):
    """Soft wind. darkness 0..1 (1 = low hush), gust 0..1, whistle = narrow resonance amount."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        base = 0.6 * brown(n, rng) + 0.4 * pink(n, rng)
        m = smooth_rand(n, 0.18, rng)
        m2 = smooth_rand(n, 0.6, rng)
        f0 = 180 + 650 * (1 - darkness)
        fc = f0 * 2 ** (0.6 * m + 0.2 * m2)
        y = unit_rms(sweep_filter(base, fc, 0.8)) + 0.5 * unit_rms(lp(base, f0 * 0.8))
        if whistle > 0:
            y += whistle * unit_rms(sweep_filter(white(n, rng), fc * 2.3, 18.0))
        y *= 0.6 + 0.4 * gust * (0.5 + 0.5 * m) + 0.15 * gust * m2
        out.append(lp(y, 6000 - 3500 * darkness))
    return norm(np.vstack(out))


def amb_dry_leaves(dur, rng, density=1.0):
    """Dry leaves skittering outside (granular crackle clusters, gust-coupled, through a window)."""
    n = nsamp(dur)
    g = np.clip(0.3 + 0.7 * smooth_rand(n, 0.7, rng, 0, 1), 0, 1)
    out = []
    for ch in range(2):
        imp = np.zeros(n)
        ev = np.nonzero(rng.random(n) < 18 * density * g / SR)[0]
        for e in ev:
            for _ in range(int(rng.integers(3, 9))):
                k = e + nsamp(rng.uniform(0, 0.035))
                if k < n:
                    imp[k] += rng.uniform(0.2, 1.0)
        k = nsamp(0.0012)
        kern = rng.standard_normal(k) * np.exp(-np.arange(k) / (k / 4.0))
        y = bp(np.convolve(imp, kern)[:n], 1200, 6000)
        y = resonate(y, [2300, 3600], [4, 4], [0.6, 0.4]) + 0.5 * y
        out.append(lp(y, 5000))
    return norm(np.vstack(out))


def amb_kids_laugh(dur, rng, density=1.0):
    """044: kids giggling in the snow, at a distance — bursts of "ha-ha-ha" (a voiced buzz at a child's pitch through soft
    'ah' formants), panned around, low-passed so it never pierces. A crowd-voice bed lifts a beat (036) without speech."""
    n = nsamp(dur)
    out = np.zeros((2, n))
    tt = rng.uniform(0.05, 0.4)
    while tt < dur - 0.6:
        syl = int(rng.integers(3, 7)); f0 = rng.uniform(300, 430); pan = rng.uniform(-0.8, 0.8); g = rng.uniform(0.5, 1.0)
        L = syl * 0.15 + 0.1; m = nsamp(L); t = tvec(m)
        f = f0 * (1.0 - 0.18 * t / L) * (1 + 0.02 * np.sin(2 * np.pi * 6 * t))
        ph = 2 * np.pi * np.cumsum(f) / SR
        buzz = sum(np.sin(k * ph) / k for k in range(1, 9))
        v = 0.6 * bp(buzz, 800, 1300) + 0.45 * bp(buzz, 1500, 2300) + 0.25 * bp(pink(m, rng), 900, 2500)
        env = np.zeros(m)
        for k in range(syl):
            a = nsamp(k * 0.15); b = min(m, a + nsamp(0.1))
            env[a:b] = np.sin(np.linspace(0, np.pi, b - a)) ** 1.2 * (1 - 0.1 * k)
        y = lp(v * env * g, 3200)
        s0 = nsamp(tt); e0 = min(n, s0 + m)
        out[0, s0:e0] += y[: e0 - s0] * (1 - pan) * 0.5
        out[1, s0:e0] += y[: e0 - s0] * (1 + pan) * 0.5
        tt += L + rng.uniform(0.3, 1.6) / max(0.2, density)
    return norm(out)


def sfx_sneeze(rng, pitch=1.0):
    """044: a puppy's cartoon sneeze — a breathy rising "ah-" then a short soft "choo" (noise burst + a tiny voiced 'oo').
    Low-passed: cute, never a honk. Keep it ≈ −26…−30 dB."""
    a, c = 0.32, 0.22
    n1 = nsamp(a); t1 = tvec(n1); u = t1 / a
    f = 520 * pitch * (1 + 0.35 * u)
    ph = 2 * np.pi * np.cumsum(f) / SR
    ah = (np.sin(ph) + 0.3 * np.sin(2 * ph)) * 0.35 + bp(pink(n1, rng), 600, 2200) * 0.5
    ah = ah * (u ** 1.5) * (1 - u * 0.2)
    n2 = nsamp(c); t2 = tvec(n2); w = t2 / c
    ch = bp(pink(n2, rng), 1200, 3800) * 1.4 * np.exp(-w * 5) * np.clip(w * 40, 0, 1)
    f2 = 700 * pitch * (1 - 0.3 * w); ph2 = 2 * np.pi * np.cumsum(f2) / SR
    ch = ch + 0.5 * np.sin(ph2) * np.exp(-w * 7) * np.clip(w * 30, 0, 1)
    y = lp(np.concatenate([ah, ch]), 3600, 2)
    return Sound(norm(fades(y, 0.01, 0.05)), onsets=[(a, "soft")])


def amb_sleigh_bells(dur, rng, period=0.33):
    """Very faint distant sleigh bells passing by (stereo pan sweep, outdoor reverb)."""
    n = nsamp(dur)
    bells = []
    for b in range(6):
        f = rng.uniform(2600, 4200)
        bells.append(modal(f * np.array([1, 1.52, 2.11, 2.63, 3.4]),
                           np.array([0.12, 0.08, 0.06, 0.045, 0.03]) * rng.uniform(0.8, 1.2),
                           [1, 0.6, 0.45, 0.3, 0.2], 0.3, contact=0.0002))
    imps = np.zeros((6, n))
    tt = rng.uniform(0, 0.1)
    k = 0
    while tt < dur - 0.3:
        acc = 1.0 if k % 2 == 0 else 0.7
        for _ in range(int(rng.integers(6, 11))):
            s = nsamp(tt + rng.uniform(0, 0.035))
            imps[int(rng.integers(6)), s] += acc * rng.uniform(0.3, 1.0)
        k += 1
        tt += period * (1.08 if k % 2 else 0.92)
    y = sum(signal.fftconvolve(imps[i], bells[i])[:n] for i in range(6))
    y = lp(y, 6500)
    tn = np.linspace(0, 1, n)
    env = np.sin(np.pi * tn) ** 1.5
    th = (np.linspace(-0.5, 0.4, n) + 1) * np.pi / 4
    st = np.vstack([y * env * np.cos(th), y * env * np.sin(th)])
    st = st + 2.5 * convolve(st, outdoor_ir())
    return norm(st)


def amb_lamp_hum(dur, rng):
    n = nsamp(dur)
    t = tvec(n)
    y = sum(a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) for f, a in ((120, 1.0), (240, 0.4), (360, 0.2),
                                                                                (480, 0.1)))
    buzz = bp(white(n, rng), 100, 500) * (0.5 + 0.5 * np.sin(2 * np.pi * 120 * t))
    y = lp(unit_rms(y) + 0.15 * unit_rms(buzz), 1200)
    return norm(pan2(y, 0.25))


AMBIENCE = {
    "room_tone": amb_room_tone,
    "applause": amb_applause,
    "cabin_hum": amb_cabin_hum,
    "crowd_cheer": amb_crowd_cheer,
    "traffic_flow": amb_traffic_flow,
    "rocket_rumble": amb_rocket_rumble,
    "turbines": amb_turbines,
    "city_day": amb_city_day,
    "crickets": amb_crickets,
    "clock": amb_clock,
    "rain_window": amb_rain_window,
    "wind": amb_wind,
    "dry_leaves": amb_dry_leaves,
    "sleigh_bells": amb_sleigh_bells,
    "lamp_hum": amb_lamp_hum,
    "surf": amb_surf,
    "kids_laugh": amb_kids_laugh,   # 044 (snow day)
}

# =============================================================================
# 5. Music: piano, pad, composer
# =============================================================================

_PIANO_CACHE = {}


def piano_note(midi, vel, hold):
    """Additive piano: inharmonic partials (f_n = n f0 sqrt(1 + B n^2)), hammer-position comb,
    velocity-dependent brightness, two-stage per-partial decay, 1-3 detuned unison strings,
    hammer knock noise, damper after `hold` seconds (hold includes sustain-pedal time)."""
    key = (int(midi), round(float(vel), 2), round(float(hold), 2))
    if key in _PIANO_CACHE:
        return _PIANO_CACHE[key]
    midi, vel, hold = key
    rng = seeded("piano", key)
    f0 = mtof(midi)
    B = float(np.clip(2.6e-4 * 2 ** ((midi - 60) / 13.0), 5e-5, 8e-3))
    tau = float(np.clip(3.2 * 2 ** (-(midi - 48) / 20.0), 0.3, 8.0))
    tau_d = 0.07 + 0.22 * float(np.clip((60 - midi) / 30.0, 0, 1))
    if midi >= 89:
        tau_d = tau
    ring = min(hold + 6.0 * tau_d, 7.0 * tau)
    L = nsamp(ring + 0.02)
    t = tvec(L)
    x0 = 0.118 + rng.uniform(-0.01, 0.01)
    p = 1.45 - 0.7 * vel
    fc = 650 + 5000 * vel ** 1.6 + 1.5 * f0
    nmax = 64 if midi < 40 else 40
    ns = np.arange(1, nmax + 1)
    fn = ns * f0 * np.sqrt(1 + B * ns ** 2)
    keep = fn < 15000
    a = (np.abs(np.sin(np.pi * ns * x0)) + 0.04) * ns ** (-p) / np.sqrt(1 + (fn / fc) ** 4)
    a = np.where(keep, a, 0.0)
    a /= np.sqrt(np.sum(a ** 2))
    tau_n = tau / (1 + (fn / 1500.0) ** 1.25 + 0.02 * (ns - 1))
    w = 0.62
    nstr = 1 if midi < 32 else (2 if midi < 45 else 3)
    det = rng.uniform(0.25, 1.1)  # cents between outer strings
    amax = a.max()
    phs = rng.uniform(0, 2 * np.pi, nmax)
    y = np.zeros(L)
    for i in np.nonzero(keep)[0]:
        tn = tau_n[i]
        tlim = tn * np.log(max(a[i] / amax * (1 - w), 1e-12) / 1e-4)
        if tlim <= 0.005:
            continue
        m = min(L, nsamp(tlim))
        tt = t[:m]
        env = w * np.exp(-tt / (tn * 0.16)) + (1 - w) * np.exp(-tt / tn)
        om = 2 * np.pi * fn[i]
        osc = np.sin(om * tt + (0.0 if i == 0 else phs[i]))
        if nstr > 1:
            dd = om * (2 ** (det / 2400.0) - 1)
            beat = np.cos(dd * tt + (0.3 * i if nstr == 3 else 0.0))
            osc = osc * ((1 + 2 * beat) / 3.0 if nstr == 3 else beat)
        y[:m] += a[i] * env * osc
    ta = 0.0045 - 0.003 * vel
    na = nsamp(ta)
    y[:na] *= (1 - np.cos(np.pi * np.arange(na) / na)) * 0.5
    kn = min(L, nsamp(0.03))
    nz = rng.standard_normal(kn) * np.exp(-np.arange(kn) / nsamp(0.006))
    nz = lp(nz, 900 + 2500 * vel)
    y[:kn] += 0.05 * (0.4 + vel) * nz / (np.std(nz) + 1e-12) * np.exp(-np.arange(kn) / nsamp(0.004))
    hs = nsamp(hold)
    if hs < L:
        y[hs:] *= np.exp(-np.arange(L - hs) / SR / tau_d)
    y = fades(y, 0.0, 0.015) * 0.5 * vel ** 1.5 * db2lin(1.5 * (midi - 60) / 12.0)
    _PIANO_CACHE[key] = y
    return y


_PLUCK_CACHE = {}


def pluck_note(midi, vel, hold, kind="pluck"):
    """Soft electronic voice (non-piano identity for sims / tech / wonder videos).
    kind 'pluck': warm detuned triangle-ish pluck (fast attack, exp decay, filter closes as it decays).
    kind 'bell' : glassy FM-ish bell (sine carrier + one inharmonic partial), long tail. Mono, peak ~1."""
    key = (int(midi), round(float(vel), 2), round(float(hold), 2), kind)
    if key in _PLUCK_CACHE:
        return _PLUCK_CACHE[key]
    f0 = mtof(midi)
    ring = min(max(hold, 0.25) + (1.6 if kind == "pluck" else 3.0), 6.0)
    n = nsamp(ring)
    t = tvec(n)
    if kind == "bell":
        y = np.sin(2 * np.pi * f0 * t) + 0.35 * np.sin(2 * np.pi * f0 * 2.76 * t) * np.exp(-t / 0.6) + 0.12 * np.sin(2 * np.pi * f0 * 5.4 * t) * np.exp(-t / 0.25)
        env = (1 - np.exp(-t / 0.004)) * np.exp(-t / 1.4)
    else:
        y = np.zeros(n)
        for det in (-4.0, 0.0, 4.0):                                   # 3 slightly detuned voices
            ph = 2 * np.pi * f0 * 2 ** (det / 1200) * t
            y += np.sin(ph) + 0.22 * np.sin(3 * ph) / 3 + 0.12 * np.sin(2 * ph)
        y /= 3
        env = (1 - np.exp(-t / 0.003)) * np.exp(-t / (0.28 + 0.5 * (1 - vel)))
        rel = np.clip((t - hold) / 0.25, 0, 1)
        env *= np.where(t < hold, 1.0, np.cos(np.pi / 2 * rel) ** 2) * 0.6 + 0.4 * np.exp(-t / 0.18)
    y = lp(y * env * (0.35 + 0.65 * vel), 900 + 3800 * vel, 2)
    y = fades(norm(y) * vel, 0.001, 0.05)
    _PLUCK_CACHE[key] = y
    return y


def echo(x, delay=0.375, feedback=0.35, mix=0.28, lp_hz=3200):
    """Ping-pong echo (L at d, R at 2d, …), darker each repeat — gives the synth voice its space."""
    out = x.copy()
    d = nsamp(delay)
    tap = lp(x.mean(axis=0), lp_hz)
    g = mix
    for k in range(1, 7):
        ch = (k - 1) % 2
        sh = d * k
        if sh >= x.shape[1]:
            break
        out[ch, sh:] += g * tap[:x.shape[1] - sh]
        tap = lp(tap, lp_hz * 0.85)
        g *= feedback
    return out


def saw_blep(freq, n, phase0=0.0):
    dt = np.broadcast_to(np.asarray(freq, float) / SR, (n,))
    ph = (phase0 + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    y[m] -= x * x + x + x + 1
    return y


NOTE_PC = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
           "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUALITY = {"": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11],
           "sus4": [0, 5, 7], "sus2": [0, 2, 7], "add9": [0, 4, 7, 14], "dim": [0, 3, 6]}


def parse_chord(sym):
    main, _, slash = sym.partition("/")
    root = main[:2] if len(main) > 1 and main[1] in "b#" else main[:1]
    q = main[len(root):]
    rpc = NOTE_PC[root]
    pcs = sorted({(rpc + i) % 12 for i in QUALITY[q]})
    return rpc, pcs, (NOTE_PC[slash] if slash else rpc)


def pitches_in(pcs, lo, hi):
    return [m for m in range(lo, hi + 1) if m % 12 in pcs]


def voicing(sym):
    """bass (34..45), LH open voicing [bass, c1, c3, c4], RH close triad around A4, pad notes."""
    rpc, pcs, bpc = parse_chord(sym)
    bass = pitches_in([bpc], 34, 45)[0]
    cands = pitches_in(pcs, bass + 5, bass + 26)
    lh = [bass, cands[0], cands[2], cands[3]]
    rh = sorted(sorted(pitches_in(pcs, 64, 76), key=lambda m: abs(m - 69))[:3])
    pad = pitches_in(pcs, 52, 69)
    return {"bass": bass, "lh": lh, "rh": rh, "pad": pad}


def interp_bp(points, t):
    if isinstance(points, (int, float)):
        return float(points)
    ts = [p[0] for p in points]
    vs = [p[1] for p in points]
    return float(np.interp(t, ts, vs))


def compose(M, mallet=None, strings=None):
    """Turn chord timeline + section styles + explicit melody into a note list.
    Each note: (t, midi, vel, hold). Sustain pedal changes at every chord change.
    Mallet notes (style "ostinato" with inst "mallet", and M["mallet_melody"]) go to the `mallet` list if one is passed."""
    mallet = [] if mallet is None else mallet
    strings = [] if strings is None else strings
    chords = sorted(M["chords"], key=lambda c: c[0])
    end = M.get("end", 62.0)
    ctimes = [c[0] for c in chords] + [end]
    notes = []

    def pedal_up(t):
        for ct in ctimes:
            if ct > t + 1e-6:
                return ct + 0.06
        return end

    def section_at(t):
        for s in M["sections"]:
            if s["t0"] - 1e-6 <= t < s["t1"] - 1e-6:
                return s
        return None

    def add(t, m, v, hold=None):
        h = (pedal_up(t) - t) if hold is None else hold
        notes.append((round(t, 4), int(m), float(np.clip(v, 0.05, 1.0)), max(0.12, min(h, end - t + 0.5))))

    def adds(t, m, v, hold):
        strings.append((round(t, 4), int(m), float(np.clip(v, 0.05, 1.0)), max(0.05, hold)))

    def addm(t, m, v, hold):
        mallet.append((round(t, 4), int(m), float(np.clip(v, 0.05, 1.0)), max(0.06, hold)))

    for i, (t0, sym) in enumerate(chords):
        t1 = ctimes[i + 1]
        span = t1 - t0
        # M["layers"] (017): extra sections drawn on top of the main one (e.g. a low string drive under a pluck arp)
        for S in [s for s in [section_at(t0)] + [x for x in M.get("layers", []) if x["t0"] - 1e-6 <= t0 < x["t1"] - 1e-6] if s is not None]:
            V = voicing(sym)
            v = interp_bp(S.get("vel", 0.25), t0)
            st = S["style"]
            roll = S.get("roll", 0.06)
            if st == "held":
                for k, m in enumerate(V["lh"][:3]):
                    add(t0 + k * roll, m, v * (1.0 - 0.12 * k))
            elif st == "thin":
                add(t0, V["bass"], v)
                add(t0 + roll, V["lh"][1], v * 0.8)
            elif st == "sparse":
                add(t0, V["bass"] + 12, v * 0.9)
            elif st in ("arp", "swell"):
                step = S.get("step", 0.444)
                pat = S.get("pattern", [0, 1, 2, 3, 2, 1])
                nst = max(1, int(round(span / step)))
                stp = span / nst
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.25), tk) * (1.0 if k == 0 else 0.78 - 0.04 * (k % 2))
                    add(tk, V["lh"][pat[k % len(pat)]], vk)
                if st == "swell":
                    if V["bass"] - 12 >= 33:  # sub-octave only where it stays out of the mud
                        add(t0, V["bass"] - 12, v * 0.65)
                    for k, m in enumerate(V["rh"]):
                        add(t0 + 0.03 + 0.025 * k, m, v * 0.5)
            elif st == "pulse":
                step = S.get("step", 0.5)
                if S.get("step_last") and abs(t1 - S["t1"]) < 1e-6:
                    step = S["step_last"]
                nst = max(1, int(round(span / step)))
                stp = span / nst
                add(t0, V["bass"], v * 0.9)
                if i > 0 and chords[i - 1][0] >= S["t0"]:
                    add(t0 + 0.02, V["bass"] + 12, v * 0.6)
                top = V["rh"]
                pair = [top[0], top[1]] if len(top) >= 2 else top
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.25), tk) * (0.95 if k % 2 == 0 else 0.78)
                    for m in pair:
                        add(tk, m, vk * 0.75, hold=min(stp * 1.6, pedal_up(tk) - tk))
            elif st == "bounce":
                # comedy "oom-pah": short bass on beats 1+3, short soft chord stabs on 2+4 (staccato, no pedal smear)
                step = S.get("step", 0.5)
                nst = max(1, int(round(span / step)))
                stp = span / nst
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.25), tk)
                    # note lengths as a fraction of the beat; long enough that the groove never sounds like it cuts out
                    if k % 2 == 0:
                        add(tk, V["bass"] if k % 4 == 0 else V["bass"] + 7 if V["bass"] + 7 < 60 else V["bass"], vk * 0.85, hold=stp * S.get("bass_hold", 1.6))
                    else:
                        for j, m in enumerate(V["rh"][:3]):
                            add(tk + 0.008 * j, m, vk * 0.5, hold=stp * S.get("stab_hold", 0.8))
            elif st == "strings":
                # dramatic tone: low spiccato string ostinato on the chord (tones = [bass, chord tones...] + `octave`*12),
                # `accent` = per-step velocity multipliers; `sustain` adds a held upper string chord per chord change.
                step = S.get("step", 0.125)
                nst = max(1, int(round(span / step)))
                stp = span / nst
                tones = [m + 12 * S.get("octave", 0) for m in V["lh"]]
                pat = S.get("pattern", [0, 0, 1, 0, 2, 0, 1, 0])
                acc = S.get("accent", [1.0, 0.7, 0.8, 0.7])
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.3), tk) * acc[k % len(acc)]
                    adds(tk, tones[pat[k % len(pat)] % len(tones)], vk, stp * S.get("len", 0.6))
                if S.get("sustain"):
                    for j, m in enumerate(V["rh"]):
                        adds(t0 + 0.01 * j, m - 12 + 12 * S.get("sustain_octave", 0), interp_bp(S.get("vel", 0.3), t0) * S["sustain"], span)
            elif st == "ostinato":
                # world/explainer tone: a steady, curious repeating figure (default on the soft mallet) over chord tones,
                # + a short piano bass note every `bass_every` steps. pattern indexes [rh triad, rh triad + 12].
                step = S.get("step", 0.27)
                nst = max(1, int(round(span / step)))
                stp = span / nst
                tones = V["rh"] + [m + 12 for m in V["rh"]]
                pat = S.get("pattern", [0, 1, 2, 4, 2, 1])
                be = S.get("bass_every", 4)
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.25), tk) * (1.0 if k % 2 == 0 else 0.82)
                    m = tones[pat[(k + int(round((t0 - S["t0"]) / stp))) % len(pat)] % len(tones)] + S.get("transpose", 0)
                    if S.get("inst", "mallet") == "mallet":
                        addm(tk, m, vk, stp * S.get("len", 0.9))
                    else:
                        add(tk, m, vk * 0.8, hold=stp * S.get("len", 0.9))
                    if be and k % be == 0:
                        add(tk, V["bass"], interp_bp(S.get("vel", 0.25), tk) * S.get("bass_vel", 0.8), hold=stp * be * 0.9)
            elif st == "cadence":
                for k, m in enumerate(V["lh"][:3]):
                    add(t0 + k * roll, m, v * (1.0 - 0.1 * k))
                for k, m in enumerate(V["rh"]):
                    add(t0 + 3 * roll + k * roll * 0.7, m, v * 0.7)
            elif st == "walk":
                # 016 "gossip jazz": a walking bass in quarter notes (root, two chord tones, a chromatic step into the next
                # chord's root) + soft piano comps on beats 2 and 4, pushed a little late (`swing`, in steps) for a lazy shuffle.
                step = S.get("step", 0.5)
                nst = max(1, int(round(span / step)))
                stp = span / nst
                nb = voicing(chords[i + 1][1])["bass"] if i + 1 < len(chords) else V["bass"]
                line = [V["bass"], V["lh"][1], V["lh"][2] if V["lh"][2] < 58 else V["lh"][2] - 12, nb - 1 if nb > V["bass"] else nb + 1]
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.25), tk)
                    bm = line[k % 4] if k < nst - 1 or nst < 4 else line[3]
                    add(tk, bm, vk * S.get("bass_vel", 0.9), hold=stp * S.get("bass_hold", 0.95))
                    if k % 2 == 1:
                        for j, m in enumerate(V["rh"][:3]):
                            add(tk + stp * S.get("swing", 0.12) + 0.01 * j, m, vk * S.get("comp_vel", 0.42), hold=stp * S.get("stab_hold", 0.75))
            elif st == "disco":
                # dance tone (019, "piano house"): an octave-bouncing bass in 8ths (low, high, low, high …) + soft chord stabs on
                # every off-beat "and". step = one 8th (0.25 s at 120 bpm). stab_vel/stab_hold/bass_hold shape it; stabs: false = bass only.
                step = S.get("step", 0.25)
                nst = max(1, int(round(span / step)))
                stp = span / nst
                for k in range(nst):
                    tk = t0 + k * stp
                    vk = interp_bp(S.get("vel", 0.3), tk)
                    add(tk, V["bass"] + (12 if k % 2 else 0), vk * (0.95 if k % 2 == 0 else 0.72), hold=stp * S.get("bass_hold", 0.9))
                    if k % 2 == 1 and S.get("stabs", True):
                        for j, m in enumerate(V["rh"][:3]):
                            add(tk + 0.006 * j, m, vk * S.get("stab_vel", 0.45), hold=stp * S.get("stab_hold", 0.75))
    for mel in M.get("melody", []):
        t, m, v = mel[0], mel[1], mel[2]
        octv = len(mel) > 3 and mel[3]
        add(t, m, v, hold=mel[4] if len(mel) > 4 else None)  # 5th element = note length (s) for staccato lines
        if octv:
            add(t + 0.012, m + 12, v * 0.62)
    for s in M.get("stings", []):
        add(s["t"], s["midi"], s["vel"], hold=s.get("hold"))
    for mm in M.get("mallet_melody", []):     # [t, midi, vel, len]
        addm(mm[0], mm[1], mm[2], mm[3] if len(mm) > 3 else 0.35)
    return sorted(notes)


def render_pad(regions, n_total):
    """Warm string pad: 3 detuned PolyBLEP saws per note per channel, lowpassed, slow attack."""
    out = np.zeros((2, n_total))
    for ri, r in enumerate(regions):
        rng = seeded("pad", ri, r["t0"])
        notes = r.get("notes") or voicing(r["chord"])["pad"]
        att, rel = r.get("attack", 1.5), r.get("release", 1.2)
        length = r["t1"] - r["t0"] + rel
        n = nsamp(length)
        t = tvec(n)
        env = np.sin(np.pi / 2 * np.clip(t / att, 0, 1)) ** 2
        tr = r["t1"] - r["t0"]
        env *= np.where(t < tr, 1.0, np.cos(np.pi / 2 * np.clip((t - tr) / rel, 0, 1)) ** 2)
        y = np.zeros((2, n))
        for m in notes:
            f = mtof(m)
            for ch, dets in enumerate(((-9, 0.5, 7), (-6, 1.5, 9.5))):
                vib = 1 + 0.0015 * np.sin(2 * np.pi * rng.uniform(0.15, 0.3) * t + rng.uniform(0, 6))
                for c in dets:
                    y[ch] += saw_blep(f * 2 ** (c / 1200) * vib, n, rng.uniform())
        y *= 0.05 / np.sqrt(len(notes) * 3)  # ~ -30 LUFS at level 1.0
        cut = r.get("cutoff", 1500)
        y = hp(lp(lp(y, cut), cut * 1.6), r.get("hp", 110))   # "hp": 30 for sub drones / braams
        y *= env * r.get("level", 1.0)
        place(out, fades(y, 0.01, 0.05), nsamp(r["t0"]))
    return out


def leveler(x, thr_rel_db=4.0, ratio=2.0, tau=0.25):
    """Slow, zero-phase RMS leveller (gentle glue for the music bus). Threshold is relative to the
    median level of the active signal, so it is independent of gain staging."""
    p = np.mean(x ** 2, axis=0)
    a = np.exp(-1.0 / (tau * SR))
    env = signal.filtfilt([1 - a], [1, -a], p)
    lvl = 10 * np.log10(np.maximum(env, 1e-14))
    act = lvl > np.max(lvl) - 45
    thr = np.median(lvl[act]) + thr_rel_db
    gr = -np.maximum(0.0, lvl - thr) * (1 - 1.0 / ratio)
    return x * db2lin(gr), float(-gr.min())


def render_music(M, n_total, log=print):
    mallet, strs = [], []
    notes = compose(M, mallet, strs)
    dry = np.zeros((2, n_total))
    t0 = time.time()
    inst = M.get("instrument", "piano")      # per-video sound identity: piano (emotional/funny) | pluck | bell (sims, tech, wonder)
    for (t, m, v, h) in notes:
        y = piano_note(m, v, h) if inst == "piano" else pluck_note(m, v, h, inst)
        place(dry, pan2(y, float(np.clip((m - 62) / 34.0, -0.4, 0.4))), nsamp(t))
    log(f"  piano: {len(notes)} notes ({len(_PIANO_CACHE)} unique) in {time.time() - t0:.1f}s")
    if M.get("echo") and M.get("echo_notes_only"):     # 017: echo the plucks only, not the strings/drums added below
        dry = echo(dry, **M["echo"])
    if mallet:
        md = np.zeros((2, n_total))
        for k, (t, m, v, h) in enumerate(mallet):
            place(md, pan2(mallet_note(m, v, h), float(np.clip((m - 70) / 30.0, -0.3, 0.3)) * (1 if k % 2 else -1)), nsamp(t))
        dry += db2lin(M.get("mallet_db", -4.0)) * md
        log(f"  mallet: {len(mallet)} notes")
    if M.get("bell_melody"):            # 021: a music-box line (celesta voice) over the piano: [[t, midi, vel, dur], ...]
        bd = np.zeros((2, n_total))
        for k, b in enumerate(M["bell_melody"]):
            place(bd, pan2(celesta_note(int(b[1]), float(b[2]), float(b[3]) if len(b) > 3 else 1.8, M.get("bell_decay", 1.0)), 0.12 * (1 if k % 2 else -1)), nsamp(b[0]))
        dry += db2lin(M.get("bell_db", -4.0)) * lp(bd, M.get("bell_lp", 5000))
        log(f"  music box: {len(M['bell_melody'])} notes")
    if strs:
        sd = np.zeros((2, n_total))
        for k, (t, m, v, h) in enumerate(strs):
            place(sd, pan2(string_note(m, v, h), float(np.clip((m - 50) / 40.0, -0.35, 0.35))), nsamp(t))
        dry += db2lin(M.get("strings_db", 0.0)) * sd
        log(f"  strings: {len(strs)} notes")
    hits = [list(h) for h in M.get("drums", [])]          # [t, vel, kind]
    for P in M.get("drum_patterns", []):                  # {t0, t1, step, pattern: [vel mult...], vel, kind}
        nst = int(round((P["t1"] - P["t0"]) / P["step"]))
        for k in range(nst):
            a = P["pattern"][k % len(P["pattern"])]
            if a > 0:
                tk = P["t0"] + k * P["step"]
                hits.append([tk, interp_bp(P.get("vel", 0.5), tk) * a, P.get("kind", "taiko")])
    if hits:
        dd = np.zeros((2, n_total))
        for (t, v, kind) in hits:
            place(dd, pan2(drum_hit(kind, round(float(np.clip(v, 0.05, 1.0)), 2)), 0.0), nsamp(t))
        dd = dd + db2lin(-8.0) * convolve(dd, hall_ir())
        dry += db2lin(M.get("drums_db", -2.0)) * dd
        log(f"  drums: {len(hits)} hits")
    if M.get("echo") and not M.get("echo_notes_only"):
        dry = echo(dry, **M["echo"])
    piano = dry + db2lin(M.get("reverb_db", -9)) * convolve(dry, hall_ir())
    pad = render_pad(M.get("pad", []), n_total)
    pad = pad + db2lin(M.get("pad_reverb_db", -5)) * convolve(pad, hall_ir())
    music = piano + db2lin(M.get("pad_db", -6)) * pad
    if M.get("leveler"):
        music, lg = leveler(music, **M["leveler"])
        log(f"  music leveller max GR {lg:.1f} dB")
    duck = np.ones(n_total)
    for d in M.get("ducks", []):
        duck *= 1 - (1 - db2lin(d["db"])) * seg_env(n_total, d["t0"], d["t1"], d.get("ramp", 0.12),
                                                       d.get("ramp", 0.12))
    return music * db2lin(M.get("gain_db", 0.0)), notes, duck


# =============================================================================
# 6. Cue sheet for THIS video (swap this - or pass --cues file.json - for another video)
# =============================================================================
# Conventions
#   times in seconds; gain_db = peak level (dBFS, pre-master) of the peak-normalised sound
#   pan -1..1 (door is frame-left, the bed/crib frame-right); room/hall = reverb send (dB, None = off)
#   ambience: region [t0, t1] with raised-cosine fade_in (from t0) and fade_out (ending at t1)
#   events: {"t", "sound", "args", "gain_db", "pan", "room", "hall"}; generators "footsteps" and
#   "tick_roll" expand into many events.  All sounds are in SFX/AMBIENCE registries below.

DOOR_PAN = -0.3

DEFAULT_CUES = {
    "title": "What your mom did every night after you fell asleep - told by your bedroom door",
    "duration": 62.0,
    "target_lufs": -14.0,
    "limiter_ceiling_dbtp": -1.5,
    "end_fade": [61.9, 62.0],
    "stem_gain_db": {"music": -8.0, "sfx": 6.0, "amb": 0.0},
    # per-stem peak control in FINAL dBFS (applied after the master gain, before the master limiter)
    "stem_dynamics": {"music": {"limit_dbfs": -3.0, "lim_win": 0.015},
                      "sfx": {"comp_thr_dbfs": -12.0, "ratio": 3.0, "win": 0.004, "limit_dbfs": -3.0}},
    "shots": [0, 6, 12, 20, 28, 37, 45, 48.6, 54, 57.6, 62],
    "ambience": [
        {"sound": "room_tone", "t0": 0.0, "t1": 60.9, "fade_in": 0.3, "fade_out": 0.6, "gain_db": -40},
        {"sound": "crickets", "t0": 0.0, "t1": 12.1, "fade_in": 0.4, "fade_out": 0.35, "gain_db": -40,
         "args": {"count": 4, "density": 0.6}, "seed": 1},
        {"sound": "crickets", "t0": 28.0, "t1": 37.1, "fade_in": 0.35, "fade_out": 0.4, "gain_db": -41,
         "args": {"count": 3, "density": 0.55}, "seed": 2},
        {"sound": "crickets", "t0": 42.95, "t1": 45.1, "fade_in": 0.12, "fade_out": 0.2, "gain_db": -40,
         "args": {"count": 4, "density": 0.9}, "seed": 3},
        {"sound": "clock", "t0": 0.0, "t1": 6.05, "fade_in": 0.05, "fade_out": 0.1, "gain_db": -38, "pan": 0.35,
         "seed": 1},
        {"sound": "clock", "t0": 28.0, "t1": 37.05, "fade_in": 0.05, "fade_out": 0.1, "gain_db": -39, "pan": 0.35,
         "seed": 2},
        {"sound": "wind", "t0": 36.9, "t1": 39.08, "fade_in": 0.25, "fade_out": 0.14, "gain_db": -33,
         "args": {"darkness": 0.4, "gust": 0.8, "whistle": 0.05}, "seed": 1},
        {"sound": "dry_leaves", "t0": 36.95, "t1": 39.08, "fade_in": 0.2, "fade_out": 0.14, "gain_db": -38,
         "seed": 1},
        {"sound": "wind", "t0": 38.95, "t1": 41.08, "fade_in": 0.12, "fade_out": 0.14, "gain_db": -33,
         "args": {"darkness": 0.72, "gust": 0.5, "whistle": 0.22}, "seed": 2},
        {"sound": "rain_window", "t0": 40.95, "t1": 43.08, "fade_in": 0.12, "fade_out": 0.14, "gain_db": -32,
         "seed": 1},
        {"sound": "wind", "t0": 44.9, "t1": 60.9, "fade_in": 0.8, "fade_out": 0.6, "gain_db": -37,
         "args": {"darkness": 0.88, "gust": 0.3, "whistle": 0.0}, "seed": 3},
        {"sound": "sleigh_bells", "t0": 45.0, "t1": 48.0, "fade_in": 0.3, "fade_out": 0.6, "gain_db": -42,
         "seed": 1},
        {"sound": "lamp_hum", "t0": 20.0, "t1": 25.46, "fade_in": 0.25, "fade_out": 0.012, "gain_db": -50,
         "seed": 1},
    ],
    "events": [
        # --- door -------------------------------------------------------------------------------
        {"t": 2.10, "sound": "door_open", "args": {"creak": 1.5}, "gain_db": -13, "pan": DOOR_PAN, "room": -12},
        {"t": 28.30, "sound": "door_open", "args": {"creak": 1.3}, "gain_db": -13.5, "pan": DOOR_PAN, "room": -12},
        {"t": 37.10, "sound": "door_open", "args": {"creak": 0.45, "rate": [50, 110]}, "gain_db": -15.5,
         "pan": DOOR_PAN, "room": -12},
        {"t": 38.40, "sound": "door_close", "args": {"creak": 0.45}, "gain_db": -15.5, "pan": DOOR_PAN, "room": -12},
        {"t": 39.10, "sound": "door_open", "args": {"creak": 0.45, "rate": [50, 110]}, "gain_db": -15.5,
         "pan": DOOR_PAN, "room": -12},
        {"t": 40.40, "sound": "door_close", "args": {"creak": 0.45}, "gain_db": -15.5, "pan": DOOR_PAN, "room": -12},
        {"t": 41.10, "sound": "door_open", "args": {"creak": 0.45, "rate": [50, 110]}, "gain_db": -15.5,
         "pan": DOOR_PAN, "room": -12},
        {"t": 42.40, "sound": "door_close", "args": {"creak": 0.45}, "gain_db": -15.5, "pan": DOOR_PAN, "room": -12},
        {"t": 43.10, "sound": "door_open", "args": {"creak": 0.45, "rate": [50, 110]}, "gain_db": -15.5,
         "pan": DOOR_PAN, "room": -12},
        {"t": 44.40, "sound": "door_close", "args": {"creak": 0.45}, "gain_db": -15.5, "pan": DOOR_PAN, "room": -12},
        {"t": 45.15, "sound": "door_open", "args": {"creak": 1.15}, "gain_db": -12, "pan": DOOR_PAN, "room": -12},
        {"t": 59.90, "sound": "door_close", "args": {"creak": 0.70, "final": True}, "gain_db": -12,
         "pan": DOOR_PAN, "room": -11},
        # --- footsteps (socks on wood) ----------------------------------------------------------
        {"sound": "footsteps", "t0": 3.2, "t1": 6.0, "pan0": -0.35, "pan1": 0.1, "gain_db": -18.0, "room": -14},
        {"sound": "footsteps", "t0": 12.1, "t1": 13.7, "pan0": -0.3, "pan1": 0.0, "gain_db": -18.0, "room": -14},
        {"sound": "footsteps", "t0": 15.3, "t1": 16.5, "pan0": 0.0, "pan1": 0.2, "gain_db": -18.5, "room": -14},
        {"sound": "footsteps", "t0": 20.15, "t1": 21.9, "pan0": -0.3, "pan1": 0.15, "gain_db": -18.0, "room": -14},
        {"sound": "footsteps", "t0": 29.2, "t1": 30.0, "pan0": -0.35, "pan1": -0.15, "gain_db": -19.0, "room": -13},
        {"sound": "footsteps", "t0": 31.3, "t1": 33.0, "pan0": -0.15, "pan1": 0.2, "gain_db": -19.0, "room": -13},
        {"sound": "footsteps", "t0": 45.5, "t1": 46.4, "pan0": -0.35, "pan1": -0.1, "gain_db": -18.0, "room": -14},
        {"sound": "footsteps", "t0": 48.7, "t1": 50.3, "pan0": -0.1, "pan1": 0.2, "gain_db": -18.0, "room": -14},
        {"sound": "footsteps", "t0": 58.0, "t1": 59.3, "pan0": 0.2, "pan1": -0.2, "gain_db": -18.5, "room": -14},
        {"sound": "footsteps", "t0": 59.65, "t1": 60.3, "pan0": -0.2, "pan1": -0.33, "gain_db": -19.0, "room": -14},
        {"t": 4.6, "sound": "floorboard_creak", "gain_db": -20, "pan": -0.05, "room": -12},
        {"t": 31.9, "sound": "floorboard_creak", "gain_db": -20, "pan": 0.05, "room": -12},
        {"t": 49.5, "sound": "floorboard_creak", "gain_db": -16, "pan": 0.05, "room": -12},
        # --- cloth / bed ------------------------------------------------------------------------
        {"t": 8.0, "sound": "blanket_rustle", "args": {"dur": 0.8, "softness": 0.8, "intensity": 0.7},
         "gain_db": -21, "pan": 0.12, "room": -16},
        {"t": 14.4, "sound": "blanket_rustle", "args": {"dur": 0.22, "softness": 0.5, "intensity": 0.8},
         "gain_db": -22, "pan": 0.0, "room": -16},
        {"t": 17.8, "sound": "blanket_rustle", "args": {"dur": 0.8, "softness": 0.45, "intensity": 1.0, "strokes": 2},
         "gain_db": -19, "pan": 0.15, "room": -16},
        {"t": 35.0, "sound": "blanket_rustle", "args": {"dur": 0.35, "softness": 0.5, "intensity": 0.7},
         "gain_db": -23, "pan": 0.15, "room": -16},
        {"t": 51.4, "sound": "blanket_rustle", "args": {"dur": 0.8, "softness": 0.45, "intensity": 1.0, "strokes": 2},
         "gain_db": -19, "pan": 0.15, "room": -16},
        {"t": 52.6, "sound": "blanket_rustle", "args": {"dur": 1.3, "softness": 0.65, "intensity": 0.5, "strokes": 2, "contact": 0.9},
         "gain_db": -16, "pan": 0.1, "room": -18},
        {"t": 57.6, "sound": "blanket_rustle", "args": {"dur": 0.4, "softness": 0.4, "intensity": 1.0},
         "gain_db": -19, "pan": 0.15, "room": -16},
        {"t": 33.4, "sound": "mattress_sit", "gain_db": -17, "pan": 0.15, "room": -14},
        # --- props ------------------------------------------------------------------------------
        {"t": 14.6, "sound": "plush_pickup", "gain_db": -16.5, "pan": 0.0, "room": -15},
        {"t": 17.8, "sound": "plush_place", "gain_db": -16.5, "pan": 0.15, "room": -15},
        {"t": 23.1, "sound": "phone_pickup", "gain_db": -16.5, "pan": 0.15, "room": -15},
        {"t": 24.25, "sound": "phone_set_down_wood", "gain_db": -15, "pan": 0.25, "room": -12},
        {"t": 25.45, "sound": "lamp_switch_click", "gain_db": -16, "pan": 0.25, "room": -12},
        # --- UI / transitions -------------------------------------------------------------------
        {"t": 4.00, "sound": "counter_tick", "gain_db": -24, "pan": -0.2, "room": -20},
        {"sound": "tick_roll", "t0": 9.5, "t1": 11.6, "peak_rate": 20, "gain_db": -26, "pan": -0.2, "room": -20},
        {"t": 29.05, "sound": "counter_tick", "gain_db": -25, "pan": -0.2, "room": -20},
        {"sound": "tick_roll", "t0": 37.3, "t1": 44.4, "peak_rate": 18, "gain_db": -30, "pan": -0.2, "room": -20},
        {"t": 51.9, "sound": "counter_tick", "args": {"gold": True}, "gain_db": -23, "pan": -0.2, "room": -18},
        {"t": 51.9, "sound": "gold_chime", "args": {"notes": [82, 86, 89, 94], "vel": 0.55, "shimmer": 0.5,
                                                     "dur": 1.6, "decay": 0.45},
         "gain_db": -28, "pan": -0.1, "hall": -9},
        {"t": 12.0, "sound": "whoosh_timeskip", "gain_db": -23, "hall": -14},
        {"t": 20.0, "sound": "whoosh_timeskip", "gain_db": -23, "hall": -14},
        {"t": 28.0, "sound": "whoosh_timeskip", "gain_db": -23, "hall": -14},
        {"t": 37.0, "sound": "whoosh_timeskip", "gain_db": -23, "hall": -14},
        {"t": 45.0, "sound": "whoosh_timeskip", "gain_db": -24.5, "hall": -14},
        {"t": 39.0, "sound": "flash_swish", "gain_db": -25, "hall": -16},
        {"t": 41.0, "sound": "flash_swish", "gain_db": -25, "hall": -16},
        {"t": 43.0, "sound": "flash_swish", "gain_db": -25, "hall": -16},
        {"t": 45.0, "sound": "gold_chime", "args": {"notes": [81, 84, 89, 93, 96, 101], "spacing": 0.035,
                                                     "vel": 0.42, "shimmer": 0.8},
         "gain_db": -28, "pan": 0.1, "hall": -12},
        {"t": 55.0, "sound": "gold_chime", "args": {"notes": [96], "vel": 0.35, "dur": 1.4},
         "gain_db": -33, "pan": 0.1, "hall": -6},
    ],
    "music": {
        "gain_db": 0.0,
        "reverb_db": -6.5,
        "pad_db": -6.0,
        "pad_reverb_db": -4.0,
        "leveler": {"thr_rel_db": 3.0, "ratio": 2.5, "tau": 0.25},
        "end": 62.0,
        "chords": [
            [0.4, "F"], [3.3, "C/E"], [6.2, "Dm"], [9.1, "Bb"],
            [12.0, "F"], [14.667, "C/E"], [17.333, "Dm"], [20.0, "Bb"], [22.667, "F/A"], [25.333, "C"],
            [28.0, "Dm"], [31.0, "Bb"], [34.0, "F"], [36.0, "C"],
            [37.0, "F"], [39.0, "C/E"], [41.0, "Dm"], [43.0, "Bb"],
            [45.0, "F"], [47.3, "C/E"], [49.6, "Dm"], [51.9, "Bb"],
            [54.0, "F/A"], [55.8, "Dm"],
            [57.6, "Bb"], [58.95, "C"], [60.15, "F"],
        ],
        "sections": [
            {"t0": 0.4, "t1": 12.0, "style": "held", "vel": [[0.4, 0.24], [12.0, 0.27]], "roll": 0.07},
            {"t0": 12.0, "t1": 28.0, "style": "arp", "vel": [[12.0, 0.24], [20.0, 0.27], [28.0, 0.25]],
             "step": 0.4444, "pattern": [0, 1, 2, 3, 2, 1]},
            {"t0": 28.0, "t1": 37.0, "style": "thin", "vel": 0.2, "roll": 0.08},
            {"t0": 37.0, "t1": 45.0, "style": "pulse", "vel": [[37.0, 0.19], [45.0, 0.28]], "step": 0.5,
             "step_last": 0.25},
            {"t0": 45.0, "t1": 54.0, "style": "swell", "vel": [[45.0, 0.27], [51.9, 0.36], [54.0, 0.32]],
             "step": 0.3833, "pattern": [0, 1, 2, 3, 2, 1]},
            {"t0": 54.0, "t1": 57.6, "style": "sparse", "vel": 0.16},
            {"t0": 57.6, "t1": 62.0, "style": "cadence", "vel": [[57.6, 0.27], [60.15, 0.23]], "roll": 0.09},
        ],
        # [t, midi, vel, octave_double]
        "melody": [
            [1.37, 72, 0.30], [2.33, 69, 0.26], [3.30, 67, 0.29], [5.23, 72, 0.25], [6.20, 69, 0.30],
            [7.17, 65, 0.25], [8.13, 64, 0.22], [9.10, 65, 0.28], [11.03, 67, 0.23],
            [12.0, 69, 0.31], [12.89, 72, 0.29], [13.78, 74, 0.27], [14.667, 72, 0.31], [16.44, 67, 0.26],
            [17.333, 69, 0.30], [18.67, 65, 0.25], [19.11, 67, 0.24],
            [20.0, 74, 0.30], [21.78, 72, 0.26], [22.667, 69, 0.29], [24.0, 67, 0.24], [24.44, 65, 0.25],
            [25.333, 65, 0.26], [26.667, 64, 0.24],
            [29.25, 69, 0.21], [30.55, 65, 0.18], [32.0, 74, 0.21], [33.25, 72, 0.18], [34.5, 69, 0.20],
            [36.2, 67, 0.18],
            [41.0, 77, 0.27], [42.0, 76, 0.25], [43.0, 74, 0.29], [44.0, 72, 0.28], [44.5, 74, 0.27],
            [45.0, 72, 0.36, 1], [46.15, 69, 0.33, 1], [47.3, 67, 0.36, 1], [48.45, 72, 0.35, 1],
            [49.6, 69, 0.38, 1], [50.75, 77, 0.38, 1], [51.3, 79, 0.40, 1], [51.9, 74, 0.46, 1],
            [53.0, 72, 0.38, 1],
            [54.25, 81, 0.20], [55.5, 77, 0.17], [56.3, 76, 0.16], [56.95, 74, 0.17],
            [57.6, 77, 0.25], [58.95, 76, 0.24], [60.15, 77, 0.24],
        ],
        "stings": [{"t": 60.9, "midi": 29, "vel": 0.45, "hold": 1.2}],
        "pad": [
            {"t0": 45.0, "t1": 47.35, "chord": "F", "level": 0.55, "attack": 1.8, "release": 0.7},
            {"t0": 47.3, "t1": 49.65, "chord": "C/E", "level": 0.7, "attack": 0.6, "release": 0.7},
            {"t0": 49.6, "t1": 51.95, "chord": "Dm", "level": 0.85, "attack": 0.6, "release": 0.7},
            {"t0": 51.9, "t1": 54.0, "chord": "Bb", "level": 1.0, "attack": 0.5, "release": 1.6},
            {"t0": 57.6, "t1": 58.95, "chord": "Bb", "level": 0.35, "attack": 0.9, "release": 0.6},
            {"t0": 58.95, "t1": 60.15, "chord": "C", "level": 0.38, "attack": 0.5, "release": 0.6},
            {"t0": 60.15, "t1": 60.9, "chord": "F", "level": 0.38, "attack": 0.5, "release": 0.6},
            {"t0": 60.9, "t1": 61.4, "chord": "F", "level": 0.5, "attack": 0.5, "release": 0.55},
        ],
        "ducks": [{"t0": 2.05, "t1": 3.7, "db": -2.5}, {"t0": 28.25, "t1": 29.7, "db": -2.5}],
        "eq": [{"f": 2800, "q": 0.8, "db": -3.0}],
        "auto_duck": {"db": -1.5, "categories": ["door", "footstep", "cloth", "prop"], "lookahead": 0.08,
                      "hold": 0.35, "smooth": 0.12, "max_len": 1.0},
    },
}

# registry: cue name -> (function(rng, **args) -> Sound, QA category for the onset table)
SFX = {
    "door_open": (sfx_door_open, "door"),
    "door_close": (sfx_door_close, "door"),
    "latch_click": (sfx_latch_click, "door"),
    "footstep": (sfx_footstep, "footstep"),
    "floorboard_creak": (sfx_floorboard_creak, "footstep"),
    "blanket_rustle": (sfx_blanket_rustle, "cloth"),
    "car_pass": (sfx_car_pass, "prop"),
    "chalk_write": (sfx_chalk_write, "prop"),
    "pen_scribble": (sfx_pen_scribble, "prop"),
    "low_swell": (sfx_low_swell, "ui"),
    "mattress_sit": (sfx_mattress_sit, "cloth"),
    "plush_pickup": (sfx_plush_pickup, "prop"),
    "plush_squeak": (sfx_plush_squeak, "prop"),
    "plush_place": (sfx_plush_place, "prop"),
    "phone_pickup": (sfx_phone_pickup, "prop"),
    "phone_set_down_wood": (sfx_phone_set_down_wood, "prop"),
    "lamp_switch_click": (sfx_lamp_switch_click, "prop"),
    "counter_tick": (sfx_counter_tick, "ui"),
    "gold_chime": (sfx_gold_chime, "ui"),
    "whoosh_timeskip": (sfx_whoosh_timeskip, "ui"),
    "flash_swish": (sfx_flash_swish, "ui"),
    "car_horn": (sfx_car_horn, "prop"),
    "car_crash": (sfx_car_crash, "prop"),
    "giant_step": (sfx_giant_step, "footstep"),
    "snore": (sfx_snore, "cloth"),
    "dog_bark": (sfx_dog_bark, "prop"),
    "slurp": (sfx_slurp, "prop"),
    "wood_snap": (sfx_wood_snap, "prop"),
    "bonk": (sfx_bonk, "prop"),
    "metal_groan": (sfx_metal_groan, "prop"),
    "metal_clang": (sfx_metal_clang, "prop"),
    "keyboard_type": (sfx_keyboard_type, "prop"),
    "crow_caw": (sfx_crow_caw, "prop"),
    "cat_meow": (sfx_cat_meow, "prop"),
    "parrot_chirp": (sfx_parrot_chirp, "prop"),
    "fish_blub": (sfx_fish_blub, "prop"),
    "hamster_squeak": (sfx_hamster_squeak, "prop"),
    "distant_boom": (sfx_distant_boom, "prop"),
    "whimper": (sfx_whimper, "prop"),
    "puppy_howl": (sfx_puppy_howl, "prop"),
    "alarm_muffled": (sfx_alarm_muffled, "prop"),
    "heartbeat": (sfx_heartbeat, "prop"),
    "water_splash": (sfx_water_splash, "prop"),
    "kick": (sfx_kick, "prop"),
    "pressure_drop": (sfx_pressure_drop, "ui"),
    "candy_rattle": (sfx_candy_rattle, "prop"),
    "deflate": (sfx_deflate, "prop"),
    "bone_clatter": (sfx_bone_clatter, "prop"),
    "alarm_beep": (sfx_alarm_beep, "prop"),
    "cartoon_splash": (sfx_cartoon_splash, "prop"),   # 020 (017 owns water_splash)
    "scan_beep": (sfx_scan_beep, "ui"),   # 031 (checkout scanner; "ui" so the music does not duck under every boop)
    "sneeze": (sfx_sneeze, "ui"),   # 044 (a puppy's cartoon sneeze)
}

# =============================================================================
# 6b. build genre (024, docs/BUILD.md): construction foley + beds. Soft, low-passed, cartoon — never harsh.
# =============================================================================


def _grains(n, rng, rate, tau, lo, hi, t=None, decay=None):
    """Random tiny impacts (grit, crackle, clods): Poisson clicks through a short decay, band-passed."""
    p = rate / SR * (np.exp(-t / decay) if decay is not None else 1.0)
    imp = (rng.random(n) < p) * rng.exponential(1.0, n)
    y = bp(np.convolve(imp, np.exp(-np.arange(nsamp(tau * 4)) / nsamp(tau)))[:n], lo, hi)
    return norm(y) if np.any(y) else y


def sfx_dig(rng, size=1.0):
    """A shovel biting into dirt + the clod landing: gritty crunch, low thump, a soft patter ~0.25 s later."""
    n = nsamp(0.5)
    t = tvec(n)
    grit = _grains(n, rng, 900, 0.001, 400, 2600, t, 0.07)
    body = bp(white(n, rng), 200, 1200) * np.exp(-t / 0.05) * (1 - np.exp(-t / 0.003))
    thump = np.sin(2 * np.pi * 90 * size ** -0.3 * t) * np.exp(-t / 0.06) * (1 - np.exp(-t / 0.003))
    toss = bp(white(n, rng), 500, 2000) * np.exp(-((t - 0.27) / 0.05) ** 2) * 0.3
    y = 0.7 * grit + 0.6 * norm(body) + 0.6 * thump + toss
    return Sound(norm(fades(lp(y, 3200), 0.0005, 0.05)), onsets=[(0.0, "transient")])


def sfx_crumble(rng, dur=1.4, size=1.0):
    """Earth caving in: a low rumble that swells fast and settles + a patter of falling clods."""
    n = nsamp(dur)
    t = tvec(n)
    env = (1 - np.exp(-t / 0.04)) * np.exp(-t / (0.45 * size))
    rumble = unit_rms(lp(brown(n, rng), 260)) * env
    clods = _grains(n, rng, 160 * size, 0.004, 120, 1500, t, 0.5)
    hiss = unit_rms(bp(pink(n, rng), 300, 1500)) * env * 0.25
    y = rumble + 0.7 * clods + hiss
    return Sound(norm(fades(lp(y, 2400), 0.002, 0.15)), onsets=[(0.0, "soft")])


def sfx_splash(rng, size=1.0):
    """Something landing in water: a soft wash + bubbles + a low plop (all under 3.5 kHz)."""
    n = nsamp(0.9)
    t = tvec(n)
    burst = bp(white(n, rng), 300, 3000) * np.exp(-t / (0.09 * size)) * (1 - np.exp(-t / 0.004))
    bub = np.zeros(n)
    for _ in range(int(10 * size)):
        i0, m = nsamp(rng.uniform(0.03, 0.5)), nsamp(0.05)
        if i0 + m >= n:
            continue
        tt = tvec(m)
        bub[i0:i0 + m] += np.sin(2 * np.pi * rng.uniform(350, 900) * (1 + 2.5 * tt) * tt) * np.exp(-tt / 0.015) * rng.uniform(0.3, 1)
    plop = np.sin(2 * np.pi * 70 * t) * np.exp(-t / 0.05) * (1 - np.exp(-t / 0.003))
    y = norm(burst) + 0.35 * (norm(bub) if np.any(bub) else bub) + 0.5 * plop
    return Sound(norm(fades(lp(y, 3500), 0.0005, 0.08)), onsets=[(0.0, "transient")])


def sfx_clunk(rng, size=1.0, metal=0.5):
    """A heavy part set in place (a lining ring, a pump, a machine landing): deep thud + a short dull ring. No clang."""
    n = nsamp(0.8)
    t = tvec(n)
    f0 = 62 * size ** -0.35 * rng.uniform(0.95, 1.05)
    sub = np.sin(2 * np.pi * f0 * t * (1 - 0.2 * np.clip(t / 0.2, 0, 1))) * np.exp(-t / (0.1 * size)) * (1 - np.exp(-t / 0.003))
    ring = norm(modal([rng.uniform(180, 220), rng.uniform(410, 470), rng.uniform(690, 760)], [0.12, 0.07, 0.04], [1, 0.5, 0.3], 0.8, contact=0.004))
    y = sub + 0.35 * metal * ring + 0.15 * lp(white(n, rng), 1500) * np.exp(-t / 0.02)
    return Sound(norm(fades(lp(y, 2600), 0.0005, 0.08)), onsets=[(0.0, "soft")])


def sfx_knock(rng, pitch=1.0):
    """A plank or beam popping into place: a short hollow wood knock."""
    y = modal([rng.uniform(380, 440) * pitch, rng.uniform(850, 950) * pitch, rng.uniform(1500, 1700) * pitch], [0.03, 0.015, 0.008], [1, 0.45, 0.2], 0.25, contact=0.002)
    return Sound(norm(fades(lp(y, 3500), 0.0003, 0.03)), onsets=[(0.0, "transient")])


def sfx_pop(rng, pitch=1.0):
    """Something popping into existence / a party popper: a round falling 'bloop' + a soft puff. No snap."""
    n = nsamp(0.35)
    t = tvec(n)
    f = 190 * pitch * (1 + 1.2 * np.exp(-t / 0.02))
    pop = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.05) * (1 - np.exp(-t / 0.002))
    puff = bp(white(n, rng), 400, 2400) * np.exp(-t / 0.03) * 0.35
    return Sound(norm(fades(lp(pop + puff, 3000), 0.0005, 0.04)), onsets=[(0.0, "transient")])


def sfx_zap(rng, dur=0.7):
    """Cartoon electric zap, kept soft: a fluttering 110 Hz buzz + crackle, low-passed at 2.4 kHz."""
    n = nsamp(dur)
    t = tvec(n)
    ph = 2 * np.pi * 110 * t
    saw = sum(np.sin(k * ph) / k for k in range(1, 14))
    flutter = 0.6 + 0.4 * np.sin(2 * np.pi * 13 * t)
    crack = _grains(n, rng, 600, 0.0007, 600, 2400)
    env = (1 - np.exp(-t / 0.01)) * np.exp(-t / (dur * 0.5))
    y = (0.7 * norm(saw) * flutter + 0.4 * crack) * env
    return Sound(norm(fades(lp(y, 2400), 0.001, 0.08)), onsets=[(0.0, "soft")])


def sfx_plip(rng, pitch=1.0):
    """A drip into a puddle: a tiny rising blip."""
    n = nsamp(0.18)
    t = tvec(n)
    f = 700 * pitch * (1 + 0.8 * t / 0.18)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.03) * (1 - np.exp(-t / 0.002))
    return Sound(norm(fades(y, 0.0005, 0.02)), onsets=[(0.0, "transient")])


def sfx_grate(rng, dur=1.0):
    """Cheese on a giant grater: soft rhythmic rasps (~9 per second)."""
    n = nsamp(dur)
    t = tvec(n)
    y = bp(pink(n, rng), 500, 2800) * np.clip(np.sin(2 * np.pi * 9 * t), 0, 1) ** 2 * np.exp(-t / (dur * 0.8))
    return Sound(norm(fades(lp(y, 3000), 0.005, 0.05)), onsets=[(0.0, "soft")])


def amb_water_rush(dur, rng, intensity=1.0):
    """Water pouring in / a hose blasting: band-limited noise with slow surges + a low body."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        x = unit_rms(bp(pink(n, rng), 250, 2600)) * (0.75 + 0.25 * smooth_rand(n, 1.5, rng))
        out.append(x + 0.5 * unit_rms(lp(brown(n, rng), 300)))
    return norm(np.vstack(out))


def amb_drill(dur, rng, rate=7.0):
    """A tunnel boring machine chewing dirt: deep grinding rumble with the cutter's rhythm + a motor hum."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        grind = unit_rms(bp(brown(n, rng), 60, 700)) * (0.65 + 0.35 * np.sin(2 * np.pi * rate * t + ch))
        hum = unit_rms(sum(np.sin(2 * np.pi * 55 * k * t + ch * k) / k for k in (1, 2, 3, 4)))
        grit = unit_rms(bp(pink(n, rng), 500, 2000)) * 0.25 * (0.6 + 0.4 * smooth_rand(n, 3, rng))
        out.append(grind + 0.35 * hum + grit)
    return norm(np.vstack(out))


def amb_fan(dur, rng, rate=11.0):
    """Big ventilation fans: a broadband air rush with the blade beat, low-passed."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        air = unit_rms(lp(pink(n, rng), 1300)) * (0.75 + 0.25 * np.sin(2 * np.pi * rate * t + ch * 0.7))
        out.append(air + 0.3 * unit_rms(np.sin(2 * np.pi * 48 * t) + 0.4 * np.sin(2 * np.pi * 96 * t)))
    return norm(np.vstack(out))


def amb_train(dur, rng, clack=2.2):
    """A subway train rolling in/out: low rumble + soft double wheel-clacks."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        rum = unit_rms(lp(brown(n, rng), 220))
        cl = np.zeros(n)
        per, m = nsamp(1 / clack), nsamp(0.12)
        tt = tvec(m)
        hit = np.sin(2 * np.pi * 95 * tt) * np.exp(-tt / 0.03)
        for i0 in range(nsamp(0.1) + ch * nsamp(0.01), n - m - nsamp(0.1), per):
            cl[i0:i0 + m] += hit
            cl[i0 + nsamp(0.09):i0 + nsamp(0.09) + m] += 0.7 * hit
        out.append(rum + 0.6 * (unit_rms(cl) if np.any(cl) else cl))
    return norm(np.vstack(out))


SFX.update({
    "dig": (sfx_dig, "prop"), "crumble": (sfx_crumble, "prop"), "splash": (sfx_splash, "prop"), "clunk": (sfx_clunk, "prop"),
    "knock": (sfx_knock, "prop"), "pop": (sfx_pop, "prop"), "zap": (sfx_zap, "prop"), "plip": (sfx_plip, "prop"), "grate": (sfx_grate, "prop"),
})
AMBIENCE.update({"water_rush": amb_water_rush, "drill": amb_drill, "fan": amb_fan, "train": amb_train})


# ---------------------------------------------------------------- 035 (fart doubling): soft comic toots + street/window foley
def sfx_toot(rng, size=0.5, pitch=1.0, dur=None):
    """A cartoon toot / soft brass "bwaap" (035) — never realistic, never harsh. size 0..1: 0 = a tiny high squeak
    (~380 Hz, 0.2 s), 1 = a big tuba bwaaamp (~55 Hz, 1.3 s) with a sub thump. A buzzy saw tone through a closing low-pass,
    a lip-flutter AM ("brrr"), a little upward scoop at the start and a sagging fall at the end. Low-passed under 2.4 kHz."""
    s = float(np.clip(size, 0, 1))
    d = dur if dur is not None else 0.2 + 1.1 * s
    n = nsamp(d + 0.35)
    t = tvec(n)
    u = np.clip(t / d, 0, 1)
    f0 = 380.0 * (55.0 / 380.0) ** s * pitch
    contour = 1.0 + 0.12 * np.exp(-t / 0.04) - 0.16 * np.clip((u - 0.65) / 0.35, 0, 1) ** 2 + 0.015 * np.sin(2 * np.pi * 5.5 * t)
    ph = np.cumsum(f0 * contour) / SR
    saw = 2 * (ph % 1.0) - 1
    tone = lp(saw, min(2400, f0 * (6 + 4 * (1 - s))), 2) + 0.5 * np.sin(2 * np.pi * ph)
    rate = 34 - 14 * s + 3 * np.sin(2 * np.pi * 1.3 * t)
    flutter = 0.62 + 0.38 * np.sin(2 * np.pi * np.cumsum(rate) / SR) ** 2
    env = np.clip(t / 0.012, 0, 1) * np.clip((d - t) / 0.09 + 0.0, 0, 1) * (0.85 + 0.15 * np.sin(np.pi * u))
    out = tone * flutter * env
    if s > 0.45:
        k = (s - 0.45) / 0.55
        out += k * 1.1 * np.sin(2 * np.pi * 46 * t) * np.exp(-t / 0.22) * np.clip(t / 0.006, 0, 1)
        out += k * 0.5 * lp(pink(n, rng), 220) * np.exp(-t / 0.5)
    return Sound(norm(fades(lp(out, 2400), 0.004, 0.12)), onsets=[(0.0, "soft")])


def sfx_car_alarm(rng, dur=2.4, pitch=1.0, rate=2.8):
    """A car alarm far down the block (035): a rising whoop siren (two detuned square-ish tones) repeated `rate` times a
    second, rounded and low-passed hard so it's comic background, never a piercing tone."""
    n = nsamp(dur)
    t = tvec(n)
    cyc = (t * rate) % 1.0
    f = (560 + 420 * cyc) * pitch
    ph = np.cumsum(f) / SR
    sq = np.tanh(3 * np.sin(2 * np.pi * ph)) + 0.6 * np.tanh(3 * np.sin(2 * np.pi * ph * 1.006))
    env = np.clip(t / 0.05, 0, 1) * np.clip((dur - t) / 0.2, 0, 1)
    return Sound(norm(fades(lp(sq, 1500, 2) * env, 0.01, 0.1)), onsets=[(0.0, "soft")])


def sfx_wing_flutter(rng, dur=1.4, n_birds=10):
    """A flock lifting off (035): many short wing-flap bursts (band-limited noise chopped at ~14 Hz per bird, staggered),
    fading as they climb away. Soft and papery."""
    n = nsamp(dur + 0.2)
    t = tvec(n)
    out = np.zeros(n)
    for b in range(n_birds):
        t0 = rng.uniform(0, 0.35)
        r = rng.uniform(11, 17)
        nz = bp(white(n, rng), 300, 1600)
        gate = np.clip(np.sin(2 * np.pi * r * (t - t0)), 0, 1) ** 2 * (t > t0) * np.exp(-np.clip(t - t0, 0, None) / rng.uniform(0.4, 0.8))
        out += nz * gate
    return Sound(norm(fades(lp(out, 2600), 0.003, 0.1)), onsets=[(0.0, "soft")])


def sfx_glass_crack(rng, dur=0.8, n_pings=4):
    """Window panes cracking (035): a soft dry crackle + a few faint glassy pings, low-passed so nothing tinkles sharply."""
    n = nsamp(dur + 0.3)
    t = tvec(n)
    crk = np.zeros(n)
    for k in range(18):
        i0 = nsamp(rng.uniform(0, 0.18))
        m = nsamp(0.012)
        if i0 + m < n:
            crk[i0:i0 + m] += white(m, rng) * np.exp(-np.arange(m) / (m / 3)) * rng.uniform(0.4, 1.0)
    pings = np.zeros(n)
    for k in range(n_pings):
        t0 = rng.uniform(0.02, 0.3)
        f = rng.uniform(1500, 2300)
        tt = np.clip(t - t0, 0, None)
        pings += 0.35 * np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.12) * (t > t0)
    return Sound(norm(fades(lp(lp(crk, 2800) + pings, 3000), 0.002, 0.1)), onsets=[(0.0, "soft")])


SFX.update({"toot": (sfx_toot, "prop"), "car_alarm": (sfx_car_alarm, "prop"), "wing_flutter": (sfx_wing_flutter, "prop"), "glass_crack": (sfx_glass_crack, "prop")})



# =============================================================================
# 6c. fire + air (037 oxygen doubles): soft cartoon fire, a flame "whoomp", a far siren, steam hiss, breaths, big wings.
#     Everything low-passed (no crackle above ~3 kHz, no siren above ~1.4 kHz) — fire must sound cozy, not harsh.
# =============================================================================


def amb_fire(dur, rng, size=1.0):
    """A fire bed: a soft low roar (brown noise breathing) + wood crackle grains + rare pops. size 0.3 campfire … 2 blaze."""
    n = nsamp(dur)
    out = []
    for ch in range(2):
        roar = unit_rms(lp(brown(n, rng), 260 + 120 * size)) * (0.7 + 0.3 * smooth_rand(n, 1.2, rng))
        crack = _grains(n, rng, 70 + 50 * size, 0.0012, 700, 2800)
        pops = _grains(n, rng, 2.5, 0.006, 300, 1400)
        out.append(roar * (0.25 + 0.35 * min(size, 2.0)) + 0.55 * crack + 0.5 * pops)
    return norm(lp(np.vstack(out), 3000))


def sfx_whoomp(rng, size=1.0):
    """Flames leaping up: a rising air rush (0.2 s), a round low thump, then a crackling roar that fades. anchor = the thump."""
    pre, n = nsamp(0.18), nsamp(0.18 + 0.6 + 0.9 * size)
    t = tvec(n) - 0.18
    rush = bp(pink(n, rng), 250, 1600) * np.clip((t + 0.18) / 0.18, 0, 1) ** 2 * np.exp(-np.clip(t, 0, None) / (0.25 + 0.2 * size))
    f = 70 * size ** -0.25 * (1 + 0.6 * np.exp(-np.clip(t, 0, None) / 0.04))
    thump = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-np.clip(t, 0, None) / (0.12 + 0.06 * size)) * (t > 0)
    roar = lp(brown(n, rng), 500) * np.clip(t / 0.05, 0, 1) * np.exp(-np.clip(t, 0, None) / (0.35 + 0.4 * size))
    crack = _grains(n, rng, 160, 0.001, 700, 2600) * (t > 0) * np.exp(-np.clip(t, 0, None) / (0.4 + 0.3 * size))
    y = 0.55 * norm(rush) + (0.7 * min(size, 1.5)) * thump + 0.6 * norm(roar) + 0.3 * crack
    return Sound(norm(fades(lp(y, 2600), 0.002, 0.15)), anchor=0.18, onsets=[(0.0, "transient")])


def amb_siren(dur, rng, distance=1.0, rate=0.32):
    """A far fire siren: a slow two-octave-less wail (600 ↔ 950 Hz), heavily low-passed with distance, gentle doppler sway."""
    n = nsamp(dur)
    t = tvec(n)
    f = 620 + 330 * (0.5 - 0.5 * np.cos(2 * np.pi * rate * t)) + 6 * np.sin(2 * np.pi * 0.23 * t)
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)
    y = lp(y, 1400 / max(0.8, distance)) * (0.8 + 0.2 * smooth_rand(n, 0.4, rng))
    return norm(np.vstack([y, lp(np.roll(y, nsamp(0.012)), 1200 / max(0.8, distance))]))


def sfx_hiss(rng, dur=1.2):
    """Steam / an extinguisher: a soft band-limited hiss that swells fast and tails off (low-passed, never sharp)."""
    n = nsamp(dur)
    t = tvec(n)
    y = bp(pink(n, rng), 700, 3400) * (1 - np.exp(-t / 0.04)) * np.exp(-t / (dur * 0.45)) * (0.8 + 0.2 * smooth_rand(n, 8, rng))
    return Sound(norm(fades(lp(y, 3600), 0.003, 0.1)), onsets=[(0.0, "soft")])


def sfx_breath(rng, dur=0.9, inhale=True):
    """A big breath: airy formant noise that rises (inhale) or falls (exhale / blowing candles)."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    env = np.sin(np.pi * np.clip(u, 0, 1)) ** (0.8 if inhale else 0.5) * (np.clip(u * 3, 0, 1) if inhale else np.exp(-u * 1.5))
    lo = 300 + (900 * u if inhale else 900 * (1 - u))
    y = sweep_filter(pink(n, rng), lo + 500, q=1.2) * env
    return Sound(norm(fades(lp(y, 3000), 0.01, 0.08)), onsets=[(0.0, "soft")])


def amb_buzz(dur, rng, rate=24.0):
    """Big wings (a crow-sized dragonfly): a low papery drone at the wingbeat rate with slow wobble."""
    n = nsamp(dur)
    t = tvec(n)
    out = []
    for ch in range(2):
        am = 0.55 + 0.45 * np.sin(2 * np.pi * (rate + 1.5 * ch) * t + ch) ** 2
        y = unit_rms(bp(pink(n, rng), 140, 900)) * am * (0.7 + 0.3 * smooth_rand(n, 0.8, rng))
        out.append(y)
    return norm(lp(np.vstack(out), 1600))


SFX.update({"whoomp": (sfx_whoomp, "prop"), "hiss": (sfx_hiss, "prop"), "breath": (sfx_breath, "cloth")})
AMBIENCE.update({"fire": amb_fire, "siren": amb_siren, "buzz": amb_buzz})

def load_voice(V, N, log=print):
    """Narration stem (build genre): videos/<v>/<V['file']> (any rate, mono/stereo) -> centered stereo at SR, length N.
    Returns (voice, activity 0..1) — activity drives the music/ambience ducking."""
    sr, _, v = read_wav(os.path.join(OUT_DIR, V.get("file", "voice.wav")))
    v = v.mean(axis=0)
    if sr != SR:
        g = np.gcd(int(SR), int(sr))
        v = signal.resample_poly(v, SR // g, sr // g)
    v = np.pad(v, (0, max(0, N - len(v))))[:N]
    v = hp(v, V.get("hp", 70)) * db2lin(V.get("gain_db", 0.0))
    if V.get("presence_db"):
        v = peak_eq(v, 3000, 0.9, V["presence_db"])
    env = ndimage.uniform_filter1d(np.abs(v), size=nsamp(0.03))
    act = (env > np.percentile(env[env > 1e-6], 50) * 0.3).astype(float)
    act = ndimage.maximum_filter1d(act, size=nsamp(V.get("hold", 0.25)), mode="constant")
    a = np.exp(-1.0 / (V.get("smooth", 0.08) * SR))
    act = np.clip(signal.filtfilt([1 - a], [1, -a], act), 0, 1)
    log(f"  voice: {V.get('file', 'voice.wav')} ({sr} Hz), speaking {np.mean(act > 0.5) * 100:.0f}% of the time")
    return np.vstack([v, v]) * 0.7071, act


# =============================================================================
# 7. mixer / master / pack / verification
# =============================================================================


def expand_events(events):
    """Expand generator cues (footsteps, tick_roll) into plain events."""
    out = []
    for ei, e in enumerate(events):
        snd = e["sound"]
        if snd == "footsteps":
            rng = seeded("steps", ei, e["t0"])
            t0, t1, rate = e["t0"], e["t1"], e.get("rate", 1.8)
            D = t1 - t0
            kf = max(1, int(np.floor(D * rate)))
            k = min((kf, kf + 1), key=lambda kk: abs(np.log(D / kk * rate)))
            times = t0 + np.arange(k + 1) * D / k
            times[1:-1] += rng.uniform(-0.06, 0.06, k - 1) * D / k
            pans = np.linspace(e.get("pan0", 0), e.get("pan1", 0), k + 1)
            for j, tj in enumerate(times):
                out.append({"t": float(tj), "sound": "footstep",
                            "args": {"weight": float(rng.uniform(0.85, 1.1)), "scuff": float(rng.uniform(0.7, 1.2))},
                            "gain_db": e["gain_db"] + (-1.0 if j % 2 else 0.0) + float(rng.normal(0, 0.5)),
                            "pan": float(pans[j] + (0.04 if j % 2 else -0.04)), "room": e.get("room"),
                            "seed": ("step", ei, j)})
        elif snd == "tick_roll":
            r0, r1, peak = e["t0"], e["t1"], e.get("peak_rate", 18)
            dt = 0.0005
            tt = np.arange(r0, r1, dt)
            u = (tt - r0) / (r1 - r0)
            rate = peak * np.sin(np.pi * u)
            cum = np.concatenate([[0], np.cumsum(rate[:-1] * dt)])
            ks = np.arange(0, int(np.floor(cum[-1])) + 1)
            times = list(np.interp(ks, cum, tt))
            if r1 - times[-1] > 0.12:
                times.append(r1)
            for j, tj in enumerate(times):
                rr = peak * np.sin(np.pi * np.clip((tj - r0) / (r1 - r0), 0, 1))
                out.append({"t": float(tj), "sound": "counter_tick", "args": {"bright": 1.0},
                            "gain_db": e["gain_db"] - 3.0 * rr / peak + (1.0 if j in (0, len(times) - 1) else 0.0),
                            "pan": e.get("pan", 0), "room": e.get("room"), "seed": ("tick", ei, j), "qa": "roll"})
        else:
            ee = dict(e)
            ee.setdefault("seed", ("ev", ei))
            out.append(ee)
    return out


def render_mix(cues, log=print):
    N = nsamp(cues["duration"])
    music, notes, duck = render_music(cues["music"], N, log)
    log("  music done")
    amb = np.zeros((2, N))
    for ai, a in enumerate(cues["ambience"]):
        fn = AMBIENCE[a["sound"]]
        rng = seeded("amb", a["sound"], a.get("seed", ai))
        dur = a["t1"] - a["t0"]
        x = fn(dur + 0.05, rng, **a.get("args", {}))
        x = as_stereo(x, a.get("pan", 0.0))
        env = seg_env(x.shape[1], 0.0, dur, a.get("fade_in", 0.1), a.get("fade_out", 0.1))
        place(amb, x * env, nsamp(a["t0"]), db2lin(a["gain_db"]))
    log("  ambience done")
    sfx_dry = np.zeros((2, N))
    sfx_room = np.zeros((2, N))
    sfx_hall = np.zeros((2, N))
    expected = []
    AD = cues["music"].get("auto_duck")
    active = np.zeros(N)
    for e in expand_events(cues["events"]):
        fn, cat = SFX[e["sound"]]
        rng = seeded("sfx", e["sound"], e.get("seed"), e["t"])
        s = fn(rng, **e.get("args", {}))
        x = as_stereo(fades(s.x, 0.0005, 0.006), e.get("pan", 0.0))
        st = nsamp(e["t"] - s.anchor)
        g = db2lin(e.get("gain_db", -20))
        place(sfx_dry, x, st, g)
        if e.get("room") is not None:
            place(sfx_room, x, st, g * db2lin(e["room"]))
        if e.get("hall") is not None:
            place(sfx_hall, x, st, g * db2lin(e["hall"]))
        if AD and cat in AD.get("categories", ()):
            a0 = max(0, st)
            active[a0:max(a0, min(N, st + min(x.shape[1], nsamp(AD.get("max_len", 1.0)))))] = 1.0
        for o in s.onsets:
            off, kind = (o, "transient") if np.isscalar(o) else (o[0], o[1])
            expected.append((round(e["t"] + off, 4), e["sound"], e.get("qa", cat), kind))
    if AD:  # foley-keyed music ducking: look-ahead attack, held between close events, slow release
        la = nsamp(AD.get("lookahead", 0.08))
        act = np.concatenate([active[la:], np.zeros(la)])
        act = ndimage.maximum_filter1d(act, size=nsamp(AD.get("hold", 0.35)), mode="constant")
        a = np.exp(-1.0 / (AD.get("smooth", 0.12) * SR))
        act = np.clip(signal.filtfilt([1 - a], [1, -a], act), 0, 1)
        duck = np.minimum(duck, 1 - (1 - db2lin(AD["db"])) * act)
    voice = None
    if cues.get("voice"):  # build genre: the narrator sits on top; music + ambience duck under every phrase
        voice, vact = load_voice(cues["voice"], N, log)
        duck = np.minimum(duck, 1 - (1 - db2lin(cues["voice"].get("duck_db", -8.0))) * vact)
        amb = amb * (1 - (1 - db2lin(cues["voice"].get("amb_duck_db", -4.0))) * vact)
    for eq in cues["music"].get("eq", []):  # presence dip so the foley reads on phone speakers
        music = peak_eq(music, eq["f"], eq.get("q", 0.8), eq["db"])
    music = music * duck
    sfx = sfx_dry + convolve(sfx_room, room_ir()) + convolve(sfx_hall, hall_ir())
    # anti-harshness on the foley bus. cues["sfx_lowpass_hz"] (e.g. 4500) makes foley warm and soft.
    if cues.get("sfx_lowpass_hz"):
        sfx = lp(sfx, cues["sfx_lowpass_hz"], 4)
    else:
        sfx = lp(sfx, 15000) * 0.75 + lp(sfx, 9000) * 0.25
    sg = cues.get("stem_gain_db", {})
    music, sfx, amb = (x * db2lin(sg.get(k, 0.0)) for k, x in (("music", music), ("sfx", sfx), ("amb", amb)))
    log("  sfx done")
    stems = {"music": music, "sfx": sfx, "amb": amb}
    if voice is not None:
        stems["voice"] = voice * db2lin(sg.get("voice", 0.0))
    endf = end_fade_env(cues, N)
    for k in stems:
        stems[k] = hp(stems[k], 18) * endf
    stems["_duck"] = duck
    return stems, expected, notes


# ---- loudness / limiter ----------------------------------------------------------------------


def k_weight(x):
    b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
    a1 = [1.0, -1.69065929318241, 0.73248077421585]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def block_loudness(x, blk=0.4, hop=0.1):
    y = k_weight(np.atleast_2d(x))
    p = np.sum(y ** 2, axis=0)
    c = np.concatenate([[0.0], np.cumsum(p)])
    B, H = nsamp(blk), nsamp(hop)
    st = np.arange(0, len(p) - B + 1, H)
    z = (c[st + B] - c[st]) / B
    return st / SR, z


def integrated_lufs(x):
    _, z = block_loudness(x)
    l = -0.691 + 10 * np.log10(z + 1e-20)
    z1 = z[l > -70]
    if not len(z1):
        return -np.inf
    rel = -0.691 + 10 * np.log10(np.mean(z1)) - 10
    z2 = z[(l > -70) & (l > rel)]
    return -0.691 + 10 * np.log10(np.mean(z2))


def window_lufs(x, t0, t1):
    """Ungated loudness of a time window (for per-shot balance reports)."""
    a, b = nsamp(t0), nsamp(t1)
    y = k_weight(np.atleast_2d(x))[:, a:b]
    return -0.691 + 10 * np.log10(np.mean(np.sum(y ** 2, axis=0)) + 1e-20)


def true_peak_db(x):
    up = signal.resample_poly(np.atleast_2d(x), 4, 1, axis=-1)
    return float(lin2db(np.max(np.abs(up))))


def limiter(x, ceiling_db=-1.5, win=0.012):
    """Look-ahead true-peak limiter (4x oversampled detector). Gain curve = min-filter of the
    required gain (+/- 2W) smoothed by two box filters (+/- W each) -> never exceeds the ceiling."""
    n = x.shape[1]
    up = signal.resample_poly(x, 4, 1, axis=-1)
    pk = np.max(np.abs(up), axis=0)[: 4 * n].reshape(n, 4).max(axis=1)
    g = np.minimum(1.0, db2lin(ceiling_db) / np.maximum(pk, 1e-12))
    W = nsamp(win)
    h = ndimage.minimum_filter1d(g, size=4 * W + 1, mode="nearest")
    s = ndimage.uniform_filter1d(h, size=2 * W + 1, mode="nearest")
    s = ndimage.uniform_filter1d(s, size=2 * W + 1, mode="nearest")
    s = np.minimum(s, 1.0)
    return x * s, s


def peak_compressor(x, thr_db, ratio=3.0, win=0.004):
    """Look-ahead peak compressor (same zero-overshoot gain smoothing as the limiter). Used on the
    foley bus to tame transient heads so the body of each sound can sit forward."""
    pk = np.max(np.abs(x), axis=0)
    over = np.maximum(0.0, lin2db(pk) - thr_db)
    g = db2lin(-over * (1 - 1.0 / ratio))
    W = max(1, nsamp(win))
    h = ndimage.minimum_filter1d(g, size=4 * W + 1, mode="nearest")
    sm = ndimage.uniform_filter1d(h, size=2 * W + 1, mode="nearest")
    sm = np.minimum(ndimage.uniform_filter1d(sm, size=2 * W + 1, mode="nearest"), 1.0)
    return x * sm, float(-lin2db(sm.min()))


def stem_dynamics(stems, G, cfg):
    """Scale stems by the master gain G, then per-stem peak control expressed in FINAL dBFS
    (so the settings are independent of gain staging). Returns processed stems + GR info."""
    out, info = {}, {}
    for k, x in stems.items():
        c = cfg.get(k, {})
        y = x * G
        gr_c = gr_l = 0.0
        if "comp_thr_dbfs" in c:
            y, gr_c = peak_compressor(y, c["comp_thr_dbfs"], c.get("ratio", 3.0), c.get("win", 0.004))
        if "limit_dbfs" in c:
            pk = np.max(np.abs(y), axis=0)
            g = np.minimum(1.0, db2lin(c["limit_dbfs"]) / np.maximum(pk, 1e-12))
            W = nsamp(c.get("lim_win", 0.008))
            h = ndimage.minimum_filter1d(g, size=4 * W + 1, mode="nearest")
            sm = ndimage.uniform_filter1d(h, size=2 * W + 1, mode="nearest")
            sm = np.minimum(ndimage.uniform_filter1d(sm, size=2 * W + 1, mode="nearest"), 1.0)
            y = y * sm
            gr_l = float(-lin2db(sm.min()))
        if gr_c or gr_l:  # gain modulation of asymmetric transients can leave a tiny DC component
            y = hp(y, 10, order=1)
        out[k] = y
        info[k] = (gr_c, gr_l)
    return out, info


def end_fade_env(cues, n):
    ef0, ef1 = cues.get("end_fade", [61.9, 62.0])
    t = tvec(n)
    return np.where(t < ef0, 1.0, np.cos(np.pi / 2 * np.clip((t - ef0) / (ef1 - ef0), 0, 1)) ** 2)


def master(stems, cues, log=print):
    """Iterate master gain so that the limited mix hits the integrated-loudness target."""
    target = cues.get("target_lufs", -14.0)
    endf = end_fade_env(cues, stems["music"].shape[1])
    ceiling = cues.get("limiter_ceiling_dbtp", -1.5)
    cfg = cues.get("stem_dynamics", {})
    G = db2lin(target - integrated_lufs(sum(stems.values())))
    for it in range(8):
        proc, info = stem_dynamics(stems, G, cfg)
        proc = {k: v * endf for k, v in proc.items()}
        pre = sum(proc.values())
        y, gr = limiter(pre, ceiling)
        L = integrated_lufs(y)
        if abs(L - target) < 0.03:
            break
        G *= db2lin(target - L)
    for k, (gc, gl) in info.items():
        if gc or gl:
            log(f"  {k:5s} stem dynamics: compressor max GR {gc:.1f} dB, limiter max GR {gl:.1f} dB")
    log(f"  master gain {lin2db(G):+.2f} dB ({it + 1} iterations), final limiter max GR {-lin2db(gr.min()):.2f} dB, "
        f"GR>1dB for {np.mean(gr < db2lin(-1)) * 100:.2f}% of samples")
    return y, proc, G, gr


# ---- SFX pack ----------------------------------------------------------------------------------


def write_pack(log=print):
    os.makedirs(PACK_DIR, exist_ok=True)
    P = lambda name: os.path.join(PACK_DIR, name + ".wav")
    r = lambda *k: seeded("pack", *k)
    one = {
        "door_open_creak": sfx_door_open(r("door_open"), creak=1.5).x,
        "door_close_click": sfx_door_close(r("door_close"), creak=0.45).x,
        "door_close_click_final": sfx_door_close(r("door_close_f"), creak=0.7, final=True).x,
        "latch_click": sfx_latch_click(r("latch"), kind="close").x,
        "latch_click_open": sfx_latch_click(r("latch_o"), kind="open").x,
        "floorboard_creak": sfx_floorboard_creak(r("floor")).x,
        "blanket_rustle": sfx_blanket_rustle(r("rustle"), 0.8, softness=0.6).x,
        "blanket_rustle_tuck": sfx_blanket_rustle(r("rustle_t"), 0.8, softness=0.45, strokes=2).x,
        "mattress_sit": sfx_mattress_sit(r("mattress")).x,
        "plush_squeak": sfx_plush_squeak(r("squeak")).x,
        "plush_pickup": sfx_plush_pickup(r("plush_up")).x,
        "plush_place": sfx_plush_place(r("plush")).x,
        "phone_pickup": sfx_phone_pickup(r("phone_up")).x,
        "phone_set_down_wood": sfx_phone_set_down_wood(r("phone_dn")).x,
        "lamp_switch_click": sfx_lamp_switch_click(r("lamp")).x,
        "counter_tick": sfx_counter_tick(r("tick")).x,
        "counter_tick_gold": sfx_counter_tick(r("tick_g"), gold=True).x,
        "gold_chime": sfx_gold_chime(r("gold"), shimmer=0.5).x,
        "sparkle_chime": sfx_gold_chime(r("sparkle"), notes=(81, 84, 89, 93, 96, 101), spacing=0.045,
                                        vel=0.42, shimmer=0.8).x,
        "tear_chime": sfx_gold_chime(r("tear"), notes=(96,), vel=0.35, dur=1.4).x,
        "whoosh_timeskip": sfx_whoosh_timeskip(r("whoosh")).x,
        "flash_swish": sfx_flash_swish(r("swish")).x,
    }
    for i in range(6):
        one[f"footstep_wood_soft_{i + 1:02d}"] = sfx_footstep(r("step", i), weight=0.85 + 0.05 * i,
                                                               scuff=0.8 + 0.08 * i).x
    seq = np.zeros(nsamp(6 * 0.56 + 0.4))
    for i in range(6):
        x = one[f"footstep_wood_soft_{i + 1:02d}"]
        k = nsamp(0.1 + i * 0.56)
        seq[k:k + len(x)] += x * (0.9 if i % 2 else 1.0)
    one["footstep_wood_soft"] = seq
    loops = {
        "crickets_loop": amb_crickets(10.5, r("crickets"), count=4, density=0.75),
        "clock_tick": amb_clock(4.0, r("clock")),
        "rain_window_loop": amb_rain_window(10.5, r("rain")),
        "wind_soft_loop": amb_wind(12.5, r("wind"), darkness=0.5, gust=0.6, whistle=0.1),
        "wind_winter_loop": amb_wind(10.5, r("wind_w"), darkness=0.72, gust=0.5, whistle=0.22),
        "snow_hush_loop": amb_wind(10.5, r("wind_s"), darkness=0.88, gust=0.3, whistle=0.0),
        "dry_leaves_loop": amb_dry_leaves(8.5, r("leaves")),
        "room_tone_loop": amb_room_tone(10.5, r("room")),
        "lamp_hum_loop": amb_lamp_hum(5.5, r("hum")),
    }
    for k in list(loops):
        if k != "clock_tick":
            loops[k] = make_loop(loops[k], 0.5)
    loops["sleigh_bells_soft"] = amb_sleigh_bells(3.0, r("bells"))
    end = piano_note(29, 0.45, 3.0)
    end = with_tail(end, 0.5)
    end = end + db2lin(-9) * convolve(end, hall_ir())[0]
    one["low_piano_end_note"] = fades(end, 0.0, 0.3)
    count = 0
    for name, x in {**one, **loops}.items():
        write_wav(P(name), norm(fades(x, 0.0005, 0.01) if "loop" not in name else x, db2lin(-3.0)), 24)
        count += 1
    log(f"  SFX pack: {count} files -> {PACK_DIR}")
    return sorted(list(one) + list(loops))


# ---- verification ------------------------------------------------------------------------------


def ffmpeg_ebur128(path):
    if not os.path.exists(FFMPEG):
        return None
    p = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null",
                        "-"], capture_output=True, text=True)
    txt = p.stderr
    summ = txt[txt.rfind("Summary:"):]
    I = re.search(r"I:\s+(-?[\d.]+) LUFS", summ)
    LRA = re.search(r"LRA:\s+(-?[\d.]+) LU", summ)
    TP = re.search(r"True peak:\s+Peak:\s+(-?[\d.inf]+) dBFS", summ)
    return {"I": float(I.group(1)) if I else None, "LRA": float(LRA.group(1)) if LRA else None,
            "TP": float(TP.group(1)) if TP else None}


def onset_report(sfx, expected):
    """For each foley cue: transient cues -> time of the largest 4 ms energy jump within -60/+80 ms,
    rise = level in the 40 ms after it minus min(background 250..80 ms before the cue,
    local level 24..4 ms before the onset);
    soft (gradual) cues -> from the envelope trough in [t-60, t+60 ms], first time the 25 ms envelope
    is within 8 dB of its max over [t, t+150 ms]; rise = that max minus the trough level."""
    x = hp(np.sum(sfx, axis=0), 150)
    H = 0.002
    hop = nsamp(H)
    e = ndimage.uniform_filter1d(x ** 2, size=nsamp(0.006))[::hop]
    d = 10 * np.log10(e + 1e-11)
    jump = np.concatenate([[0, 0], e[2:] - e[:-2]])
    ds = 10 * np.log10(ndimage.uniform_filter1d(x ** 2, size=nsamp(0.025))[::hop] + 1e-11)
    rows = []
    for t, name, cat, kind in expected:
        if cat == "roll":
            continue
        if cat not in ("door", "footstep", "prop", "cloth"):
            rows.append((t, name, cat, "ui", t, 0.0, 0.0, True))
            continue
        pre = float(np.median(d[max(0, int((t - 0.15) / H)):max(1, int((t - 0.03) / H))]))
        if kind == "soft":
            i0, i1 = int((t - 0.06) / H), int((t + 0.15) / H)
            post = float(ds[int(t / H):i1].max())
            kt = i0 + int(np.argmin(ds[i0:int((t + 0.06) / H)]))  # trough just before the sound
            k = kt + int(np.argmax(ds[kt:i1] >= post - 8))
            pre = min(float(ds[kt]), float(np.median(ds[max(0, int((t - 0.15) / H)):max(1, int((t - 0.03) / H))])))
            tol, need = 80, 4
        else:
            i0, i1 = max(2, int((t - 0.06) / H)), int((t + 0.08) / H)
            k = i0 + int(np.argmax(jump[i0:i1]))
            post = float(np.max(d[k:k + 20]))
            bg = float(np.median(d[max(0, int((t - 0.25) / H)):max(1, int((t - 0.08) / H))]))
            loc = float(np.mean(d[max(0, k - 12):max(1, k - 2)]))  # 24..4 ms before the onset
            pre = min(bg, loc)  # passes if it stands out from the background OR locally
            tol, need = 30, 6
        to = k * H
        dms = (to - t) * 1000
        ok = abs(dms) <= tol and post - pre >= need
        rows.append((t, name, cat, kind, to, dms, post - pre, ok))
    return rows


def l100_at(x, t, span=0.4):
    """Max 100 ms K-weighted loudness within [t-0.02, t+span] (event loudness of short foley)."""
    a = max(0, nsamp(t - 0.5))
    y = k_weight(np.atleast_2d(x)[:, a:nsamp(t + span + 0.1)])[:, nsamp(t - 0.02) - a:]
    p = ndimage.uniform_filter1d(np.sum(y ** 2, axis=0), size=nsamp(0.1))
    return -0.691 + 10 * np.log10(np.max(p[: nsamp(span)]) + 1e-20)


def momentary_at(x, t, dur=0.4):
    """Momentary loudness of the 400 ms window starting 50 ms before t (K-filter run from t-0.55)."""
    a = max(0, nsamp(t - 0.55))
    seg = k_weight(np.atleast_2d(x)[:, a:nsamp(t - 0.05 + dur)])
    seg = seg[:, -nsamp(dur):]
    return -0.691 + 10 * np.log10(np.mean(np.sum(seg ** 2, axis=0)) + 1e-20)


def verify(cues, proc, gr, notes, expected, duck=None, log=print):
    N = nsamp(cues["duration"])
    log("\n================ SELF-VERIFICATION ================")
    files = {"master": os.path.join(OUT_DIR, "audio.wav")}
    files.update({k: os.path.join(STEM_DIR, k + ".wav") for k in proc})
    data = {}
    for k, p in files.items():
        sr, bits, y = read_wav(p)
        data[k] = y
        log(f"{k:7s} {os.path.relpath(p, ROOT):22s} sr={sr} bits={bits} ch={y.shape[0]} samples={y.shape[1]} "
            f"({y.shape[1] / sr:.6f} s) {'OK' if y.shape[1] == N else 'LENGTH MISMATCH'}  "
            f"nan/inf={int(np.sum(~np.isfinite(y)))} peak={lin2db(np.max(np.abs(y))):.2f} dBFS "
            f"DC=[{np.mean(y[0]):+.1e},{np.mean(y[1]):+.1e}]")
    m = data["master"]
    clip = int(np.sum(np.abs(m) >= 0.99999))
    log(f"clipped samples in master: {clip}")
    log(f"internal BS.1770: integrated {integrated_lufs(m):.2f} LUFS, true peak (4x) {true_peak_db(m):.2f} dBTP")
    eb = ffmpeg_ebur128(files["master"])
    if eb:
        log(f"ffmpeg ebur128 : I = {eb['I']} LUFS, LRA = {eb['LRA']} LU, True peak = {eb['TP']} dBFS")
    # stems vs master
    ssum = sum(data[k] for k in proc)
    pre = sum(proc.values())
    log(f"stems sum vs pre-limiter master: residual {lin2db(rms(ssum - pre) / rms(pre)):.1f} dB rel "
        f"(max abs diff {np.max(np.abs(ssum - pre)):.2e})")
    log(f"stems sum vs final master      : residual {lin2db(rms(ssum - m) / rms(m)):.1f} dB rel "
        f"(difference = limiter only; max GR {-lin2db(gr.min()):.2f} dB)")
    mono = np.vstack([(m[0] + m[1]) / 2] * 2)
    log(f"mono fold-down: {integrated_lufs(mono) - integrated_lufs(m):+.2f} LU vs stereo; "
        f"L/R correlation {np.corrcoef(m[0], m[1])[0, 1]:.2f}")
    if duck is not None:
        for d in cues["music"].get("ducks", []):
            seg = duck[nsamp(d["t0"]):nsamp(d["t1"])]
            log(f"music duck {d['t0']:.2f}-{d['t1']:.2f}s: {lin2db(seg.min()):.1f} dB (explicit {d['db']} dB)")
        log(f"foley-keyed music duck active (< -1 dB) {np.mean(duck < db2lin(-1)) * 100:.0f}% of the time")
    tail = m[:, -nsamp(0.01):]
    log(f"last 10 ms peak {lin2db(np.max(np.abs(tail))):.1f} dBFS; first sample {m[:, 0]}, last sample {m[:, -1]}")
    # house rule: once the music has started it must never drop out (user feedback on 002)
    mus = proc.get("music") if isinstance(proc, dict) else None
    if mus is not None:
        hop = nsamp(0.05)
        mono = mus.mean(axis=0)
        w = np.array([np.sqrt(np.mean(mono[i * hop:(i + 1) * hop] ** 2)) + 1e-12 for i in range(len(mono) // hop)])
        wdb = 20 * np.log10(w)
        on = np.where(wdb > wdb.max() - 30)[0]
        if len(on):
            a0, a1 = on[0] + 10, min(len(wdb), on[-1] - 10)       # ignore the entrance + the final fade
            med = np.median(wdb[a0:a1]) if a1 > a0 else 0
            drops = [i * 0.05 for i in range(a0, a1) if wdb[i] < med - 12]
            log(f"music dropouts (>12 dB under median, {a0 * 0.05:.1f}-{a1 * 0.05:.1f}s): " + ("none" if not drops else f"{len(drops)} windows, first at {drops[0]:.2f}s  <-- FIX (music must never cut out)"))
            if drops:  # grouped ranges, so you know which section to fill (a pad / a longer note / a pickup)
                grp = []
                for d in drops:
                    if grp and d - grp[-1][1] <= 0.06: grp[-1][1] = d
                    else: grp.append([d, d])
                log("   dropout ranges: " + ", ".join(f"{g0:.2f}-{g1 + 0.05:.2f}s" for g0, g1 in grp[:12]) + (" …" if len(grp) > 12 else ""))
    shots = cues["shots"]
    log("\nper-shot window | master peak   RMS   LUFS | music   sfx    amb (ungated LUFS) | limiter maxGR %>1dB")
    for a, b in zip(shots[:-1], shots[1:]):
        seg = m[:, nsamp(a):nsamp(b)]
        gs = gr[nsamp(a):nsamp(b)]
        log(f"{a:5.1f}-{b:5.1f}     | {lin2db(np.max(np.abs(seg))):6.1f} {lin2db(rms(seg)):6.1f} "
            f"{window_lufs(m, a, b):6.1f} | {window_lufs(data['music'], a, b):6.1f} "
            f"{window_lufs(data['sfx'], a, b):6.1f} {window_lufs(data['amb'], a, b):6.1f}             | "
            f"{-lin2db(gs.min()):5.2f} {np.mean(gs < db2lin(-1)) * 100:6.2f}")
    rows = onset_report(data["sfx"], expected)
    log("\nonset check on sfx stem (transient: tol 30 ms, rise >= 6 dB; soft/gradual: tol 80 ms, rise >= 4 dB)")
    log("   cue t   sound                cat       kind       detected  delta ms  rise dB | L100sfx M(mus) pk(sfx)  ok")
    bad = 0
    margin = {}
    for t, name, cat, kind, to, dms, rise, ok in rows:
        bad += (not ok) and kind != "ui"
        ls, mm = l100_at(data["sfx"], t), momentary_at(data["music"], t)
        margin.setdefault(cat, []).append(ls - mm)
        pk = lin2db(np.max(np.abs(data["sfx"][:, max(0, nsamp(t - 0.02)):nsamp(t + 0.3) + 1])) + 1e-12)
        log(f"  {t:7.3f}  {name:19s}  {cat:8s}  {kind:9s} {to:9.3f}  {dms:+7.1f}  {rise:7.1f} | {ls:6.1f} {mm:6.1f}"
            f"  {pk:6.1f}   {'OK' if ok else '--'}")
    log(f"onsets checked: {sum(r[3] != 'ui' for r in rows)}, failing: {bad}")
    log("foley-over-music margin (L100 of sfx minus momentary music), per category: " + ", ".join(
        f"{c} median {np.median(v):+.1f} / min {np.min(v):+.1f} dB" for c, v in margin.items()))
    return rows


# ---- main ---------------------------------------------------------------------------------------


def sfx_portal_wub(rng, dur=0.9, pitch=1.0, swallow=0.0):
    """A cartoon portal (042): a soft swirling 'vwoom' — a round low sine that glides up (opening) or down (swallow > 0.5,
    something sucked in), wobbling at ~7 Hz, over a slowly turning band of pink noise. Low-passed, no whoosh hiss."""
    n = nsamp(dur)
    t = tvec(n)
    u = t / dur
    glide = (1 - u) if swallow > 0.5 else u
    f = (70 + 120 * glide) * pitch * (1 + 0.06 * np.sin(2 * np.pi * 7 * t))
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.35 * np.sin(4 * np.pi * np.cumsum(f) / SR)
    swirl = sweep_filter(pink(n, rng), (300 + 500 * (0.5 + 0.5 * np.sin(2 * np.pi * 3.2 * t))) * pitch, q=1.4, kind="bp")
    env = np.sin(np.pi * np.clip(u, 0, 1)) ** (0.6 if swallow > 0.5 else 1.2)
    y = env * (unit_rms(tone) + 0.45 * unit_rms(swirl))
    return Sound(norm(fades(lp(y, 2200), 0.01, 0.06)), onsets=[(0.0, "soft")])


SFX.update({"portal_wub": (sfx_portal_wub, "prop")})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="?", help="video folder under videos/ (reads videos/<video>/cues.json, writes videos/<video>/audio.wav)")
    ap.add_argument("--cues", help="JSON cue sheet (same schema as DEFAULT_CUES)")
    ap.add_argument("--dump-cues", action="store_true")
    ap.add_argument("--no-pack", action="store_true")
    ap.add_argument("--no-verify", action="store_true")
    ap.add_argument("--out", help="(Nomen) write audio.wav + stems/ here and read the cue sheet's voice file from here")
    a = ap.parse_args(argv)
    global OUT_DIR, STEM_DIR
    cues = DEFAULT_CUES
    if a.out:
        OUT_DIR, STEM_DIR = a.out, os.path.join(a.out, "stems")
        a.no_pack = True
    if a.video:
        vdir = os.path.join(ROOT, "videos", os.path.basename(a.video.rstrip("/")))
        a.cues = a.cues or os.path.join(vdir, "cues.json")
        OUT_DIR, STEM_DIR = vdir, os.path.join(vdir, "out", "stems")
        a.no_pack = True
    if a.cues:
        with open(a.cues) as f:
            cues = json.load(f)
    if a.dump_cues:
        print(json.dumps(cues, indent=1))
        return
    T = time.time()
    print(f"rendering '{cues.get('title', '')}' ({cues['duration']} s @ {SR} Hz)")
    stems, expected, notes = render_mix(cues)
    duck = stems.pop("_duck")
    y, proc, g, gr = master(stems, cues)
    for k in proc:
        if not np.all(np.isfinite(proc[k])):
            raise RuntimeError(f"non-finite samples in stem {k}")
    write_wav(os.path.join(OUT_DIR, "audio.wav"), y, 24)
    for k, sg in proc.items():
        bits = 24 if np.max(np.abs(sg)) < 0.9999 else 32
        write_wav(os.path.join(STEM_DIR, k + ".wav"), sg, bits)
    print(f"  wrote {os.path.join(OUT_DIR, 'audio.wav')} + stems  ({time.time() - T:.1f}s)")
    if not a.no_pack:
        write_pack()
    if not a.no_verify:
        verify(cues, proc, gr, notes, expected, duck)
    print(f"done in {time.time() - T:.1f}s")


if __name__ == "__main__":
    main()
