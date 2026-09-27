"""DRONE01 (S500 쿼드콥터 X) — 콕핏 화면용 3D 모델 (.glb).

    ~/tools/blender-4.5.9-linux-x64/blender -b -P web/model/drone01.py -- web/public/model/drone01.glb [preview.png]

기준 사진: components/frame/images/2026-09-27-{airframe,motor,esc}.jpg

치수 출처:
  프레임 S500 — 휠베이스 480 mm (대각 모터 간), 사출 암(삼각 트러스), PCB 센터판 2장(금색 테두리)
  모터 3508-380KV Φ42×26, 빨간 벨·검은 띠·흰 글씨           — components/motors/gt-drone-3508-380kv, 사진
  프롭 12×4.5 카본 2엽 (R 0.1524)                           — components/props/12x45, 사진
  FC Pixhawk 2.4.8 81.5×50×15.5, 파란 방진 댐퍼             — components/fc/pixhawk-2.4.8, 사진
  ESC GT DRONE EC-X3 30A ×4, 암 아래                        — components/esc/gt-drone-ec-x3-30a, 사진
방향: FC 화살표 = 기수 (AHRS_ORIENTATION=0). 사진에서 GPS 마스트는 FC 오른쪽 약간 뒤,
  스키드는 좌우 두 줄 (앞뒤로 뻗음), 배터리 레일은 앞뒤로 뻗는다.
가정 (사진·문서에 없음 — 실측으로 바꿀 것):
  배터리 4S 2900 mAh 138×43×30 mm, 레일 아래 스트랩 — 사진에 배터리 없음
  GPS 마스트 높이는 사진 비례 추정

좌표 (Blender): 기수 -Y, 위 +Z, 왼쪽 +X. glTF 로 내보내면 기수 +Z, 위 +Y.
원점 = 두 센터판 사이 한가운데. 스키드 바닥 z = -0.20 (화면 FLOOR).
three.js 쪽이 이름으로 찾는 노드: rotor_LF/RF/LB/RB (로컬 Y 가 회전축), gps, bay_*,
top_plate*/bottom_plate* (칸을 고르면 반투명).
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'drone01.glb'
PREVIEW = argv[1] if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

# ── 재질 ──────────────────────────────────────────────────────────────
def mat(name, rgb, rough=0.5, metal=0.0, clear=0.0, tex=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if clear:
        b.inputs['Coat Weight'].default_value = clear
    if tex:
        t = m.node_tree.nodes.new('ShaderNodeTexImage')
        t.image = tex
        m.node_tree.links.new(t.outputs['Color'], b.inputs['Base Color'])
    return m

def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def weave():
    """카본 2×2 트윌 — 64 px, 결 4칸. 프롭·다리에 UV 로 반복."""
    N, T = 64, 8
    img = bpy.data.images.new('carbon_weave', N, N)
    px = []
    for j in range(N):
        for i in range(N):
            ci, cj = i // T, j // T
            horiz = (ci - cj) % 4 < 2
            across = (j % T if horiz else i % T) + 0.5
            v = math.sin(math.pi * across / T)
            base = (0.030 if horiz else 0.018) + 0.035 * v
            px += [base, base, base * 1.04, 1.0]
    img.pixels = px
    path = os.path.join(os.path.dirname(os.path.abspath(OUT)), '.carbon_weave.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    img.pack()
    os.remove(path)
    return img

CARBON_TEX = weave()
FRAME = mat('frame_black', srgb('#161719'), 0.6)          # S500 사출 암
PCB = mat('pcb_black', srgb('#0e0f11'), 0.4)              # 센터판
GOLD = mat('pcb_gold', srgb('#c9a44c'), 0.35, 0.9)        # 센터판 테두리
RED = mat('motor_red', srgb('#c8141c'), 0.3, 0.7)         # 3508 벨 — 빨간 알루마이트
BAND = mat('motor_band', srgb('#0c0c0d'), 0.35, 0.3)
COPPER = mat('copper', srgb('#b8733a'), 0.35, 0.9)
STEEL = mat('steel', srgb('#b8bcc2'), 0.25, 1.0)
SCREW = mat('screw_black', srgb('#1a1a1a'), 0.4, 0.5)
CARBON = mat('carbon', (1, 1, 1), 0.3, 0.2, 0.6, tex=CARBON_TEX)
BLACK = mat('black', srgb('#17181b'), 0.5)
WRED = mat('wire_red', srgb('#d0231e'), 0.45)
WBLUE = mat('wire_blue', srgb('#2f64d6'), 0.45)
ZIP = mat('ziptie', srgb('#eeeeea'), 0.5)
ESC = mat('esc_black', srgb('#1d1e20'), 0.6)
LABEL = mat('label', srgb('#d9dcdc'), 0.5)
DAMPER = mat('damper_blue', srgb('#2aa8e0'), 0.5)
BEIGE = mat('connector', srgb('#c9bc9c'), 0.6)
WHITE = mat('white', srgb('#f2f2f2'), 0.4)
FOAM = mat('foam_black', srgb('#1a1a1c'), 0.9)
FOAMR = mat('foam_red', srgb('#e0223a'), 0.8)
XT = mat('xt_yellow', srgb('#e8b21a'), 0.5)
BATT = mat('battery', srgb('#30343c'), 0.45)
GPSM = mat('gps_black', srgb('#161618'), 0.45)
GPSG = mat('gps_grey', srgb('#5a5c60'), 0.5)
BAYVOL = mat('bayvol', srgb('#3e6ae1'), 0.5)            # 클릭 영역 — 화면에서는 안 그린다

def obj(name, me, m=None, parent=None, smooth=True):
    o = bpy.data.objects.new(name, me)
    scn.collection.objects.link(o)
    if m:
        me.materials.append(m)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    if parent:
        o.parent = parent
    return o

def modifier_apply(o, kind, **kw):
    md = o.modifiers.new(kind.lower(), kind)
    for k, v in kw.items():
        setattr(md, k, v)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=md.name)
    o.select_set(False)

def loft(name, rings, m, cap=True, parent=None, smooth=True, closed=False):
    """rings: 같은 개수의 닫힌 고리. 사이를 사각면으로 잇는다. closed 면 마지막→처음도 잇는다."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    pairs = list(zip(vs, vs[1:])) + ([(vs[-1], vs[0])] if closed else [])
    for a, b in pairs:
        for j in range(n):
            bm.faces.new((a[j], a[(j + 1) % n], b[(j + 1) % n], b[j]))
    if cap and not closed:
        bm.faces.new(list(reversed(vs[0])))
        bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return obj(name, me, m, parent, smooth)

def revolve(name, prof, loc, m, parent=None, n=40):
    """(r, z) 닫힌 단면을 Z 축으로 돌린다."""
    rings = []
    for r, z in prof:
        rings.append([Vector((r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z))
                      for k in range(n)])
    o = loft(name, rings, m, parent=parent or root, closed=True)
    o.location = loc
    return o

root = bpy.data.objects.new('DRONE01', None)
scn.collection.objects.link(root)

def box(name, size, loc, m, parent=root, rot=(0, 0, 0), bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    o = obj(name, me, m, parent, smooth=False)
    o.location = loc
    o.rotation_euler = rot
    if bevel:
        modifier_apply(o, 'BEVEL', width=bevel, segments=2)
    return o

def uv_cyl(me, r, tile):
    """원통 UV — 둘레·길이를 tile 로 나눈다 (카본 결)."""
    uv = me.uv_layers.new(name='UVMap')
    per = 2 * math.pi * r / tile
    for p in me.polygons:
        us = []
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            us.append(((math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0 * per, co.z / tile))
        lo = min(u for u, _ in us)
        for li, (u, v) in zip(p.loop_indices, us):
            if u - lo > per / 2:
                u -= per
            uv.data[li].uv = (u, v)

def cyl(name, r, h, loc, m, parent=root, rot=(0, 0, 0), verts=32, r2=None, uv=0.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    bm.to_mesh(me)
    bm.free()
    if uv:
        uv_cyl(me, r, uv)
    o = obj(name, me, m, parent)
    o.location = loc
    o.rotation_euler = rot
    return o

def rod(name, p0, p1, r, m, parent=root, verts=16, uv=0.0):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    o = cyl(name, r, d.length, (p0 + p1) / 2, m, parent=parent, verts=verts, uv=uv)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return o

def smooth(pts, k=6):
    """Catmull-Rom 으로 점 사이를 채운다."""
    P = [Vector(p) for p in pts]
    P = [P[0]] + P + [P[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(k):
            t = s / k
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return out

def tube(name, pts, r, m, parent=root, k=6):
    """전선 — 점들을 부드럽게 이은 관."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = 1
    cu.use_fill_caps = True
    pts = smooth(pts, k)
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p.x, p.y, p.z, 1)
    cu.materials.append(m)
    o = bpy.data.objects.new(name, cu)
    scn.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target='MESH')
    o.select_set(False)
    for p in o.data.polygons:
        p.use_smooth = True
    o.parent = parent
    return o

def bar(bm, p0, p1, w, h, up=Vector((0, 0, 1))):
    """p0→p1 사각 봉 (폭 w, 높이 h) 을 bm 에 더한다."""
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    s = d.cross(up)
    if s.length < 1e-6:
        s = d.cross(Vector((1, 0, 0)))
    s.normalize()
    u = s.cross(d).normalized()
    c = [p + s * (i * w / 2) + u * (j * h / 2) for p in (p0, p1) for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    v = [bm.verts.new(x) for x in c]
    for f in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        bm.faces.new([v[i] for i in f])

def bm_obj(name, bm, m, parent=root):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return obj(name, me, m, parent, smooth=False)

# ── 치수 ─────────────────────────────────────────────────────────────
WHEELBASE = 0.48                   # S500 대각 모터 간
ARM_R = WHEELBASE / 2              # 중심 → 모터 축
TOP_Z0, TOP_Z1 = 0.012, 0.0136     # 윗판 (PCB 1.6)
BOT_Z0, BOT_Z1 = -0.0136, -0.012   # 아랫판 = 전원분배판
FLOOR = -0.20                     # 스키드 바닥 (화면 FLOOR)
PROP_R = 0.1524                    # 12 인치
PITCH = 4.5 * 0.0254
ARMS = [math.radians(a) for a in (45, 135, -135, -45)]

# ArduCopter 쿼드 X: 1 RF·2 LB 반시계, 3 LF·4 RB 시계 — 화면의 dir 과 같다
MOTORS = {'LF': (1, -1, -1), 'RF': (-1, -1, 1), 'LB': (1, 1, 1), 'RB': (-1, 1, -1)}  # sx, sy, spin
PHASE = {'LF': 1.9, 'RF': 0.35, 'LB': 1.0, 'RB': 2.3}

# ── 센터판 — S500 PCB 2장, 검은 면·금색 테두리 ──────────────────────────
def outline(rs, rt, hw, z, n=144):
    """암 방향은 폭 2·hw 의 탭(끝 반경 rt), 암 사이는 반경 rs 까지 오목하게 파인 판."""
    t = math.asin(hw / rt)
    pts = []
    for k in range(n):
        th = 2 * math.pi * k / n
        d = min(abs((th - a + math.pi) % (2 * math.pi) - math.pi) for a in ARMS)
        if d <= t:
            r = rt / math.cos(d)
        else:
            f = (d - t) / (math.pi / 4 - t)
            r = rs + (rt / math.cos(t) - rs) * (1 - f) ** 2
        pts.append(Vector((r * math.cos(th), r * math.sin(th), z)))
    return pts

def pcb(name, rs, rt, hw, z0, z1, e=0.0015):
    loft(name + '_edge', [outline(rs, rt, hw, z0 - 0.0001), outline(rs, rt, hw, z1)], GOLD, smooth=False)
    loft(name, [outline(rs - e, rt - e, hw - e, z0 - 0.0002), outline(rs - e, rt - e, hw - e, z1 + 0.0002)],
         PCB, smooth=False)

pcb('top_plate', 0.062, 0.095, 0.027, TOP_Z0, TOP_Z1)
pcb('bottom_plate', 0.070, 0.103, 0.030, BOT_Z0, BOT_Z1)
for i, a in enumerate(ARMS):          # 탭 나사
    for sgn in (-1, 1):
        u = Vector((math.cos(a), math.sin(a), 0))
        s = Vector((-u.y, u.x, 0))
        p = u * 0.08 + s * (sgn * 0.019)
        cyl(f'plate_screw_{i}{sgn:+d}', 0.0022, 0.0015, (p.x, p.y, TOP_Z1 + 0.0009), STEEL, verts=12)

# ── 암 — S500 사출 암, 네 면이 삼각 트러스 ──────────────────────────────
R0 = 0.035
def arm_h(r):
    return 0.024 + (0.017 - 0.024) * max(0.0, (r - R0) / (ARM_R - R0))

def arm_w(r):
    return 0.034 + (0.025 - 0.034) * max(0.0, (r - R0) / (ARM_R - R0))

for s, (sx, sy, spin) in MOTORS.items():
    a = math.atan2(sy, sx)
    u = Vector((math.cos(a), math.sin(a), 0))
    lat = Vector((-u.y, u.x, 0))
    Z = Vector((0, 0, 1))
    P = lambda r, l=0.0, z=0.0: u * r + lat * l + Z * z
    bm = bmesh.new()
    rc = 0.0015                                   # 모서리 봉 반치수
    ra, rb = 0.075, ARM_R - 0.022                 # 트러스 구간
    corner = lambda r, i, j: P(r, i * (arm_w(r) / 2 - rc), j * (arm_h(r) / 2 - rc))
    for i in (-1, 1):
        for j in (-1, 1):
            bar(bm, corner(R0, i, j), corner(ARM_R, i, j), 2 * rc, 2 * rc)
    # 판 사이·모터 쪽은 속이 찬 덩어리
    for r0, r1 in ((R0, ra), (rb, ARM_R - 0.012)):
        rm = (r0 + r1) / 2
        bar(bm, P(r0), P(r1), arm_w(rm) - 0.001, arm_h(rm) - 0.001)
    # 트러스 — 윗면·아랫면·양옆
    N = 11
    rs_ = [ra + (rb - ra) * k / N for k in range(N + 1)]
    for k in range(N):
        r0, r1 = rs_[k], rs_[k + 1]
        f = 1 if k % 2 == 0 else -1
        for j in (-1, 1):                         # 윗면·아랫면: 좌↔우 지그재그
            bar(bm, corner(r0, f * j, j), corner(r1, -f * j, j), 0.0034, 0.0022)
        for i in (-1, 1):                         # 옆면: 위↔아래 지그재그
            bar(bm, corner(r0, i, f), corner(r1, i, -f), 0.0022, 0.0034, up=lat)
    for k in range(N + 1):                        # 칸막이 — 윗면 가로대
        r = rs_[k]
        bar(bm, corner(r, -1, 1), corner(r, 1, 1), 0.0022, 0.0022, up=u)
        bar(bm, corner(r, -1, -1), corner(r, 1, -1), 0.0022, 0.0022, up=u)
    bm_obj(f'arm_{s}', bm, FRAME)
    # 모터 받침 — 암 끝의 둥근 컵
    ht = arm_h(ARM_R)
    cyl(f'arm_mount_{s}', 0.022, ht, P(ARM_R), FRAME, verts=40)
    mz = ht / 2
    # 전선 — 암 윗면을 따라 빨강·파랑, 흰 케이블타이로 묶는다
    for l, m in ((0.0045, WRED), (-0.0045, WBLUE)):
        top = lambda r: arm_h(r) / 2 + 0.0022
        tube(f'wire_{s}_{"r" if m is WRED else "b"}',
             [P(0.05, l * 0.6, TOP_Z1 + 0.0025), P(0.085, l, TOP_Z1 + 0.0028), P(0.11, l, top(0.11)),
              P(0.17, l, top(0.17)), P(ARM_R - 0.035, l, top(ARM_R - 0.035)),
              P(ARM_R - 0.024, l * 1.4, mz + 0.004)], 0.0018, m, k=4)
    for r in (0.105, 0.16, 0.205):
        box(f'ziptie_{s}_{int(r * 1000)}', (0.0025, arm_w(r) + 0.0016, arm_h(r) + 0.0062),
            P(r, 0, 0.0018), ZIP, rot=(0, 0, a))
    # ESC — EC-X3 30A, 암 아래에 붙인다. 옆면에 흰 라벨
    re = 0.15
    ez = -arm_h(re) / 2 - 0.0048
    box(f'esc_{s}', (0.052, 0.023, 0.0095), P(re, 0.004, ez), ESC, rot=(0, 0, a), bevel=0.002)
    box(f'esc_label_{s}', (0.026, 0.0234, 0.0072), P(re + 0.004, 0.004, ez), LABEL, rot=(0, 0, a))

    # 모터 3508 — Φ42 × 26: 빨간 받침, 검은 띠, 빨간 벨 윗단, 살 사이로 구리 코일
    c = P(ARM_R, 0, mz)
    revolve(f'motor_{s}', [(0.0, 0.0), (0.0200, 0.0), (0.0205, 0.001), (0.0205, 0.005), (0.0211, 0.005),
                           (0.0211, 0.016), (0.0208, 0.016), (0.0208, 0.0205), (0.0195, 0.0225),
                           (0.0165, 0.0225), (0.0165, 0.019), (0.0, 0.019)], c, RED)
    cyl(f'motor_band_{s}', 0.0212, 0.011, c + Vector((0, 0, 0.0105)), BAND, verts=40)
    cyl(f'motor_coil_{s}', 0.0165, 0.0015, c + Vector((0, 0, 0.0198)), COPPER, verts=24)
    sb = bmesh.new()
    for k in range(5):                            # 벨 윗면 살 5개
        ang = a + 2 * math.pi * k / 5 + 0.3
        d = Vector((math.cos(ang), math.sin(ang), 0))
        bar(sb, d * 0.005 + Vector((0, 0, 0.0232)), d * 0.0175 + Vector((0, 0, 0.0212)), 0.0042, 0.0024)
    o = bm_obj(f'motor_spokes_{s}', sb, RED)
    o.location = c
    cyl(f'motor_hub_{s}', 0.0085, 0.0045, c + Vector((0, 0, 0.0245)), RED, verts=24)

    # 프롭 — 빈 객체(회전축) 아래 날 두 장·허브·빨간 캡·나사 두 개·축
    e = bpy.data.objects.new(f'rotor_{s}', None)
    scn.collection.objects.link(e)
    e.parent = root
    e.location = c + Vector((0, 0, 0.031))
    e.rotation_euler = (0, 0, PHASE[s])
    MOTORS[s] = (sx, sy, spin, c)

# ── 모터 띠 글씨 "3508-380KV" — 한 메시를 네 모터가 나눠 쓴다 ─────────────
def band_text():
    FONT = None
    for f in ('/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'):
        if os.path.exists(f):
            FONT = bpy.data.fonts.load(f)
            break
    cu = bpy.data.curves.new('motor_text', 'FONT')
    cu.body = '3508-380KV'
    if FONT:
        cu.font = FONT
    cu.align_x = cu.align_y = 'CENTER'
    cu.resolution_u = 2
    t = bpy.data.objects.new('motor_text', cu)
    scn.collection.objects.link(t)
    bpy.context.view_layer.objects.active = t
    t.select_set(True)
    bpy.ops.object.convert(target='MESH')
    t.select_set(False)
    me = t.data
    ys = [v.co.y for v in me.vertices]
    k = 0.0052 / (max(ys) - min(ys))
    R = 0.0214
    for v in me.vertices:
        x, y = v.co.x * k, v.co.y * k
        ph = x / R
        v.co = Vector((R * math.cos(ph), R * math.sin(ph), y))
    me.materials.append(WHITE)
    bpy.data.objects.remove(t)
    return me

TEXT_ME = band_text()
for s, (sx, sy, spin, c) in MOTORS.items():
    t = bpy.data.objects.new(f'motor_label_{s}', TEXT_ME)
    scn.collection.objects.link(t)
    t.parent = root
    t.location = c + Vector((0, 0, 0.0105))
    t.rotation_euler = (0, 0, math.atan2(sy, sx))   # 바깥쪽을 본다

# ── 프롭 날 ──────────────────────────────────────────────────────────
def blade(name, R, root_c, tip_c, spin, pitch, m, n=14, thick=0.0045, tile=0.018):
    """허브에서 +X 로 뻗는 날 한 장. spin=+1 이면 위에서 봐 반시계 — 앞전이 +Y, 앞전이 높다."""
    prof = [(0.0, 0.0), (0.08, 0.55), (0.35, 0.5), (1.0, 0.0), (0.35, -0.2), (0.08, -0.3)]
    rings = []
    for k in range(n + 1):
        t = k / n
        x = 0.012 + (R - 0.012) * t
        cc = root_c + (tip_c - root_c) * t ** 1.1
        if 0.12 <= t:
            cc *= 1 - (max(0.0, t - 0.8) / 0.2) ** 2 * 0.5
        else:
            cc = root_c * (0.55 + 0.45 * t / 0.12)
        ang = math.atan(pitch / (2 * math.pi * x)) * 0.9      # 피치 4.5" 에 맞춘 비틀림
        th = thick * (1 - 0.6 * t)
        ring = []
        for uu, vv in prof:
            aa = (0.3 - uu) * cc                              # 앞전 쪽이 +
            ring.append(Vector((x, spin * aa * math.cos(ang), aa * math.sin(ang) + vv * th)))
        rings.append(ring)
    o = loft(name, rings, m)
    me = o.data
    uv = me.uv_layers.new(name='UVMap')
    for li, lp in enumerate(me.loops):
        co = me.vertices[lp.vertex_index].co
        uv.data[li].uv = (co.x / tile, co.y / tile)
    return o

for s, (sx, sy, spin, c) in MOTORS.items():
    e = bpy.data.objects[f'rotor_{s}']
    for k in range(2):
        b = blade(f'rotor_{s}_b{k}', PROP_R, 0.026, 0.020, spin, PITCH, CARBON)
        b.parent = e
        b.rotation_euler = (0, 0, math.pi * k)
    cyl(f'rotor_{s}_hub', 0.0115, 0.008, (0, 0, 0), CARBON, parent=e, uv=0.018)
    cyl(f'rotor_{s}_cap', 0.0095, 0.003, (0, 0, 0.0055), RED, parent=e, verts=24)
    for k in (-1, 1):
        cyl(f'rotor_{s}_screw{k:+d}', 0.0019, 0.0022, (k * 0.0052, 0, 0.0078), SCREW, parent=e, verts=10)
    cyl(f'rotor_{s}_shaft', 0.0025, 0.007, (0, 0, 0.009), STEEL, parent=e, verts=12)

# ── FC — Pixhawk 2.4.8 (81.5×50×15.5), 파란 댐퍼 위 방진판 ──────────────
DH = 0.007
for sx in (-1, 1):
    for sy in (-1, 1):
        cyl(f'fc_damper_{sx:+d}{sy:+d}', 0.0045, DH, (sx * 0.029, sy * 0.043, TOP_Z1 + DH / 2), DAMPER, verts=16)
MZ = TOP_Z1 + DH + 0.0008
box('fc_mount', (0.066, 0.096, 0.0016), (0, 0, MZ), PCB, bevel=0.002)
FCY, FCZ = 0.0, MZ + 0.0008 + 0.00775
box('fc', (0.050, 0.0815, 0.0155), (0, FCY, FCZ), BLACK, bevel=0.004)
FT = FCZ + 0.00775
for i, (x, y) in enumerate(((0.017, -0.030), (0.017, -0.018), (0.017, 0.0), (0.017, 0.014), (0.004, 0.024),
                            (-0.006, 0.024), (-0.016, 0.03), (-0.016, 0.012), (-0.004, -0.004),
                            (0.006, 0.010), (-0.016, -0.026))):
    box(f'fc_conn_{i}', (0.0045, 0.0065, 0.003), (x, FCY + y, FT + 0.0012), BEIGE)
cyl('fc_led', 0.0028, 0.0008, (0.0, FCY - 0.012, FT), WHITE, verts=16)
box('fc_rail', (0.034, 0.005, 0.008), (0, FCY + 0.042, FCZ + 0.001), BAND)   # 서보 레일 — 뒤끝
# 앞 방향 화살표 (기수 -Y)
me = bpy.data.meshes.new('fc_arrow')
bm = bmesh.new()
z = FT + 0.0002
vs = [bm.verts.new(p) for p in ((0.004, FCY - 0.036, z), (0.013, FCY - 0.026, z), (0.013, FCY - 0.020, z),
                                (0.004, FCY - 0.026, z), (-0.005, FCY - 0.020, z), (-0.005, FCY - 0.026, z))]
bm.faces.new(vs)
bm.to_mesh(me); bm.free()
obj('fc_arrow', me, WHITE, root, smooth=False)
# I2C 분배기 — 윗판 왼쪽
box('i2c_splitter', (0.020, 0.034, 0.009), (0.052, 0.008, TOP_Z1 + 0.0045), BLACK, bevel=0.0012)
for i, y in enumerate((-0.011, 0.0, 0.011)):
    box(f'i2c_conn_{i}', (0.006, 0.0055, 0.003), (0.052, 0.008 + y, TOP_Z1 + 0.0105), BEIGE)
# 부저 — 앞 오른쪽
cyl('buzzer', 0.011, 0.011, (-0.022, -0.056, TOP_Z1 + 0.0055), BLACK, verts=24)

# ── GPS — FC 오른쪽 뒤 마스트 위 둥근 퍽 (M8N) ─────────────────────────
GX, GY, GZ = -0.052, 0.016, 0.205
cyl('gps_mast_base', 0.0085, 0.028, (GX, GY, TOP_Z1 + 0.014), BLACK, r2=0.0055, verts=16)
cyl('gps_mast', 0.0035, GZ - TOP_Z1 - 0.03, (GX, GY, (GZ + TOP_Z1) / 2 + 0.006), BLACK, verts=12)
cyl('gps_mast_top', 0.008, 0.006, (GX, GY, GZ - 0.011), BLACK, verts=16)
gps = revolve('gps', [(0.0, -0.008), (0.029, -0.008), (0.030, -0.005), (0.030, 0.003), (0.027, 0.008),
                      (0.0, 0.0095)], (GX, GY, GZ), GPSM, n=48)
cyl('gps_ring', 0.0225, 0.0006, (0, 0, 0.0091), GPSG, parent=gps, r2=0.0205, verts=48)
cyl('gps_ring_in', 0.0195, 0.0008, (0, 0, 0.0092), GPSM, parent=gps, verts=48)
tube('gps_cable', [(GX - 0.028, GY + 0.01, GZ), (GX - 0.04, GY + 0.035, GZ - 0.03),
                   (GX - 0.02, GY + 0.04, GZ - 0.11), (GX + 0.03, GY + 0.035, FT + 0.02),
                   (0.004, 0.034, FT + 0.002)], 0.0017, BLACK)

# ── 판 아래 — 레일·앞 배터리판·XT60·수신기 ─────────────────────────────
RX, RZ, RR = 0.042, BOT_Z0 - 0.0095, 0.005
for sx in (-1, 1):
    cyl(f'rail_{sx:+d}', RR, 0.29, (sx * RX, -0.012, RZ), BLACK, rot=(math.pi / 2, 0, 0), verts=20)
    for sy in (-1, 1):
        box(f'rail_clamp_{sx:+d}{sy:+d}', (0.016, 0.014, 0.012), (sx * RX, sy * 0.055, RZ + 0.004), BLACK, bevel=0.002)
PZ = RZ + RR + 0.0009
box('mount_plate_edge', (0.10, 0.07, 0.0016), (0, -0.118, PZ), GOLD, bevel=0.003)
box('mount_plate', (0.097, 0.067, 0.0018), (0, -0.118, PZ), PCB, bevel=0.003)
for i, y in enumerate((-0.137, -0.121, -0.105)):
    box(f'mount_slot_{i}', (0.052, 0.0036, 0.0019), (0.004, y, PZ), GOLD)
    box(f'mount_slot_in_{i}', (0.050, 0.0028, 0.0021), (0.004, y, PZ), BLACK)
for i, (x, y, z) in enumerate(((0.058, -0.128, PZ - 0.004), (0.066, -0.100, RZ - 0.02))):
    box(f'xt60_{i}', (0.016, 0.022, 0.008), (x, y, z), XT, bevel=0.0015)
    for dx, m in ((-0.003, WRED), (0.003, BLACK)):
        tube(f'xt60_{i}_lead{"r" if m is WRED else "k"}',
             [(x + dx, y + 0.011, z), (x * 0.8 + dx, y + 0.035, z + 0.004), (0.035 + dx, -0.06, BOT_Z0 - 0.002)],
             0.0022, m, k=4)
box('receiver', (0.016, 0.036, 0.026), (0.058, 0.03, BOT_Z0 - 0.03), BLACK, bevel=0.0015)
box('receiver_pins', (0.012, 0.03, 0.003), (0.058, 0.03, BOT_Z0 - 0.0155), GPSG)

# ── 배터리 — 4S 2900 mAh (가정: 138×43×30), 레일 아래 스트랩 ────────────
BZ = RZ - RR - 0.0152
box('battery', (0.043, 0.138, 0.030), (0, -0.01, BZ), BATT, bevel=0.003)
box('battery_label', (0.0435, 0.06, 0.0305), (0, 0.0, BZ), LABEL, bevel=0.003)
for sy in (-0.05, 0.03):
    box(f'battery_strap{sy:+.2f}', (0.1, 0.018, 0.0022), (0, sy, RZ + RR + 0.0011), BLACK)
    box(f'battery_strap_b{sy:+.2f}', (0.047, 0.018, 0.0022), (0, sy, BZ - 0.0161), BLACK)
    zt, zb = RZ + RR + 0.0022, BZ - 0.0172
    for sx in (-1, 1):
        box(f'battery_strap_s{sy:+.2f}{sx:+d}', (0.0022, 0.018, zt - zb), (sx * 0.0235, sy, (zt + zb) / 2), BLACK)
tube('battery_lead_r', [(0.006, -0.079, BZ), (0.014, -0.1, BZ + 0.004), (0.03, -0.13, RZ - 0.01)], 0.0022, WRED, k=4)
tube('battery_lead_k', [(-0.006, -0.079, BZ), (0.004, -0.1, BZ + 0.002), (0.024, -0.13, RZ - 0.014)], 0.0022, BLACK, k=4)
box('battery_xt60', (0.016, 0.022, 0.008), (0.028, -0.142, RZ - 0.012), XT, rot=(0, 0, 0.3), bevel=0.0015)

# ── 랜딩기어 — 좌우 카본 다리 하나씩, T 조인트, 앞뒤로 뻗은 스키드 (빨강·검정 폼) ──
GXL = 0.078
SZ = FLOOR + 0.0105
for sx, s in ((1, 'L'), (-1, 'R')):
    x = sx * GXL
    box(f'gear_clamp_{s}', (0.022, 0.03, 0.012), (x, 0, BOT_Z0 - 0.006), BLACK, bevel=0.002)
    rod(f'gear_leg_{s}', (x, 0, BOT_Z0 - 0.008), (x, 0, SZ + 0.018), 0.008, CARBON, verts=24, uv=0.018)
    cyl(f'gear_tee_{s}', 0.0095, 0.02, (x, 0, SZ + 0.012), BLACK, verts=20)
    cyl(f'gear_tee_bar_{s}', 0.0085, 0.028, (x, 0, SZ), BLACK, rot=(math.pi / 2, 0, 0), verts=20)
    cyl(f'gear_skid_{s}', 0.005, 0.27, (x, 0, SZ), BLACK, rot=(math.pi / 2, 0, 0), verts=16)
    for sy in (-1, 1):
        y0, y1 = 0.02, 0.125
        cyl(f'gear_foam_{s}{sy:+d}', 0.0105, y1 - y0, (x, sy * (y0 + y1) / 2, SZ), FOAM,
            rot=(math.pi / 2, 0, 0), verts=24)
        k = 0
        y = y0 + 0.008
        while y < y1 - 0.004:
            cyl(f'gear_stripe_{s}{sy:+d}_{k}', 0.0108, 0.0035, (x, sy * y, SZ), FOAMR,
                rot=(math.pi / 2, 0.18 * sy, 0), verts=24)
            y += 0.0165
            k += 1
        cyl(f'gear_cap_{s}{sy:+d}', 0.0058, 0.008, (x, sy * 0.136, SZ), BLACK, rot=(math.pi / 2, 0, 0), verts=16)

# ── 클릭 영역 (bay_*) — 안 보이게, 광선만 맞는다 ──────────────────────
def boxes(name, parts):
    """여러 상자를 한 메시로 — parts: [(size, loc, rot_z)]."""
    bm = bmesh.new()
    for size, loc, rz in parts:
        g = bmesh.ops.create_cube(bm, size=1.0)['verts']
        bmesh.ops.scale(bm, vec=Vector(size), verts=g)
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rz, 3, 'Z'), verts=g)
        bmesh.ops.translate(bm, vec=Vector(loc), verts=g)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    return obj(name, me, BAYVOL, root, smooth=False)

boxes('bay_battery', [((0.054, 0.152, 0.040), (0, -0.01, BZ), 0)])
boxes('bay_fc', [((0.070, 0.10, 0.026), (0, FCY, (TOP_Z1 + FT) / 2 + 0.001), 0)])
bay_power = [((0.11, 0.11, 0.006), (0, 0, (BOT_Z0 + BOT_Z1) / 2), math.pi / 4)]   # 전원분배판
for s, (sx, sy, _, _) in MOTORS.items():
    a = math.atan2(sy, sx)
    bay_power.append(((0.062, 0.032, 0.016), (math.cos(a) * 0.15, math.sin(a) * 0.15, -arm_h(0.15) / 2 - 0.0048), a))
boxes('bay_power', bay_power)
cyl('bay_gps', 0.036, 0.03, (GX, GY, GZ + 0.001), BAYVOL, verts=32)

# ── 내보내기 ─────────────────────────────────────────────────────────
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=False,
                          export_yup=True, export_apply=True, export_materials='EXPORT')
print('wrote', OUT)

if PREVIEW:
    for o in scn.objects:
        if o.name.startswith('bay_'):
            o.hide_render = True
    fl = box('preview_floor', (4, 4, 0.001), (0, 0, FLOOR - 0.0006), mat('table', srgb('#2a2b2e'), 0.7), parent=None)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0
    sun.data.angle = 0.3
    sun.rotation_euler = (0.5, -0.2, 0.9)
    scn.collection.objects.link(sun)
    w = bpy.data.worlds.new('w'); scn.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.9, 0.9, 0.88, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = 64
    scn.cycles.device = 'CPU'
    scn.render.resolution_x, scn.render.resolution_y = 1600, 1200

    def shot(path, loc, target, lens):
        cam.location = loc
        cam.data.lens = lens
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)

    # 사진과 같은 자리 — 왼쪽(약간 앞) 위에서, 기수가 화면 왼쪽
    az, el, dist = math.radians(-18), math.radians(56), 0.74
    T = Vector((0, 0.01, -0.02))
    shot(PREVIEW, T + dist * Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))), T, 26)
    fl.hide_render = True
    shot(PREVIEW.replace('.png', '_top.png'), (0, 0.0001, 2.0), (0, 0, 0), 50)
    shot(PREVIEW.replace('.png', '_side.png'), (1.6, 0, 0.0), (0, 0, 0.0), 50)
