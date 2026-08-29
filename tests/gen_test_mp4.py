#!/usr/bin/env python3
"""Genera archivos MP4/MOV mínimos pero estructuralmente válidos para probar RotarCore."""
import struct, json, os, sys

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

def box(t, *payloads):
    data = b"".join(payloads)
    return struct.pack(">I", 8 + len(data)) + t + data

def full(t, ver, flags, payload):
    return box(t, bytes([ver]) + flags.to_bytes(3, "big") + payload)

IDENT = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]

def matrix(angle, W, H):
    FX = 0x10000
    m = {
        0:   [FX, 0, 0,  0, FX, 0,  0, 0, 0x40000000],
        90:  [0, FX, 0,  -FX, 0, 0,  H * FX, 0, 0x40000000],
        180: [-FX, 0, 0,  0, -FX, 0,  W * FX, H * FX, 0x40000000],
        270: [0, -FX, 0,  FX, 0, 0,  0, W * FX, 0x40000000],
    }[angle]
    return b"".join(struct.pack(">i", v) for v in m)

def tkhd(version, angle, W, H, track_id=1):
    if version == 1:
        head = struct.pack(">QQIIQ", 0, 0, track_id, 0, 0)
    else:
        head = struct.pack(">IIIII", 0, 0, track_id, 0, 0)
    body = head + b"\x00" * 8 + struct.pack(">HHHH", 0, 0, 0, 0)
    body += matrix(angle, W, H)
    body += struct.pack(">II", W << 16, H << 16)
    return full(b"tkhd", version, 3, body)

def mdhd():
    return full(b"mdhd", 0, 0, struct.pack(">IIIIHH", 0, 0, 600, 600, 0x55C4, 0))

def hdlr(kind):
    return full(b"hdlr", 0, 0, b"\x00" * 4 + kind + b"\x00" * 12 + b"\x00")

def dinf():
    url = full(b"url ", 0, 1, b"")
    return box(b"dinf", full(b"dref", 0, 0, struct.pack(">I", 1) + url))

def stsd_video(codec, W, H):
    entry = box(codec,
        b"\x00" * 6 + struct.pack(">H", 1) +
        struct.pack(">HH", 0, 0) + b"\x00" * 12 +
        struct.pack(">HH", W, H) +
        struct.pack(">II", 0x00480000, 0x00480000) +
        b"\x00" * 4 + struct.pack(">H", 1) +
        b"\x00" * 32 + struct.pack(">Hh", 24, -1))
    return full(b"stsd", 0, 0, struct.pack(">I", 1) + entry)

def stsd_audio():
    entry = box(b"mp4a",
        b"\x00" * 6 + struct.pack(">H", 1) +
        struct.pack(">HHIHHHH", 0, 0, 0, 2, 16, 0, 0) + struct.pack(">I", 44100 << 16))
    return full(b"stsd", 0, 0, struct.pack(">I", 1) + entry)

def stbl(stsd):
    stts = full(b"stts", 0, 0, struct.pack(">I", 0))
    stsc = full(b"stsc", 0, 0, struct.pack(">I", 0))
    stsz = full(b"stsz", 0, 0, struct.pack(">II", 0, 0))
    stco = full(b"stco", 0, 0, struct.pack(">I", 0))
    return box(b"stbl", stsd, stts, stsc, stsz, stco)

def trak_video(version, angle, W, H, codec=b"avc1", track_id=1):
    vmhd = full(b"vmhd", 0, 1, struct.pack(">HHHH", 0, 0, 0, 0))
    minf = box(b"minf", vmhd, dinf(), stbl(stsd_video(codec, W, H)))
    mdia = box(b"mdia", mdhd(), hdlr(b"vide"), minf)
    return box(b"trak", tkhd(version, angle, W, H, track_id), mdia)

def trak_audio(track_id=2):
    smhd = full(b"smhd", 0, 0, struct.pack(">HH", 0, 0))
    minf = box(b"minf", smhd, dinf(), stbl(stsd_audio()))
    mdia = box(b"mdia", mdhd(), hdlr(b"soun"), minf)
    # tkhd de audio: W/H a 0, matriz identidad
    return box(b"trak", tkhd(0, 0, 0, 0, track_id), mdia)

def mvhd():
    body = struct.pack(">IIIII", 0, 0, 600, 600, 0x00010000)
    body += struct.pack(">H", 0x0100) + b"\x00" * 10
    body += b"".join(struct.pack(">i", v) for v in IDENT)
    body += b"\x00" * 24 + struct.pack(">I", 3)
    return full(b"mvhd", 0, 0, body)

def ftyp(major, compat):
    return box(b"ftyp", major + struct.pack(">I", 0x200) + compat)

def mdat64(payload):
    return struct.pack(">I", 1) + b"mdat" + struct.pack(">Q", 16 + len(payload)) + payload

def find_video_matrix_offsets(data, video_track_ids):
    """Localiza (independientemente del parser JS) la matriz de cada tkhd por búsqueda de firma."""
    offsets = []
    pos = 0
    while True:
        pos = data.find(b"tkhd", pos)
        if pos < 0:
            break
        content = pos + 4
        version = data[content]
        tid_off = content + 4 + (16 if version == 1 else 8)
        track_id = struct.unpack(">I", data[tid_off:tid_off + 4])[0]
        if track_id in video_track_ids:
            offsets.append(content + 4 + (32 if version == 1 else 20) + 16)
        pos += 4
    return offsets

manifest = []

def emit(name, data, angle, W, H, video_track_ids, note):
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(data)
    manifest.append({
        "name": name, "angle": angle, "W": W, "H": H,
        "matrixOffsets": find_video_matrix_offsets(data, video_track_ids),
        "note": note,
    })

# A) MP4 clásico: mdat antes que moov, tkhd v0, sin rotación previa
W, H = 1920, 1080
data = ftyp(b"isom", b"isomiso2avc1mp41") + box(b"free", b"\x00" * 8) \
    + box(b"mdat", os.urandom(4096)) + box(b"moov", mvhd(), trak_video(0, 0, W, H))
emit("a_plain.mp4", data, 0, W, H, {1}, "mdat antes de moov, tkhd v0, 0°")

# B) MOV estilo iPhone: moov primero, tkhd v1, rotación previa de 90°, HEVC
data = ftyp(b"qt  ", b"qt  ") + box(b"wide") \
    + box(b"moov", mvhd(), trak_video(1, 90, W, H, codec=b"hvc1")) \
    + box(b"mdat", os.urandom(2048))
emit("b_iphone.mov", data, 90, W, H, {1}, "moov antes de mdat, tkhd v1, 90° previo, hvc1")

# C) mdat de 64 bits + track de audio primero + video después, 180° previo
data = ftyp(b"isom", b"isomiso2") + mdat64(os.urandom(1024)) \
    + box(b"moov", mvhd(), trak_audio(1), trak_video(0, 180, W, H, track_id=2))
emit("c_audio_first.mp4", data, 180, W, H, {2}, "mdat de 64 bits, audio primero, 180° previo")

# D) Vertical ya rotado 270°
W2, H2 = 1280, 720
data = ftyp(b"isom", b"isomiso2") + box(b"mdat", os.urandom(512)) \
    + box(b"moov", mvhd(), trak_video(0, 270, W2, H2))
emit("d_rot270.mp4", data, 270, W2, H2, {1}, "270° previo")

with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest, indent=2))
