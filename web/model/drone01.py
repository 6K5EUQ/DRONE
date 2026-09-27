"""DRONE01 (2 kg 급 쿼드콥터 X) — 콕핏 화면용 3D 모델 (.glb).

    ~/tools/blender-4.5.9-linux-x64/blender -b -P web/model/drone01.py -- web/public/model/drone01.glb [preview.png]

치수 출처:
  모터 3508-380KV Φ41.8×26.5, 빨간 알루미늄 벨·검은 스테이터 — components/motors/gt-drone-3508-380kv
  프롭 12×4.5 2엽 (R 0.1524)                                   — components/props/12x45
  FC Pixhawk 2.4.8, ESC EC-X3 30A ×4, 배터리 4S 2900 mAh        — components/*, README
가정 (문서에 없음 — 실측으로 바꿀 것):
  휠베이스 0.55 m (대각 모터 간) — components/frame 비어 있음. 12인치 최소 ~0.33 m (design/01 §7)
  배터리 140×45×32 mm, 센터판 아래 · GPS 퍽 Φ50 마스트 위 · 랜딩기어 스키드형

좌표 (Blender): 기수 -Y, 위 +Z, 왼쪽 +X. glTF 로 내보내면 기수 +Z, 위 +Y.
원점 = 두 센터판 사이 한가운데. 스키드 바닥 z = -0.125 (화면 FLOOR).
three.js 쪽이 이름으로 찾는 노드: rotor_LF/RF/LB/RB (로컬 Y 가 회전축), gps, bay_*.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'drone01.glb'
PREVIEW = argv[1] if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

# ── 재질 ──────────────────────────────────────────────────────────────
def mat(name, rgb, rough=0.5, metal=0.0, clear=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if clear:
        b.inputs['Coat Weight'].default_value = clear
    return m

def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

SHELL = mat('shell', srgb('#f3f4f5'), 0.35, 0.0, 0.4)   # 윗판 — 흰 광택
PLATE = mat('plate', srgb('#dfe2e5'), 0.5)             # 아랫판·기어 — 옅은 회색
CARBON = mat('carbon', srgb('#202226'), 0.3, 0.3, 0.6)
BLACK = mat('black', srgb('#17181b'), 0.5)
INK = mat('ink', srgb('#111214'), 0.7)
RED = mat('motor_red', srgb('#c0262b'), 0.3, 0.8)       # 3508 벨 — 빨간 알루미늄
ALU = mat('alu', srgb('#c3c7cc'), 0.28, 0.95)
FCCASE = mat('fc_case', srgb('#e9eaec'), 0.4)
GREY = mat('dark_grey', srgb('#2e3238'), 0.35, 0.2)
BATT = mat('battery', srgb('#2a2e36'), 0.45)
LABEL = mat('label_red', srgb('#c8302d'), 0.5)
XT = mat('xt_yellow', srgb('#e0b51f'), 0.5)
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

def loft(name, rings, m, cap=True, parent=None, smooth=True):
    """rings: 같은 개수의 닫힌 고리. 사이를 사각면으로 잇는다."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for a, b in zip(vs, vs[1:]):
        for j in range(n):
            bm.faces.new((a[j], a[(j + 1) % n], b[(j + 1) % n], b[j]))
    if cap:
        bm.faces.new(list(reversed(vs[0])))
        bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return obj(name, me, m, parent, smooth)

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

def cyl(name, r, h, loc, m, parent=root, rot=(0, 0, 0), verts=32, r2=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    bm.to_mesh(me)
    bm.free()
    o = obj(name, me, m, parent)
    o.location = loc
    o.rotation_euler = rot
    return o

def rrect(w, l, r, z, n=6):
    """가로 w(X)·세로 l(Y)·모서리 반경 r 의 둥근 사각 고리 (높이 z)."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, l / 2 - r, 0), (-w / 2 + r, l / 2 - r, 90),
                       (-w / 2 + r, -l / 2 + r, 180), (w / 2 - r, -l / 2 + r, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append(Vector((cx + r * math.cos(a), cy + r * math.sin(a), z)))
    return pts

def slab(name, w, l, r, z0, z1, m, parent=root, inset=0.0015):
    """둥근 사각판 — 윗모서리를 살짝 깎는다."""
    rings = [rrect(w, l, r, z0), rrect(w, l, r, z1 - inset), rrect(w - 2 * inset, l - 2 * inset, r - inset, z1)]
    return loft(name, rings, m, parent=parent, smooth=False)

# ── 치수 ─────────────────────────────────────────────────────────────
WHEELBASE = 0.55                   # 대각 모터 간 — 가정 (components/frame 비어 있음)
ARM_R = WHEELBASE / 2              # 중심 → 모터 축
TUBE = 0.008                       # 암 파이프 반경 (Φ16 카본)
PLATE_W, PLATE_L = 0.15, 0.21      # 센터판 X·Y
TOP_Z0, TOP_Z1 = 0.0095, 0.0125    # 윗판
BOT_Z0, BOT_Z1 = -0.0125, -0.0095  # 아랫판
FLOOR = -0.125                     # 스키드 바닥
PROP_R = 0.1524                    # 12 인치

# ── 센터판 ───────────────────────────────────────────────────────────
slab('top_plate', PLATE_W, PLATE_L, 0.032, TOP_Z0, TOP_Z1, SHELL)
slab('bottom_plate', PLATE_W - 0.01, PLATE_L - 0.01, 0.03, BOT_Z0, BOT_Z1, PLATE)
for sx in (-1, 1):
    for sy in (-1, 1):   # 판 사이 스탠드오프
        cyl(f'standoff_{sx}{sy}', 0.0035, TOP_Z0 - BOT_Z1, (sx * 0.05, sy * 0.035, 0), ALU, verts=12)

# ── 암·모터·프롭 ─────────────────────────────────────────────────────
def blade(name, R, root_c, tip_c, spin, pitch, m, n=12, thick=0.0045):
    """허브에서 +X 로 뻗는 날 한 장. spin=+1 이면 위에서 봐 반시계 — 앞전이 +Y, 앞전이 높다."""
    prof = [(0.0, 0.0), (0.08, 0.55), (0.35, 0.5), (1.0, 0.0), (0.35, -0.2), (0.08, -0.3)]
    rings = []
    for k in range(n + 1):
        t = k / n
        x = 0.012 + (R - 0.012) * t
        c = root_c + (tip_c - root_c) * t ** 0.8
        c *= 1 - (t ** 6) * 0.55
        if t < 0.12:
            c = root_c * (0.6 + 0.4 * t / 0.12)
        ang = math.atan(pitch / (2 * math.pi * x)) * 0.9      # 피치 4.5" 에 맞춘 비틀림
        th = thick * (1 - 0.6 * t)
        ring = []
        for u, v in prof:
            a = (0.3 - u) * c                                  # 앞전 쪽이 +
            ring.append(Vector((x, spin * a * math.cos(ang), a * math.sin(ang) + v * th)))
        rings.append(ring)
    return loft(name, rings, m)

PITCH = 4.5 * 0.0254
# ArduCopter 쿼드 X: 1 RF·2 LB 반시계, 3 LF·4 RB 시계 — 화면의 dir 과 같다
MOTORS = {'LF': (1, -1, -1), 'RF': (-1, -1, 1), 'LB': (1, 1, 1), 'RB': (-1, 1, -1)}  # sx, sy, spin
PHASE = {'LF': 0.5, 'RF': 2.1, 'LB': 1.2, 'RB': 2.7}

for s, (sx, sy, spin) in MOTORS.items():
    a = math.atan2(sy, sx)
    ux, uy = math.cos(a), math.sin(a)
    at = lambda r, z=0.0: (ux * r, uy * r, z)
    # 암 — 카본 파이프, 판 사이에서 모터 너머까지
    r0, r1 = 0.045, ARM_R + 0.022
    cyl(f'arm_{s}', TUBE, r1 - r0, at((r0 + r1) / 2), CARBON, rot=(0, math.pi / 2, a), verts=20)
    cyl(f'arm_cap_{s}', TUBE * 1.05, 0.004, at(r1 + 0.001), BLACK, rot=(0, math.pi / 2, a), verts=20)
    # 판 가장자리 클램프 (흰색)
    box(f'arm_clamp_{s}', (0.03, 0.026, TOP_Z0 - BOT_Z1 + 0.002), at(0.115), PLATE, rot=(0, 0, a), bevel=0.003)
    # ESC — 암 아래, 판 바깥
    box(f'esc_{s}', (0.048, 0.024, 0.009), at(0.16, -TUBE - 0.0048), GREY, rot=(0, 0, a), bevel=0.002)
    box(f'esc_label_{s}', (0.02, 0.0245, 0.0095), at(0.165, -TUBE - 0.0048), PLATE, rot=(0, 0, a))
    # 모터 마운트 — 파이프를 감싸는 흰 블록 + 둥근 받침
    box(f'mount_clamp_{s}', (0.036, 0.022, 0.022), at(ARM_R), SHELL, rot=(0, 0, a), bevel=0.004)
    cyl(f'mount_{s}', 0.025, 0.004, at(ARM_R, 0.013), SHELL, verts=32)
    # 모터 3508 — Φ41.8 × 26.5 : 검은 스테이터 하우징 + 빨간 벨
    mz = 0.015
    cyl(f'motor_base_{s}', 0.0205, 0.008, at(ARM_R, mz + 0.004), BLACK)
    cyl(f'motor_{s}', 0.0209, 0.0165, at(ARM_R, mz + 0.0165), RED)
    cyl(f'motor_top_{s}', 0.0209, 0.002, at(ARM_R, mz + 0.0255), RED, r2=0.017)
    cyl(f'motor_shaft_{s}', 0.004, 0.008, at(ARM_R, mz + 0.030), ALU, verts=12)
    # 프롭 — 빈 객체(회전축) 아래 날 두 장·허브·너트. 로컬 Z(glTF Y) 가 회전축
    e = bpy.data.objects.new(f'rotor_{s}', None)
    scn.collection.objects.link(e)
    e.parent = root
    e.location = at(ARM_R, mz + 0.032)
    e.rotation_euler = (0, 0, PHASE[s])
    for k in range(2):
        b = blade(f'rotor_{s}_b{k}', PROP_R, 0.030, 0.015, spin, PITCH, CARBON)
        b.parent = e
        b.rotation_euler = (0, 0, math.pi * k)
    cyl(f'rotor_{s}_hub', 0.012, 0.009, (0, 0, 0), BLACK, parent=e)
    cyl(f'rotor_{s}_nut', 0.007, 0.010, (0, 0, 0.009), ALU, parent=e, r2=0.004, verts=16)

# ── 랜딩기어 — 판 아래 좌우 다리 + 스키드 ─────────────────────────────
GX = 0.085
for sx, s in ((1, 'L'), (-1, 'R')):
    for sy in (-1, 1):
        top = Vector((sx * 0.05, sy * 0.045, BOT_Z0))
        bot = Vector((sx * GX, sy * 0.065, FLOOR + 0.006))
        d = bot - top
        o = cyl(f'gear_leg_{s}{"F" if sy < 0 else "B"}', 0.005, d.length, (top + bot) / 2, PLATE, verts=16)
        o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    cyl(f'gear_skid_{s}', 0.006, 0.23, (sx * GX, 0, FLOOR + 0.006), PLATE, rot=(math.pi / 2, 0, 0), verts=20)
    for sy in (-1, 1):
        cyl(f'gear_cap_{s}{sy}', 0.0065, 0.012, (sx * GX, sy * 0.119, FLOOR + 0.006), BLACK,
            rot=(math.pi / 2, 0, 0), verts=20)
    box(f'gear_foot_{s}', (0.004, 0.2, 0.0004), (sx * GX, 0, FLOOR + 0.0004), BLACK)

# ── 배터리 — 4S 2900 mAh, 아랫판 밑 스트랩 ───────────────────────────
BZ = BOT_Z0 - 0.002 - 0.016
box('battery', (0.045, 0.14, 0.032), (0, 0.0, BZ), BATT, bevel=0.003)
box('battery_label', (0.0455, 0.05, 0.0325), (0, 0.02, BZ), LABEL, bevel=0.003)
box('battery_xt60', (0.016, 0.016, 0.008), (0.01, 0.078, BZ + 0.008), XT, bevel=0.0015)
for sy in (-0.04, 0.045):
    box(f'battery_strap{sy:+.2f}', (0.049, 0.016, 0.037), (0, sy, BZ + 0.002), BLACK)

# ── FC — Pixhawk 2.4.8 (81.5×50×15.5), 윗판 위 방진 패드 ─────────────
FCY, FCZ = 0.008, TOP_Z1 + 0.003 + 0.0078
box('fc_pad', (0.04, 0.06, 0.003), (0, FCY, TOP_Z1 + 0.0015), BLACK)
box('fc', (0.050, 0.0815, 0.0155), (0, FCY, FCZ), FCCASE, bevel=0.004)
box('fc_top', (0.040, 0.066, 0.001), (0, FCY, FCZ + 0.0078), GREY, bevel=0.0004)
# 앞 방향 화살표 (기수 -Y)
me = bpy.data.meshes.new('fc_arrow')
bm = bmesh.new()
z = FCZ + 0.0085
vs = [bm.verts.new(p) for p in ((0, FCY - 0.026, z), (-0.009, FCY - 0.012, z), (-0.003, FCY - 0.012, z),
                                (-0.003, FCY + 0.004, z), (0.003, FCY + 0.004, z), (0.003, FCY - 0.012, z),
                                (0.009, FCY - 0.012, z))]
bm.faces.new(vs)
bm.to_mesh(me); bm.free()
obj('fc_arrow', me, SHELL, root, smooth=False)

# ── GPS — 뒤쪽 마스트 위 둥근 퍽 ─────────────────────────────────────
GY, GZ = 0.075, 0.125
cyl('gps_mast_base', 0.009, 0.006, (0, GY, TOP_Z1 + 0.003), BLACK, verts=16)
cyl('gps_mast', 0.004, GZ - TOP_Z1 - 0.01, (0, GY, (GZ + TOP_Z1) / 2 - 0.004), CARBON, verts=12)
gps = cyl('gps', 0.025, 0.014, (0, GY, GZ), BLACK, verts=40)
cyl('gps_dome', 0.024, 0.004, (0, 0, 0.009), GREY, parent=gps, r2=0.018, verts=40)
box('gps_arrow', (0.004, 0.014, 0.0006), (0, -0.006, 0.0112), SHELL, parent=gps)

# ── 기체명 — 윗판 앞쪽, 뒤에서 읽힌다 (읽는 방향 -X, 글자 윗변이 기수) ─
FONT = None
for f in ('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
    if os.path.exists(f):
        FONT = bpy.data.fonts.load(f)
        break
cu = bpy.data.curves.new('name', 'FONT')
cu.body = 'DRONE01'
if FONT:
    cu.font = FONT
cu.align_x = cu.align_y = 'CENTER'
cu.resolution_u = 3
t = bpy.data.objects.new('name', cu)
scn.collection.objects.link(t)
bpy.context.view_layer.objects.active = t
t.select_set(True)
bpy.ops.object.convert(target='MESH')
t.select_set(False)
xs = [v.co.x for v in t.data.vertices]
k = 0.078 / (max(xs) - min(xs))
for v in t.data.vertices:
    x, y = v.co.x * k, v.co.y * k
    v.co = Vector((-x, -0.068 - y, TOP_Z1 + 0.0004))
t.data.materials.append(INK)
t.parent = root

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

boxes('bay_battery', [((0.056, 0.152, 0.042), (0, 0, BZ), 0)])
boxes('bay_fc', [((0.058, 0.09, 0.024), (0, FCY, FCZ), 0)])
bay_power = []
for s, (sx, sy, _) in MOTORS.items():
    a = math.atan2(sy, sx)
    bay_power.append(((0.058, 0.032, 0.016), (math.cos(a) * 0.16, math.sin(a) * 0.16, -TUBE - 0.0048), a))
boxes('bay_power', bay_power)
cyl('bay_gps', 0.032, 0.03, (0, GY, GZ + 0.002), BAYVOL, verts=32)

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
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam)
    cam.data.lens = 55
    cam.location = (1.0, 1.25, 0.95)          # 왼쪽 뒤 위에서 — 기수(-Y)가 화면 안쪽
    d = Vector((0, 0, -0.02)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scn.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.5
    sun.rotation_euler = (0.6, 0.3, 0.8)
    scn.collection.objects.link(sun)
    w = bpy.data.worlds.new('w'); scn.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.9, 0.88, 0.89, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.8
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = 48
    scn.cycles.device = 'CPU'
    scn.render.resolution_x, scn.render.resolution_y = 1400, 900
    scn.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    # 위에서 — 기수가 화면 위
    cam.location = (0, 0, 2.2); cam.rotation_euler = (0, 0, math.pi); cam.data.lens = 50
    scn.render.filepath = PREVIEW.replace('.png', '_top.png')
    bpy.ops.render.render(write_still=True)
    # 옆에서 — 기수가 화면 왼쪽
    cam.location = (1.6, 0, -0.03); cam.rotation_euler = (math.pi / 2, 0, math.pi / 2); cam.data.lens = 50
    scn.render.filepath = PREVIEW.replace('.png', '_side.png')
    bpy.ops.render.render(write_still=True)
