import math, os
from PIL import Image, ImageDraw, ImageFilter

S = 1024            # final size
SS = 2              # supersample factor
N = S * SS          # working canvas

def newcanvas():
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def P(*pts):
    """scale normalized (0..1000) points to working canvas."""
    return [(x / 1000 * N, y / 1000 * N) for x, y in pts]

def lerp(a, b, t):
    if len(b) < len(a):
        b = tuple(b) + (a[len(b):][0],) if len(a) == 4 else b
        b = tuple(list(b) + list(a[len(b):]))
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

# ───────────────────────── shape primitives ─────────────────────────
def rounded_poly(draw, pts, fill=None, outline=None, width=0):
    draw.polygon(pts, fill=fill, outline=outline, width=int(width))

def thick_line(draw, pts, fill, width):
    draw.line(pts, fill=fill, width=int(width), joint='curve')
    r = width / 2
    for x, y in (pts[0], pts[-1]):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)

def ring(draw, cx, cy, r, color, width):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=int(width))

# ───────────────────────── icon drawings ─────────────────────────
def draw_rock(draw, pal):
    ow = pal['ow'] * N
    body = P((300,560),(270,440),(360,350),(500,310),(650,345),(710,470),(675,610),(540,665),(395,650))
    draw.polygon(body, fill=pal['stone'], outline=pal['outline'], width=int(ow))
    # facets
    f1 = P((500,310),(540,470),(395,650))
    draw.polygon(f1, fill=pal['stone2'])
    f2 = P((540,470),(710,470),(675,610),(540,665))
    draw.polygon(f2, fill=lerp(pal['stone'], (0,0,0), 0.18))
    # facet lines
    if pal['mode'] == 'neon':
        thick_line(draw, P((500,310),(540,470)), pal['edge'], ow*0.7)
        thick_line(draw, P((540,470),(710,470)), pal['edge'], ow*0.7)
        thick_line(draw, P((540,470),(395,650)), pal['edge'], ow*0.7)
        thick_line(draw, P((540,470),(540,665)), pal['edge'], ow*0.7)
        draw.polygon(body, outline=pal['edge'], width=int(ow*1.1))
    else:
        thick_line(draw, P((500,310),(540,470)), pal['outline'], ow*0.7)
        thick_line(draw, P((540,470),(710,470)), pal['outline'], ow*0.7)
        thick_line(draw, P((540,470),(395,650)), pal['outline'], ow*0.7)
    # highlight
    hi = P((360,355),(470,330),(500,420),(380,455))
    draw.polygon(hi, fill=lerp(pal['stone'], (255,255,255), 0.35))

def draw_paper(draw, pal):
    ow = pal['ow'] * N
    sheet = P((345,250),(620,250),(700,330),(700,770),(345,770))
    draw.polygon(sheet, fill=pal['paper'], outline=pal['outline'], width=int(ow))
    # folded corner
    fold = P((620,250),(700,330),(620,330))
    draw.polygon(fold, fill=lerp(pal['paper'], (0,0,0), 0.18), outline=pal['outline'], width=int(ow*0.7))
    # text lines
    for i, y in enumerate((400, 470, 540, 610, 680)):
        x2 = 640 if i % 2 == 0 else 590
        thick_line(draw, P((400,y),(x2,y)), pal['paperLine'], ow*0.85)
    if pal['mode'] == 'neon':
        draw.polygon(sheet, outline=pal['edge'], width=int(ow))

def draw_scissors(draw, pal):
    ow = pal['ow'] * N
    pivot = (512/1000*N, 560/1000*N)
    # blades (tapered quads) crossing
    bladeL = P((430,690),(470,710),(640,250),(580,235))
    bladeR = P((594,690),(554,710),(384,250),(444,235))
    draw.polygon(bladeR, fill=pal['blade'], outline=pal['outline'], width=int(ow))
    draw.polygon(bladeL, fill=pal['blade'], outline=pal['outline'], width=int(ow))
    # handles (rings)
    ring(draw, 440/1000*N, 740/1000*N, 85/1000*N, pal['handle'], ow*1.6)
    ring(draw, 584/1000*N, 740/1000*N, 85/1000*N, pal['handle'], ow*1.6)
    # pivot screw
    pr = 26/1000*N
    draw.ellipse([pivot[0]-pr, pivot[1]-pr, pivot[0]+pr, pivot[1]+pr], fill=pal['handle'], outline=pal['outline'], width=int(ow*0.6))
    if pal['mode'] == 'neon':
        draw.polygon(bladeR, outline=pal['edge'], width=int(ow))
        draw.polygon(bladeL, outline=pal['edge'], width=int(ow))

def draw_flag(draw, pal):
    ow = pal['ow'] * N
    # pole
    pole = P((360,250),(398,250),(398,800),(360,800))
    draw.polygon(pole, fill=pal['pole'], outline=pal['outline'], width=int(ow))
    # finial
    fr = 34/1000*N
    cx, cy = 379/1000*N, 248/1000*N
    draw.ellipse([cx-fr, cy-fr, cx+fr, cy+fr], fill=pal['accent'], outline=pal['outline'], width=int(ow*0.7))
    # pennant (swallowtail)
    pen = P((398,280),(720,330),(640,400),(720,470),(398,500))
    draw.polygon(pen, fill=pal['flag'], outline=pal['outline'], width=int(ow))
    if pal['mode'] == 'neon':
        draw.polygon(pen, outline=pal['edge'], width=int(ow))

def draw_bomb(draw, pal):
    ow = pal['ow'] * N
    cx, cy, r = 500/1000*N, 600/1000*N, 215/1000*N
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=pal['bombBody'], outline=pal['outline'], width=int(ow))
    # cap
    cap = P((455,400),(560,400),(545,448),(470,448))
    draw.polygon(cap, fill=lerp(pal['bombBody'], (255,255,255), 0.25), outline=pal['outline'], width=int(ow*0.7))
    # fuse
    fuse = P((512,405),(560,330),(620,300),(660,250))
    thick_line(draw, fuse, pal['fuse'], ow*1.2)
    # spark burst
    sx, sy = 670/1000*N, 235/1000*N
    sl = 70/1000*N
    for ang in range(0, 360, 45):
        a = math.radians(ang)
        thick_line(draw, [(sx, sy), (sx+math.cos(a)*sl, sy+math.sin(a)*sl)], pal['spark'], ow*0.9)
    sr = 34/1000*N
    draw.ellipse([sx-sr, sy-sr, sx+sr, sy+sr], fill=pal['spark'])
    # highlight on body
    hx, hy, hr = cx-r*0.4, cy-r*0.4, r*0.32
    draw.ellipse([hx-hr, hy-hr, hx+hr, hy+hr], fill=pal['bombHi'])

def draw_explosion(draw, pal):
    """Взорванная бомба: огненный звёздный взрыв с белым ядром."""
    ow = pal['ow'] * N
    cx, cy = 500 / 1000 * N, 500 / 1000 * N
    outer = (239, 68, 68, 255)
    mid = (249, 115, 22, 255)
    inner = (250, 204, 21, 255)

    def burst(rad_long, rad_short, color, n, rot, outline=None):
        pts = []
        for i in range(n * 2):
            ang = math.radians(rot + i * (360 / (n * 2)))
            rr = (rad_long if i % 2 == 0 else rad_short) / 1000 * N
            pts.append((cx + math.cos(ang) * rr, cy + math.sin(ang) * rr))
        draw.polygon(pts, fill=color, outline=outline, width=int(ow * 0.5) if outline else 0)

    burst(480, 300, outer, 11, 0, pal['outline'])
    burst(370, 215, mid, 10, 16)
    burst(255, 150, inner, 9, 8)
    cr = 95 / 1000 * N
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=(255, 255, 255, 255))
    # пара искр-осколков
    for ang in (35, 150, 265):
        a = math.radians(ang)
        ex, ey = cx + math.cos(a) * 470 / 1000 * N, cy + math.sin(a) * 470 / 1000 * N
        rr = 26 / 1000 * N
        draw.ellipse([ex - rr, ey - rr, ex + rr, ey + rr], fill=inner)

DRAW = {'rock': draw_rock, 'paper': draw_paper, 'scissors': draw_scissors,
        'flag': draw_flag, 'trap': draw_bomb, 'trap_open': draw_explosion}

# ───────────────────────── palettes ─────────────────────────
PALETTES = {
  'cyberpunk': {
    'mode': 'neon', 'ow': 0.012, 'outline': (8, 25, 40, 255), 'edge': (34, 211, 238, 255),
    'stone': (96, 122, 150, 255), 'stone2': (130, 160, 190, 255),
    'paper': (186, 230, 253, 255), 'paperLine': (14, 116, 144, 255),
    'blade': (224, 242, 254, 255), 'handle': (244, 114, 182, 255),
    'flag': (244, 114, 182, 255), 'pole': (148, 197, 226, 255), 'accent': (34, 211, 238, 255),
    'bombBody': (30, 41, 59, 255), 'bombHi': (120, 200, 230, 200), 'spark': (250, 204, 21, 255),
    'fuse': (148, 197, 226, 255),
  },
  'toon': {
    'mode': 'bold', 'ow': 0.022, 'outline': (31, 41, 55, 255), 'edge': None,
    'stone': (156, 163, 175, 255), 'stone2': (120, 128, 140, 255),
    'paper': (255, 255, 255, 255), 'paperLine': (96, 165, 250, 255),
    'blade': (229, 231, 235, 255), 'handle': (239, 68, 68, 255),
    'flag': (239, 68, 68, 255), 'pole': (180, 130, 90, 255), 'accent': (251, 191, 36, 255),
    'bombBody': (31, 41, 55, 255), 'bombHi': (110, 120, 135, 230), 'spark': (250, 204, 21, 255),
    'fuse': (146, 64, 14, 255),
  },
  'chess': {
    'mode': 'bold', 'ow': 0.020, 'outline': (63, 45, 26, 255), 'edge': None,
    'stone': (226, 213, 184, 255), 'stone2': (205, 188, 150, 255),
    'paper': (245, 240, 225, 255), 'paperLine': (120, 90, 50, 255),
    'blade': (245, 240, 225, 255), 'handle': (120, 90, 50, 255),
    'flag': (226, 213, 184, 255), 'pole': (120, 90, 50, 255), 'accent': (160, 120, 70, 255),
    'bombBody': (74, 60, 44, 255), 'bombHi': (150, 130, 100, 220), 'spark': (200, 160, 90, 255),
    'fuse': (120, 90, 50, 255),
  },
}

def fit_frame(img, frac=0.96, thresh=24, expand=0.05):
    """Обрезать прозрачные поля и вписать символ во весь кадр (frac доля стороны)."""
    a = img.split()[3]
    mask = a.point(lambda p: 255 if p > thresh else 0)
    bbox = mask.getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    w, h = r - l, b - t
    ex = int(max(w, h) * expand)
    l = max(0, l - ex); t = max(0, t - ex)
    r = min(img.width, r + ex); b = min(img.height, b + ex)
    crop = img.crop((l, t, r, b))
    cw, ch = crop.size
    target = img.width * frac
    scale = target / max(cw, ch)
    nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
    crop = crop.resize((nw, nh), Image.LANCZOS)
    out = Image.new('RGBA', (img.width, img.height), (0, 0, 0, 0))
    out.paste(crop, ((img.width - nw) // 2, (img.height - nh) // 2), crop)
    return out

OUT = 'assets/skins'
for skin, pal in PALETTES.items():
    # neon оставляет немного места под свечение, bold заполняет почти весь кадр
    frac = 0.92 if pal['mode'] == 'neon' else 0.98
    for name, fn in DRAW.items():
        img, draw = newcanvas()
        fn(draw, pal)
        if pal['mode'] == 'neon':
            glow = img.filter(ImageFilter.GaussianBlur(N * 0.012))
            base = Image.new('RGBA', (N, N), (0, 0, 0, 0))
            base = Image.alpha_composite(base, glow)
            base = Image.alpha_composite(base, glow)
            base = Image.alpha_composite(base, img)
            img = base
        img = fit_frame(img, frac=frac)
        img = img.resize((S, S), Image.LANCZOS)
        path = os.path.join(OUT, skin, f'{name}.png')
        img.save(path)
    print('done', skin)
print('ALL OK')
