"""Builds an original, freely usable test video for the video-analysis pipeline: a narrated MNQ 5m chart walkthrough.

Frames are drawn with Pillow; narration uses Windows' built-in speech synthesizer; FFmpeg muxes them so each
sentence plays while its matching chart state is on screen. Usage: python make_sample_video.py OUT_DIR
Outputs: sample.mp4 (with audio), sample_noaudio.mp4, sample_lowq.mp4 (tiny + heavy compression), sample_long.mp4 (~12 min).
"""
import os
import random
import subprocess
import sys
import wave

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

FF = imageio_ffmpeg.get_ffmpeg_exe()
W, H = 1280, 720
SCENES = [
    ("title", "In this video I will show my liquidity sweep and fair value gap entry model on the M N Q five minute chart."),
    ("eqh", "First, mark the equal highs. That is buy side liquidity, where stop orders are resting."),
    ("sweep", "Here price trades above the equal highs, takes the stops, and closes back below. That is the liquidity sweep."),
    ("mss", "Next, a strong bearish displacement candle breaks the last swing low. That is the market structure shift."),
    ("fvg", "The displacement leaves a bearish fair value gap, shown by the purple box."),
    ("plan", "My entry is a sell limit at the bottom of the fair value gap, with the stop just above the sweep high, and the target at the next liquidity below."),
    ("session", "I only take this setup during the New York session, when volatility is high."),
]


def font(n):
    for f in ("segoeuib.ttf", "arialbd.ttf"):
        try:
            return ImageFont.truetype(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", f), n)
        except OSError:
            continue
    return ImageFont.load_default()


def candles():
    random.seed(4)
    out, p = [], 21000.0
    for i in range(46):
        o = p
        if i < 18:
            c = o + random.uniform(-14, 18)
        elif i in (19, 27):
            c = o + 6  # the two equal highs are set by wicks below
        elif i == 33:
            c = o - 4  # sweep candle: wick above, closes back below
        elif i == 35:
            c = o - 120  # displacement
        elif i > 35:
            c = o + random.uniform(-10, 8)
        else:
            c = o + random.uniform(-12, 10)
        h, l = max(o, c) + random.uniform(2, 8), min(o, c) - random.uniform(2, 8)
        out.append([o, h, l, c])
        p = c
    top = max(x[1] for x in out[:33]) + 4
    out[19][1] = out[27][1] = top  # equal highs
    out[33][1] = top + 22  # sweep wick
    return out, top


def draw(stage, bars, eqh):
    im = Image.new("RGB", (W, H), (10, 12, 18))
    d = ImageDraw.Draw(im)
    if stage == "title":
        d.text((W // 2, 300), "Liquidity Sweep + FVG Entry Model", fill=(242, 244, 248), font=font(54), anchor="mm")
        d.text((W // 2, 380), "MNQ  5m  walkthrough", fill=(154, 164, 181), font=font(30), anchor="mm")
        return im
    order = ["eqh", "sweep", "mss", "fvg", "plan", "session"]
    k = order.index(stage)
    shown = {0: 32, 1: 34, 2: 36, 3: 37, 4: 40, 5: 46}[k]
    lo, hi = min(b[2] for b in bars) - 90, max(b[1] for b in bars) + 30
    y = lambda p: 70 + (hi - p) / (hi - lo) * (H - 140)
    x = lambda i: 70 + i * 25
    for i, (o, h, l, c) in enumerate(bars[:shown]):
        col = (34, 197, 94) if c >= o else (239, 68, 68)
        d.line([x(i) + 7, y(h), x(i) + 7, y(l)], fill=col, width=2)
        d.rectangle([x(i), y(max(o, c)), x(i) + 14, y(min(o, c)) + 1], fill=col)
    d.text((24, 20), "MNQ  5m", fill=(242, 244, 248), font=font(28))
    purple, amber = (139, 92, 246), (245, 158, 11)
    d.line([x(19), y(eqh), x(28) + 14, y(eqh)], fill=amber, width=3)
    d.text((x(19), y(eqh) - 34), "Equal highs = buy-side liquidity", fill=amber, font=font(22))
    if k >= 1:
        d.ellipse([x(33) - 10, y(bars[33][1]) - 12, x(33) + 24, y(bars[33][1]) + 14], outline=amber, width=3)
        d.text((x(33) - 20, y(bars[33][1]) - 44), "Sweep", fill=amber, font=font(24))
    if k >= 2:
        low = min(b[2] for b in bars[28:34])
        d.line([x(28), y(low), x(36) + 14, y(low)], fill=(239, 68, 68), width=3)
        d.text((x(28) - 70, y(low) - 14), "MSS", fill=(239, 68, 68), font=font(26))
    if k >= 3:
        top, bot = bars[34][2], bars[36][1]
        d.rectangle([x(35), y(top), x(45) + 14, y(bot)], outline=purple, width=3)
        d.text((x(38), y(top) + 8), "Bearish FVG", fill=purple, font=font(24))
    if k >= 4:
        for price, col, lab in ((bars[36][1], (154, 164, 181), "Entry: sell limit"), (bars[33][1] + 3, (239, 68, 68), "Stop"),
                                (min(b[2] for b in bars) - 60, (34, 197, 94), "Target: next liquidity")):
            for xx in range(x(36), W - 40, 18):
                d.line([xx, y(price), xx + 9, y(price)], fill=col, width=2)
            d.text((W - 300, y(price) - 26), lab, fill=col, font=font(20))
    if k >= 5:
        d.rectangle([W - 380, 20, W - 24, 70], fill=(25, 32, 45))
        d.text((W - 360, 30), "New York session only", fill=(242, 244, 248), font=font(26))
    return im


def say(text, wav):
    ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; "
          "$s.SetOutputToWaveFile('%s'); $s.Speak('%s'); $s.Dispose()" % (wav, text.replace("'", "''")))
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    with wave.open(wav) as w:
        return w.getnframes() / w.getframerate()


def main(out):
    os.makedirs(out, exist_ok=True)
    bars, eqh = candles()
    concat, alist, t = [], [], 0.0
    for i, (stage, text) in enumerate(SCENES):
        png, wav = os.path.join(out, "s%d.png" % i), os.path.join(out, "s%d.wav" % i)
        draw(stage, bars, eqh).save(png)
        dur = say(text, wav) + 0.8
        concat.append("file '%s'\nduration %.3f\n" % (png.replace("\\", "/"), dur))
        alist.append("file '%s'\n" % wav.replace("\\", "/"))
        print("%5.1fs  %-8s %s" % (t, stage, text))
        t += dur
    concat.append("file '%s'\n" % os.path.join(out, "s%d.png" % (len(SCENES) - 1)).replace("\\", "/"))
    with open(os.path.join(out, "v.txt"), "w") as f:
        f.write("".join(concat))
    with open(os.path.join(out, "a.txt"), "w") as f:
        f.write("".join(alist))
    # pad each sentence to its scene length so audio and pictures stay aligned
    pads = []
    for i in range(len(SCENES)):
        p = os.path.join(out, "p%d.wav" % i)
        subprocess.run([FF, "-v", "error", "-y", "-i", os.path.join(out, "s%d.wav" % i), "-af", "apad=pad_dur=0.8", "-ar", "22050", "-ac", "1", p], check=True)
        pads.append("file '%s'\n" % p.replace("\\", "/"))
    with open(os.path.join(out, "a.txt"), "w") as f:
        f.write("".join(pads))
    sample = os.path.join(out, "sample.mp4")
    subprocess.run([FF, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", os.path.join(out, "v.txt"), "-f", "concat", "-safe", "0",
                    "-i", os.path.join(out, "a.txt"), "-vf", "fps=10,format=yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", sample], check=True)
    subprocess.run([FF, "-v", "error", "-y", "-i", sample, "-an", "-c:v", "copy", os.path.join(out, "sample_noaudio.mp4")], check=True)
    subprocess.run([FF, "-v", "error", "-y", "-i", sample, "-vf", "scale=320:180", "-c:v", "libx264", "-crf", "42", "-c:a", "aac", "-b:a", "24k",
                    os.path.join(out, "sample_lowq.mp4")], check=True)
    subprocess.run([FF, "-v", "error", "-y", "-stream_loop", "15", "-i", sample, "-c", "copy", os.path.join(out, "sample_long.mp4")], check=True)
    print("done:", t, "s")


if __name__ == "__main__":
    main(sys.argv[1])
