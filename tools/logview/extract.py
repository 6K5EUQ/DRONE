#!/usr/bin/env python3
"""ArduPilot .BIN 로그 하나를 읽어 웹 뷰어가 쓸 JSON 을 만든다.

오프라인 단독 뷰어(viewer.html)용. 웹(drone01.bewe.co.kr)은 web/extract.py 를 쓴다.

사용법:
    extract.py <path.BIN> [...]   ->  같은 이름 .json 을 옆에 만든다
"""
import json
import math
import os
import sys

from pymavlink import mavutil


def clean(vals):
    """NaN/Inf 를 None 으로 — JSON 이 못 담는다."""
    out = []
    for v in vals:
        if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
            out.append(None)
        else:
            out.append(round(v, 4) if isinstance(v, float) else v)
    return out


def summarize(path):
    m = mavutil.mavlink_connection(path)

    t = {k: [] for k in ("att", "gps", "bat", "vibe", "rcou", "ctun", "ev", "msg", "err", "mode")}
    fw = None
    frame_hint = None
    tmin = tmax = None

    while True:
        try:
            msg = m.recv_match()
        except Exception:
            continue
        if msg is None:
            break
        mt = msg.get_type()

        if hasattr(msg, "TimeUS"):
            ts = msg.TimeUS / 1e6
            tmin = ts if tmin is None else min(tmin, ts)
            tmax = ts if tmax is None else max(tmax, ts)
        else:
            ts = None

        if mt == "MSG":
            txt = msg.Message
            if "ArduCopter" in txt or "ArduPlane" in txt:
                fw = txt
            if "Frame:" in txt:
                frame_hint = txt
            t["msg"].append((ts, txt))
        elif mt == "ERR":
            t["err"].append((ts, msg.Subsys, msg.ECode))
        elif mt == "EV":
            t["ev"].append((ts, msg.Id))
        elif mt == "MODE":
            t["mode"].append((ts, msg.Mode))
        elif mt == "ATT":
            t["att"].append((ts, msg.Roll, msg.Pitch, msg.Yaw,
                              msg.DesRoll, msg.DesPitch, msg.DesYaw))
        elif mt == "GPS":
            t["gps"].append((ts, msg.Status, msg.NSats, msg.HDop,
                              msg.Lat, msg.Lng, msg.Alt))
        elif mt == "BAT":
            t["bat"].append((ts, msg.Volt, msg.Curr, msg.CurrTot))
        elif mt == "VIBE":
            t["vibe"].append((ts, msg.VibeX, msg.VibeY, msg.VibeZ,
                               msg.Clip0, msg.Clip1, msg.Clip2))
        elif mt == "RCOU":
            t["rcou"].append((ts, getattr(msg, "C1", 0), getattr(msg, "C2", 0),
                               getattr(msg, "C3", 0), getattr(msg, "C4", 0)))
        elif mt == "CTUN":
            t["ctun"].append((ts, msg.Alt, msg.ThO, msg.DAlt))

    dur = (tmax - tmin) if tmin is not None else 0

    # 최고고도 (CTUN.Alt 기준, 없으면 GPS.Alt)
    alt_max = max((r[1] for r in t["ctun"] if r[1] is not None), default=0)

    gps_fix_max = max((r[1] for r in t["gps"]), default=0)
    gps_sats_max = max((r[2] for r in t["gps"]), default=0)

    arm_count = sum(1 for _, i in t["ev"] if i == 10)  # EV 10 = ARMED

    curr_max = max((r[2] for r in t["bat"] if r[2] is not None), default=0)
    volt_min = min((r[1] for r in t["bat"] if r[1] and r[1] > 5), default=0)

    vibe_max = max(
        (max(r[1] or 0, r[2] or 0, r[3] or 0) for r in t["vibe"]), default=0
    )
    clip_total = sum((r[4] or 0) + (r[5] or 0) + (r[6] or 0) for r in t["vibe"])

    crash = any("Crash" in txt for _, txt in t["msg"])

    # 다운샘플 — 브라우저가 그릴 수 있는 크기로 (최대 2000점)
    def downsample(rows, maxpts=2000):
        if len(rows) <= maxpts:
            return rows
        step = len(rows) / maxpts
        return [rows[int(i * step)] for i in range(maxpts)]

    return {
        "file": os.path.basename(path),
        "firmware": fw,
        "frame_hint": frame_hint,
        "duration_s": round(dur, 1),
        "arm_count": arm_count,
        "alt_max_m": round(alt_max, 2) if alt_max else 0,
        "gps_fix_max": gps_fix_max,
        "gps_sats_max": gps_sats_max,
        "volt_min_v": round(volt_min, 2) if volt_min else None,
        "curr_max_a": round(curr_max, 2) if curr_max else None,
        "vibe_max": round(vibe_max, 3),
        "clip_total": clip_total,
        "crash": crash,
        "series": {
            "att": clean_rows(downsample(t["att"])),
            "gps": clean_rows(downsample(t["gps"])),
            "bat": clean_rows(downsample(t["bat"])),
            "vibe": clean_rows(downsample(t["vibe"])),
            "rcou": clean_rows(downsample(t["rcou"])),
            "ctun": clean_rows(downsample(t["ctun"])),
        },
        "events": [{"t": ts, "text": txt} for ts, txt in t["msg"] if ts is not None],
        "errors": [{"t": ts, "subsys": s, "code": c} for ts, s, c in t["err"]],
        "modes": [{"t": ts, "mode": mo} for ts, mo in t["mode"]],
    }


def clean_rows(rows):
    return [clean(r) for r in rows]


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: extract.py <path.BIN> [...]")
    for path in sys.argv[1:]:
        data = summarize(path)
        out = os.path.splitext(path)[0] + ".json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        print(f"{path} -> {out}  ({data['duration_s']}s, {len(data['events'])}개 이벤트)")


if __name__ == "__main__":
    main()
