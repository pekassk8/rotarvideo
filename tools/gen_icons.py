#!/usr/bin/env python3
"""Genera los iconos PNG de RotarVideo (fondo violeta + flecha circular ⟲ + triángulo de play)."""
import math, struct, zlib, os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "icons"

def lerp(a, b, t):
    return a + (b - a) * t

def clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else x)

def tri_sdf(px, py, A, B, C):
    """Distancia con signo aproximada a un triángulo (negativa dentro)."""
    best = -1e9
    pts = (A, B, C)
    # centroide para orientar las normales hacia fuera
    cx = (A[0] + B[0] + C[0]) / 3.0
    cy = (A[1] + B[1] + C[1]) / 3.0
    for i in range(3):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % 3]
        ex, ey = x2 - x1, y2 - y1
        ln = math.hypot(ex, ey) or 1e-9
        nx, ny = ey / ln, -ex / ln  # normal
        # orientar hacia fuera
        if (cx - x1) * nx + (cy - y1) * ny > 0:
            nx, ny = -nx, -ny
        d = (px - x1) * nx + (py - y1) * ny
        best = max(best, d)
    return best

def render(S):
    cx = cy = 0.5
    R = 0.30
    half_t = 0.048
    gap_a, gap_b = 245.0, 295.0        # hueco del anillo (270° = arriba con y hacia abajo)
    edge = 1.35 / S                     # suavizado de bordes ~1.3 px

    # punta de flecha en el extremo del anillo en gap_b, apuntando en sentido antihorario
    te = math.radians(gap_b)
    Px = cx + R * math.cos(te)
    Py = cy + R * math.sin(te)
    tx, ty = math.sin(te), -math.cos(te)     # tangente antihoraria (pantalla)
    nx, ny = math.cos(te), math.sin(te)
    tipA = (Px + tx * 0.135, Py + ty * 0.135)
    tipB = (Px - tx * 0.015 + nx * 0.085, Py - ty * 0.015 + ny * 0.085)
    tipC = (Px - tx * 0.015 - nx * 0.085, Py - ty * 0.015 - ny * 0.085)

    # triángulo de play centrado (apunta a la derecha)
    pA = (cx - 0.082, cy - 0.102)
    pB = (cx - 0.082, cy + 0.102)
    pC = (cx + 0.122, cy)

    top = (146, 100, 250)     # violeta claro
    bot = (74, 28, 150)       # violeta oscuro

    rows = []
    for yi in range(S):
        row = bytearray()
        v = (yi + 0.5) / S
        for xi in range(S):
            u = (xi + 0.5) / S
            # fondo degradado + brillo suave arriba-izquierda
            t = v
            r = lerp(top[0], bot[0], t)
            g = lerp(top[1], bot[1], t)
            b = lerp(top[2], bot[2], t)
            glow = max(0.0, 1.0 - math.hypot(u - 0.32, v - 0.25) / 0.85)
            r += glow * 22; g += glow * 16; b += glow * 26

            dx, dy = u - cx, v - cy
            dist = math.hypot(dx, dy)

            # anillo con hueco
            band = abs(dist - R) - half_t
            ang = math.degrees(math.atan2(dy, dx)) % 360.0
            if gap_a < ang < gap_b:
                d_arc = min(ang - gap_a, gap_b - ang)
            else:
                d1 = min((ang - gap_a) % 360.0, (gap_a - ang) % 360.0)
                d2 = min((ang - gap_b) % 360.0, (gap_b - ang) % 360.0)
                d_arc = -min(d1, d2)
            gap_sdf = math.radians(d_arc) * max(dist, 1e-6)
            ring_sdf = max(band, gap_sdf)
            ring_a = clamp01(0.5 - ring_sdf / edge)

            arrow_a = clamp01(0.5 - tri_sdf(u, v, tipA, tipB, tipC) / edge)
            play_a = clamp01(0.5 - tri_sdf(u, v, pA, pB, pC) / edge)

            alpha = max(ring_a, arrow_a, play_a)
            r = lerp(r, 255, alpha)
            g = lerp(g, 255, alpha)
            b = lerp(b, 255, alpha)
            row += bytes((int(min(255, max(0, r))), int(min(255, max(0, g))), int(min(255, max(0, b)))))
        rows.append(bytes(row))
    return rows

def write_png(path, S, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", S, S, 8, 2, 0, 0, 0)  # RGB de 8 bits
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)

os.makedirs(OUT, exist_ok=True)
for size in (180, 192, 512):
    path = os.path.join(OUT, f"icon-{size}.png")
    write_png(path, size, render(size))
    print(f"OK {path} ({os.path.getsize(path)} bytes)")
