import base64
import csv
import datetime
import os
import sqlite3
import uuid

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(OUT_DIR, "glucose.db")
CSV_PATH = os.path.join(OUT_DIR, "glucose_records.csv")
INLINE_JS_PATH = os.path.join(OUT_DIR, "glucose_db_inline.js")

PERIODS = {
    "fasting": {
        "label": "空腹",
        "loinc": "1558-6",
        "display": "Fasting glucose [Mass/volume] in Serum or Plasma",
        "high": 130,
    },
    "premeal": {
        "label": "餐前",
        "loinc": "2339-0",
        "display": "Glucose [Mass/volume] in Blood",
        "high": 130,
    },
    "post2h": {
        "label": "餐後2h",
        "loinc": "1521-4",
        "display": "Glucose [Mass/volume] in Serum or Plasma --2 hours post meal",
        "high": 180,
    },
    "random": {
        "label": "其他",
        "loinc": "2339-0",
        "display": "Glucose [Mass/volume] in Blood",
        "high": 180,
    },
}


def mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def rand():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = (t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) ^ t
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rand


def interp_code(period, value):
    if value < 70:
        return "L"
    return "H" if value > PERIODS[period]["high"] else "N"


def deterministic_uuid(rand):
    hex_chars = "0123456789abcdef"
    out = []
    for c in "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx":
        if c == "x":
            out.append(hex_chars[int(rand() * 16)])
        elif c == "y":
            r = int(rand() * 16)
            out.append(hex_chars[(r & 0x3) | 0x8])
        else:
            out.append(c)
    return "".join(out)


def generate_records():
    rand = mulberry32(20261019)
    ri = lambda a, b: round(a + rand() * (b - a))
    base_date = datetime.date(2026, 10, 20)
    records = []

    fasting_notes = ["晨起空腹例行量測", "早餐前量測", "規律服藥後晨測", "睡眠充足", "前一晚較晚進食"]
    post_notes = ["午餐後2小時", "晚餐後2小時", "外食便當飯量較多", "餐後散步15分鐘", "聚餐後量測"]

    for d in range(72, 0, -1):
        day = base_date - datetime.timedelta(days=d)
        if rand() < 0.82:
            hour = 7
            minute = ri(0, 40)
            val = ri(94, 142)
            period = "fasting"
            p_info = PERIODS[period]
            interp = interp_code(period, val)
            iso_time = f"{day.isoformat()}T{hour:02d}:{minute:02d}:00+08:00"
            note = fasting_notes[ri(0, len(fasting_notes) - 1)]
            records.append(
                {
                    "id": deterministic_uuid(rand),
                    "patient_id": "A12****789",
                    "patient_name": "衛斯理 先生",
                    "recorded_at": iso_time,
                    "slot": "早上",
                    "period": period,
                    "period_label": p_info["label"],
                    "loinc_code": p_info["loinc"],
                    "loinc_display": p_info["display"],
                    "value": val,
                    "unit": "mg/dL",
                    "interpretation": interp,
                    "source": "seed",
                    "note": note,
                }
            )
        if rand() < 0.38:
            hour = ri(13, 20)
            minute = ri(0, 59)
            val = ri(136, 232)
            period = "post2h"
            p_info = PERIODS[period]
            interp = interp_code(period, val)
            slot = "中午" if hour < 16 else "晚上"
            iso_time = f"{day.isoformat()}T{hour:02d}:{minute:02d}:00+08:00"
            note = post_notes[ri(0, len(post_notes) - 1)]
            records.append(
                {
                    "id": deterministic_uuid(rand),
                    "patient_id": "A12****789",
                    "patient_name": "衛斯理 先生",
                    "recorded_at": iso_time,
                    "slot": slot,
                    "period": period,
                    "period_label": p_info["label"],
                    "loinc_code": p_info["loinc"],
                    "loinc_display": p_info["display"],
                    "value": val,
                    "unit": "mg/dL",
                    "interpretation": interp,
                    "source": "seed",
                    "note": note,
                }
            )
    return records


def main():
    records = generate_records()
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE glucose_records (
            id TEXT PRIMARY KEY,
            patient_id TEXT NOT NULL,
            patient_name TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            slot TEXT NOT NULL,
            period TEXT NOT NULL,
            period_label TEXT NOT NULL,
            loinc_code TEXT NOT NULL,
            loinc_display TEXT NOT NULL,
            value INTEGER NOT NULL,
            unit TEXT NOT NULL DEFAULT 'mg/dL',
            interpretation TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'seed',
            note TEXT DEFAULT ''
        )
        """
    )
    cur.execute("CREATE INDEX idx_glucose_recorded_at ON glucose_records(recorded_at DESC)")

    cur.executemany(
        """
        INSERT INTO glucose_records (
            id, patient_id, patient_name, recorded_at, slot,
            period, period_label, loinc_code, loinc_display,
            value, unit, interpretation, source, note
        ) VALUES (
            :id, :patient_id, :patient_name, :recorded_at, :slot,
            :period, :period_label, :loinc_code, :loinc_display,
            :value, :unit, :interpretation, :source, :note
        )
        """,
        records,
    )
    conn.commit()
    conn.close()

    fieldnames = [
        "id",
        "patient_id",
        "patient_name",
        "recorded_at",
        "slot",
        "period",
        "period_label",
        "loinc_code",
        "loinc_display",
        "value",
        "unit",
        "interpretation",
        "source",
        "note",
    ]
    with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(records)

    with open(DB_PATH, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    with open(INLINE_JS_PATH, "w", encoding="utf-8") as f:
        f.write("// Auto-generated from data/glucose.db for file:// fallback\n")
        f.write(f'window.__SEED_SQLITE_B64__ = "{b64}";\n')

    print(f"Generated {len(records)} records:")
    print(f" - SQLite DB: {DB_PATH} ({os.path.getsize(DB_PATH)} bytes)")
    print(f" - CSV file:  {CSV_PATH} ({os.path.getsize(CSV_PATH)} bytes)")
    print(f" - Inline JS: {INLINE_JS_PATH} ({os.path.getsize(INLINE_JS_PATH)} bytes)")


if __name__ == "__main__":
    main()
