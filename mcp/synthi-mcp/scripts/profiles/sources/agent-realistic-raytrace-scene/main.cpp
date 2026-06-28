// User-authored single-file GPU realistic ray-tracing visual app.
// Deterministic validation fixture: fixed camera, fixed scene, fixed lights,
// no temporal accumulation, and GPU-rendered framebuffer pixels.
// GPU_TARGET: rocm
// LINK: -lSDL2 -lamdhip64
// BUILD: hipcc main.cpp -lSDL2 -lamdhip64
#include <SDL2/SDL.h>
#include <hip/hip_runtime.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "scene_config.h"

struct Vec3 {
    float x;
    float y;
    float z;
};

struct Hit {
    float t;
    Vec3 p;
    Vec3 n;
    int material;
    float id;
};

__device__ Vec3 make3(float x, float y, float z) { return Vec3{x, y, z}; }
__device__ Vec3 add3(Vec3 a, Vec3 b) { return make3(a.x + b.x, a.y + b.y, a.z + b.z); }
__device__ Vec3 sub3(Vec3 a, Vec3 b) { return make3(a.x - b.x, a.y - b.y, a.z - b.z); }
__device__ Vec3 mul3(Vec3 a, float s) { return make3(a.x * s, a.y * s, a.z * s); }
__device__ Vec3 hadamard3(Vec3 a, Vec3 b) { return make3(a.x * b.x, a.y * b.y, a.z * b.z); }
__device__ float dot3(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
__device__ Vec3 cross3(Vec3 a, Vec3 b) {
    return make3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
__device__ float clampf(float v, float lo, float hi) { return fminf(hi, fmaxf(lo, v)); }
__device__ float fract1(float v) { return v - floorf(v); }
__device__ float smooth01(float v) {
    v = clampf(v, 0.0f, 1.0f);
    return v * v * (3.0f - 2.0f * v);
}
__device__ Vec3 clamp3(Vec3 v, float lo, float hi) {
    return make3(clampf(v.x, lo, hi), clampf(v.y, lo, hi), clampf(v.z, lo, hi));
}
__device__ Vec3 normalize3(Vec3 v) {
    float inv = rsqrtf(fmaxf(dot3(v, v), 0.0000001f));
    return mul3(v, inv);
}
__device__ Vec3 reflect3(Vec3 i, Vec3 n) { return sub3(i, mul3(n, 2.0f * dot3(i, n))); }
__device__ Vec3 mix3(Vec3 a, Vec3 b, float t) { return add3(mul3(a, 1.0f - t), mul3(b, t)); }

__device__ Vec3 refract3(Vec3 i, Vec3 n, float eta) {
    float cosi = clampf(-dot3(i, n), -1.0f, 1.0f);
    float sint2 = eta * eta * fmaxf(0.0f, 1.0f - cosi * cosi);
    if (sint2 > 1.0f) return reflect3(i, n);
    float cost = sqrtf(fmaxf(0.0f, 1.0f - sint2));
    return normalize3(add3(mul3(i, eta), mul3(n, eta * cosi - cost)));
}

__device__ unsigned int packColor(Vec3 c) {
    c = make3(fmaxf(0.0f, c.x), fmaxf(0.0f, c.y), fmaxf(0.0f, c.z));
    c = make3(
        (c.x * (2.51f * c.x + 0.03f)) / (c.x * (2.43f * c.x + 0.59f) + 0.14f),
        (c.y * (2.51f * c.y + 0.03f)) / (c.y * (2.43f * c.y + 0.59f) + 0.14f),
        (c.z * (2.51f * c.z + 0.03f)) / (c.z * (2.43f * c.z + 0.59f) + 0.14f)
    );
    c = clamp3(c, 0.0f, 1.0f);
    c = make3(powf(c.x, 1.0f / 2.2f), powf(c.y, 1.0f / 2.2f), powf(c.z, 1.0f / 2.2f));
    unsigned int r = (unsigned int)(c.x * 255.0f + 0.5f);
    unsigned int g = (unsigned int)(c.y * 255.0f + 0.5f);
    unsigned int b = (unsigned int)(c.z * 255.0f + 0.5f);
    return 0xff000000u | (r << 16) | (g << 8) | b;
}

__device__ Vec3 environmentColor(Vec3 rd) {
    float up = clampf(rd.y * 0.5f + 0.5f, 0.0f, 1.0f);
    Vec3 sky = mix3(make3(0.54f, 0.61f, 0.67f), make3(0.90f, 0.94f, 1.0f), up);
    float cityBand = smooth01(clampf((0.18f - rd.y) / 0.22f, 0.0f, 1.0f));
    Vec3 city = make3(0.34f + 0.05f * sinf(rd.x * 31.0f), 0.35f, 0.34f);
    float sun = powf(fmaxf(0.0f, dot3(rd, normalize3(make3(-0.35f, 0.62f, -0.28f)))), 180.0f);
    return add3(mix3(sky, city, cityBand * 0.26f), mul3(make3(1.0f, 0.86f, 0.55f), sun * 2.4f));
}

__device__ Vec3 rotateY(Vec3 p, float angle) {
    float c = cosf(angle);
    float s = sinf(angle);
    return make3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
}

__device__ bool clipDiamondPlane(
    Vec3 ro,
    Vec3 rd,
    Vec3 planeN,
    float planeD,
    float& tEnter,
    float& tExit,
    Vec3& enterNormal,
    Vec3& exitNormal
) {
    float denom = dot3(planeN, rd);
    float dist = planeD - dot3(planeN, ro);
    if (fabsf(denom) < 0.000001f) {
        return dist >= 0.0f;
    }
    float tPlane = dist / denom;
    Vec3 n = normalize3(planeN);
    if (denom < 0.0f) {
        if (tPlane > tEnter) {
            tEnter = tPlane;
            enterNormal = n;
        }
    } else {
        if (tPlane < tExit) {
            tExit = tPlane;
            exitNormal = n;
        }
    }
    return tEnter <= tExit;
}

__device__ bool intersectDiamond(Vec3 ro, Vec3 rd, Vec3 center, float scale, float rotation, float& t, Vec3& normal) {
    Vec3 lo = mul3(rotateY(sub3(ro, center), -rotation), 1.0f / scale);
    Vec3 ld = mul3(rotateY(rd, -rotation), 1.0f / scale);
    float tEnter = -1.0e20f;
    float tExit = 1.0e20f;
    Vec3 enterNormal = make3(0.0f, 1.0f, 0.0f);
    Vec3 exitNormal = make3(0.0f, -1.0f, 0.0f);

    const float tableY = 0.38f;
    const float bottomY = -0.90f;
    const float girdleRadius = 0.86f;
    const float tableRadius = 0.30f;
    const float crownSlope = (tableRadius - girdleRadius) / tableY;
    const float pavilionSlope = girdleRadius / (0.0f - bottomY);

    if (!clipDiamondPlane(lo, ld, make3(0.0f, 1.0f, 0.0f), tableY, tEnter, tExit, enterNormal, exitNormal)) return false;
    for (int i = 0; i < 16; ++i) {
        float a = ((float)i + 0.5f) * (2.0f * PI / 16.0f);
        Vec3 h = make3(cosf(a), 0.0f, sinf(a));
        Vec3 crownN = make3(h.x, -crownSlope, h.z);
        Vec3 pavilionN = make3(h.x, -pavilionSlope, h.z);
        if (!clipDiamondPlane(lo, ld, crownN, girdleRadius, tEnter, tExit, enterNormal, exitNormal)) return false;
        if (!clipDiamondPlane(lo, ld, pavilionN, -pavilionSlope * bottomY, tEnter, tExit, enterNormal, exitNormal)) return false;
    }

    t = tEnter > 0.02f ? tEnter : tExit;
    if (t <= 0.02f || t > 1.0e19f) return false;
    Vec3 n = tEnter > 0.02f ? enterNormal : mul3(exitNormal, -1.0f);
    normal = normalize3(rotateY(n, rotation));
    return true;
}

__device__ bool intersectEllipsoid(Vec3 ro, Vec3 rd, Vec3 center, Vec3 radius, float& t, Vec3& normal) {
    Vec3 oc = sub3(ro, center);
    Vec3 qro = make3(oc.x / radius.x, oc.y / radius.y, oc.z / radius.z);
    Vec3 qrd = make3(rd.x / radius.x, rd.y / radius.y, rd.z / radius.z);
    float a = dot3(qrd, qrd);
    float b = 2.0f * dot3(qro, qrd);
    float c = dot3(qro, qro) - 1.0f;
    float disc = b * b - 4.0f * a * c;
    if (disc < 0.0f) return false;
    float root = sqrtf(disc);
    float invDenom = 0.5f / a;
    float t0 = (-b - root) * invDenom;
    float t1 = (-b + root) * invDenom;
    t = t0 > 0.02f ? t0 : t1;
    if (t <= 0.02f) return false;
    Vec3 p = add3(ro, mul3(rd, t));
    Vec3 lp = sub3(p, center);
    normal = normalize3(make3(
        lp.x / (radius.x * radius.x),
        lp.y / (radius.y * radius.y),
        lp.z / (radius.z * radius.z)
    ));
    return true;
}

__device__ bool clipBoxAxis(
    float origin,
    float dir,
    float mn,
    float mx,
    Vec3 negN,
    Vec3 posN,
    float& tEnter,
    float& tExit,
    Vec3& enterNormal,
    Vec3& exitNormal
) {
    if (fabsf(dir) < 0.000001f) return origin >= mn && origin <= mx;
    float t0 = (mn - origin) / dir;
    float t1 = (mx - origin) / dir;
    Vec3 n0 = negN;
    Vec3 n1 = posN;
    if (t0 > t1) {
        float tmp = t0; t0 = t1; t1 = tmp;
        Vec3 nt = n0; n0 = n1; n1 = nt;
    }
    if (t0 > tEnter) {
        tEnter = t0;
        enterNormal = n0;
    }
    if (t1 < tExit) {
        tExit = t1;
        exitNormal = n1;
    }
    return tEnter <= tExit;
}

__device__ bool intersectBox(Vec3 ro, Vec3 rd, Vec3 bmin, Vec3 bmax, float& t, Vec3& normal) {
    float tEnter = -1.0e20f;
    float tExit = 1.0e20f;
    Vec3 enterNormal = make3(0.0f, 1.0f, 0.0f);
    Vec3 exitNormal = make3(0.0f, -1.0f, 0.0f);
    if (!clipBoxAxis(ro.x, rd.x, bmin.x, bmax.x, make3(-1.0f, 0.0f, 0.0f), make3(1.0f, 0.0f, 0.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    if (!clipBoxAxis(ro.y, rd.y, bmin.y, bmax.y, make3(0.0f, -1.0f, 0.0f), make3(0.0f, 1.0f, 0.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    if (!clipBoxAxis(ro.z, rd.z, bmin.z, bmax.z, make3(0.0f, 0.0f, -1.0f), make3(0.0f, 0.0f, 1.0f), tEnter, tExit, enterNormal, exitNormal)) return false;
    t = tEnter > 0.02f ? tEnter : tExit;
    if (t <= 0.02f || t > 1.0e19f) return false;
    normal = normalize3(tEnter > 0.02f ? enterNormal : mul3(exitNormal, -1.0f));
    return true;
}

__device__ void acceptHit(Hit& hit, bool& found, Vec3 ro, Vec3 rd, float t, Vec3 n, int material, float id) {
    if (t > 0.02f && t < hit.t) {
        hit.t = t;
        hit.p = add3(ro, mul3(rd, t));
        hit.n = n;
        hit.material = material;
        hit.id = id;
        found = true;
    }
}

__device__ bool sceneHit(Vec3 ro, Vec3 rd, float sceneLight, Hit& hit, bool includeGround) {
    bool found = false;
    hit.t = 1.0e20f;
    if (includeGround && fabsf(rd.y) > 0.0001f) {
        float t = -ro.y / rd.y;
        if (t > 0.02f && t < hit.t) {
            hit.t = t;
            hit.p = add3(ro, mul3(rd, t));
            hit.n = make3(0.0f, 1.0f, 0.0f);
            hit.material = 0;
            hit.id = 0.0f;
            found = true;
        }
    }

    if (fabsf(rd.z) > 0.0001f) {
        const float wallZ = -3.15f;
        float wallT = (wallZ - ro.z) / rd.z;
        if (wallT > 0.02f && wallT < hit.t) {
            Vec3 wallP = add3(ro, mul3(rd, wallT));
            if (wallP.y >= 0.0f && wallP.y <= 2.45f && fabsf(wallP.x) <= 3.75f) {
                acceptHit(hit, found, ro, rd, wallT, make3(0.0f, 0.0f, 1.0f), 3, 30.0f);
            }
        }
    }

    float boxT = 0.0f;
    Vec3 boxN = make3(0.0f, 1.0f, 0.0f);
    if (intersectBox(ro, rd, make3(-3.10f, 1.34f, -3.06f), make3(-0.18f, 1.60f, -2.50f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 7, 70.0f);
    }
    if (intersectBox(ro, rd, make3(-3.12f, 0.42f, -2.94f), make3(-2.42f, 0.70f, -2.45f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 8, 80.0f);
    }
    if (intersectBox(ro, rd, make3(-1.58f, 0.46f, -2.86f), make3(-0.92f, 0.72f, -2.45f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 8, 81.0f);
    }
    if (intersectBox(ro, rd, make3(-0.88f, 0.05f, -1.82f), make3(-0.36f, 0.11f, -1.30f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 110.0f);
    }
    if (intersectBox(ro, rd, make3(-1.26f, 0.10f, -1.74f), make3(-1.18f, 0.46f, -1.66f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 111.0f);
    }
    if (intersectBox(ro, rd, make3(-0.16f, 0.08f, -1.58f), make3(-0.06f, 0.42f, -1.48f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 11, 112.0f);
    }
    if (intersectBox(ro, rd, make3(0.82f, 0.0f, -2.82f), make3(0.96f, 1.50f, -2.68f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 100.0f);
    }
    if (intersectBox(ro, rd, make3(0.58f, 1.42f, -2.96f), make3(1.20f, 1.56f, -2.54f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 101.0f);
    }
    if (intersectBox(ro, rd, make3(0.26f, 0.0f, -0.82f), make3(0.34f, 0.48f, -0.74f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 102.0f);
    }
    if (intersectBox(ro, rd, make3(-2.38f, 0.0f, -0.92f), make3(-2.30f, 0.48f, -0.84f), boxT, boxN)) {
        acceptHit(hit, found, ro, rd, boxT, boxN, 10, 103.0f);
    }

    for (int bulb = 0; bulb < 11; ++bulb) {
        float bx = -2.96f + (float)bulb * 0.56f;
        float by = 1.70f + 0.08f * sinf((float)bulb * 0.93f);
        float bz = -2.22f + 0.10f * sinf((float)bulb * 1.41f);
        float bulbT = 0.0f;
        Vec3 bulbN = make3(0.0f, 1.0f, 0.0f);
        if (intersectEllipsoid(ro, rd, make3(bx, by, bz), make3(0.035f, 0.035f, 0.035f), bulbT, bulbN) && bulbT < hit.t) {
            hit.t = bulbT;
            hit.p = add3(ro, mul3(rd, bulbT));
            hit.n = bulbN;
            hit.material = 12;
            hit.id = 120.0f + (float)bulb;
            found = true;
        }
    }

    float carT = 0.0f;
    Vec3 carN = make3(0.0f, 1.0f, 0.0f);
    if (intersectEllipsoid(ro, rd, make3(1.84f, 0.28f, -0.86f), make3(0.76f, 0.22f, 0.34f), carT, carN) && carT < hit.t) {
        hit.t = carT;
        hit.p = add3(ro, mul3(rd, carT));
        hit.n = carN;
        hit.material = 4;
        hit.id = 40.0f;
        found = true;
    }
    if (intersectEllipsoid(ro, rd, make3(1.70f, 0.47f, -0.90f), make3(0.36f, 0.13f, 0.23f), carT, carN) && carT < hit.t) {
        hit.t = carT;
        hit.p = add3(ro, mul3(rd, carT));
        hit.n = carN;
        hit.material = 6;
        hit.id = 42.0f;
        found = true;
    }
    for (int wheel = 0; wheel < 2; ++wheel) {
        float wx = wheel == 0 ? 1.38f : 2.28f;
        if (intersectEllipsoid(ro, rd, make3(wx, 0.13f, -0.57f), make3(0.15f, 0.15f, 0.08f), carT, carN) && carT < hit.t) {
            hit.t = carT;
            hit.p = add3(ro, mul3(rd, carT));
            hit.n = carN;
            hit.material = 5;
            hit.id = 41.0f + (float)wheel;
            found = true;
        }
    }

    float t = 0.0f;
    Vec3 n = make3(0.0f, 1.0f, 0.0f);
    Vec3 mainGem = make3(0.0f, 0.78f, -0.16f);
    if (intersectDiamond(ro, rd, mainGem, 1.02f, -0.18f, t, n) && t < hit.t) {
        hit.t = t;
        hit.p = add3(ro, mul3(rd, t));
        hit.n = n;
        hit.material = 1;
        hit.id = 1.0f;
        found = true;
    }

    for (int i = 0; i < 22; ++i) {
        float a = (float)i * 2.39996323f;
        float ring = 1.12f + 0.24f * (float)(i % 3);
        Vec3 center = make3(cosf(a) * ring, 0.105f, -0.18f + sinf(a) * 0.76f);
        float radius = 0.105f + 0.020f * (float)(i % 4);
        if (intersectDiamond(ro, rd, center, radius, a * 0.37f, t, n) && t < hit.t) {
            hit.t = t;
            hit.p = add3(ro, mul3(rd, t));
            hit.n = n;
            hit.material = 2;
            hit.id = (float)i + 2.0f;
            found = true;
        }
    }
    return found;
}

__device__ float shadowFactor(Vec3 p, Vec3 lightDir, float sceneLight) {
    Hit h;
    Vec3 start = add3(p, mul3(lightDir, 0.035f));
    if (!sceneHit(start, lightDir, sceneLight, h, false)) return 1.0f;
    return h.t < 3.5f ? 0.34f : 1.0f;
}

__device__ Vec3 secondarySurfaceTint(Hit hit) {
    if (hit.material == 0) return make3(0.42f, 0.44f, 0.42f);
    if (hit.material == 1 || hit.material == 2) return make3(0.86f, 0.94f, 1.0f);
    if (hit.material == 3) return make3(0.46f, 0.43f, 0.36f);
    if (hit.material == 4) return make3(0.05f, 0.06f, 0.07f);
    if (hit.material == 5) return make3(0.02f, 0.018f, 0.016f);
    if (hit.material == 6) return make3(0.16f, 0.24f, 0.30f);
    if (hit.material == 7) return make3(0.66f, 0.09f, 0.06f);
    if (hit.material == 8) return make3(0.10f, 0.30f, 0.12f);
    if (hit.material == 10) return make3(0.20f, 0.21f, 0.22f);
    if (hit.material == 11) return make3(0.42f, 0.22f, 0.09f);
    if (hit.material == 12) return make3(2.2f, 1.72f, 0.86f);
    return make3(0.40f, 0.40f, 0.40f);
}

__device__ Vec3 tracedSecondaryColor(Vec3 p, Vec3 rd, float sceneLight) {
    Hit h;
    Vec3 start = add3(p, mul3(rd, 0.050f));
    if (!sceneHit(start, rd, sceneLight, h, false)) {
        return environmentColor(rd);
    }
    float falloff = expf(-h.t * 0.16f);
    return mix3(environmentColor(rd), secondarySurfaceTint(h), falloff);
}

__device__ Vec3 shade(Vec3 ro, Vec3 rd, Hit hit, float sceneLight);

__device__ Vec3 cameraRayColor(float px, float py, int width, int height, float sceneLight, float exposure) {
    float aspect = (float)width / (float)height;
    float rigIsWarm = sceneLight >= 0.0f ? 1.0f : 0.0f;
    float rigExposure = sceneLight >= 0.0f ? (0.80f + 0.08f * clampf(sceneLight, 0.0f, 2.5f)) : 0.48f;
    Vec3 rigColorGrade = mix3(make3(0.58f, 0.70f, 1.02f), make3(1.02f, 0.96f, 0.84f), rigIsWarm);

    Vec3 eye = make3(-0.16f, 1.05f, 4.18f);
    Vec3 target = make3(0.0f, 0.55f, -0.18f);
    Vec3 forward = normalize3(sub3(target, eye));
    Vec3 right = normalize3(cross3(forward, make3(0.0f, 1.0f, 0.0f)));
    Vec3 up = normalize3(cross3(right, forward));
    float lens = tanf(35.0f * PI / 180.0f);
    Vec3 rd = normalize3(add3(forward, add3(mul3(right, (px * 2.0f - 1.0f) * aspect * lens), mul3(up, (1.0f - py * 2.0f) * lens))));

    Hit hit;
    Vec3 color = environmentColor(rd);
    if (sceneHit(eye, rd, sceneLight, hit, true)) {
        color = shade(eye, rd, hit, sceneLight);
        float fog = expf(-hit.t * 0.020f);
        color = mix3(make3(0.60f, 0.64f, 0.66f), color, fog);
    }

    float vignette = px * (1.0f - px) * py * (1.0f - py) * 16.0f;
    color = hadamard3(color, rigColorGrade);
    return mul3(color, exposure * rigExposure * (0.72f + 0.28f * clampf(vignette, 0.0f, 1.0f)));
}

__device__ Vec3 shade(Vec3 ro, Vec3 rd, Hit hit, float sceneLight) {
    Vec3 lightDir = normalize3(make3(-0.42f * sceneLight, 0.88f, -0.34f));
    Vec3 viewDir = mul3(rd, -1.0f);
    if (hit.material == 0) {
        float veinA = 0.5f + 0.5f * sinf(hit.p.x * 7.2f + sinf(hit.p.z * 3.6f) * 2.4f);
        float veinB = 0.5f + 0.5f * sinf(hit.p.z * 9.1f + hit.p.x * 1.7f);
        float marble = powf(clampf(veinA * 0.72f + veinB * 0.28f, 0.0f, 1.0f), 5.0f);
        float seamX = fabsf(fract1(hit.p.x * 0.46f) - 0.5f);
        float seamZ = fabsf(fract1((hit.p.z + 0.36f) * 0.46f) - 0.5f);
        float grout = 1.0f - smooth01(clampf((fminf(seamX, seamZ) - 0.018f) / 0.050f, 0.0f, 1.0f));
        Vec3 base = mix3(make3(0.30f, 0.33f, 0.34f), make3(0.62f, 0.65f, 0.64f), 0.18f + marble * 0.48f);
        base = mix3(base, make3(0.12f, 0.13f, 0.14f), grout * 0.46f);
        float leafScatter = smooth01(sinf(hit.p.x * 13.7f + hit.p.z * 19.1f) * 0.5f + 0.5f)
            * smooth01(sinf(hit.p.x * 29.0f - hit.p.z * 7.0f) * 0.5f + 0.5f);
        if (hit.p.x > 0.7f && hit.p.z < -0.42f && leafScatter > 0.74f) {
            base = mix3(base, make3(0.72f, 0.46f, 0.10f), 0.58f);
        }
        float wet = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 80.0f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * shadowFactor(hit.p, lightDir, sceneLight);
        Vec3 refl = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        Vec3 color = add3(mul3(base, 0.22f + diffuse * 0.66f), mul3(refl, 0.24f));
        color = add3(color, mul3(make3(1.0f, 0.92f, 0.72f), wet * 0.85f));
        float caustic = expf(-fabsf(hit.p.x) * 2.4f) * expf(-fabsf(hit.p.z + 0.05f) * 1.3f);
        color = add3(color, mul3(make3(0.60f, 0.82f, 1.0f), caustic * (0.18f + 0.10f * sceneLight)));
        return color;
    }

    if (hit.material == 3) {
        float x = hit.p.x;
        float y = hit.p.y;
        float brickA = 0.5f + 0.5f * sinf(x * 12.0f + floorf(y * 8.0f) * 0.73f);
        float brickB = 0.5f + 0.5f * sinf((x + y) * 21.0f);
        Vec3 wall = mix3(make3(0.36f, 0.35f, 0.31f), make3(0.58f, 0.54f, 0.46f), 0.32f + 0.24f * brickA);
        float mortarX = 1.0f - smooth01(clampf((fabsf(fract1(x * 2.6f) - 0.5f) - 0.43f) / 0.06f, 0.0f, 1.0f));
        float mortarY = 1.0f - smooth01(clampf((fabsf(fract1(y * 8.0f) - 0.5f) - 0.43f) / 0.06f, 0.0f, 1.0f));
        wall = mix3(wall, make3(0.20f, 0.20f, 0.18f), clampf(mortarX + mortarY, 0.0f, 1.0f) * 0.25f);

        if (y > 0.72f && y < 1.46f && x > -2.95f && x < -1.55f) {
            float pane = 0.5f + 0.5f * sinf(x * 38.0f + y * 22.0f);
            wall = mix3(make3(0.05f, 0.09f, 0.09f), make3(0.82f, 0.55f, 0.34f), 0.32f + 0.36f * pane);
        }
        if (y > 0.70f && y < 1.52f && x > -1.08f && x < -0.18f) {
            wall = mix3(make3(0.04f, 0.08f, 0.08f), make3(0.75f, 0.48f, 0.28f), 0.42f + 0.20f * brickB);
        }
        if (y > 1.48f && y < 1.68f && x > -3.15f && x < -0.05f) {
            wall = make3(0.64f, 0.08f, 0.07f);
        }
        if (y > 1.36f && y < 1.47f && x > -1.85f && x < -0.78f) {
            wall = make3(0.12f, 0.22f, 0.16f);
        }
        if (y > 0.95f && y < 2.24f && x > 1.18f && x < 2.92f) {
            float arch = smooth01(1.0f - fabsf(x - 2.05f) / 0.90f);
            float stone = 0.42f + 0.28f * sinf((x * 9.0f + y * 6.0f));
            wall = mix3(wall, make3(0.48f, 0.47f, 0.43f), arch * stone);
        }
        float leaf = (0.5f + 0.5f * sinf(x * 33.0f + y * 47.0f)) * smooth01(clampf((y - 0.52f) / 1.3f, 0.0f, 1.0f));
        if (x < -3.03f && leaf > 0.38f) {
            wall = mix3(wall, make3(0.05f, 0.28f, 0.12f), 0.72f);
        }
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.55f + 0.34f;
        return mul3(wall, diffuse);
    }

    if (hit.material == 4 || hit.material == 5 || hit.material == 6) {
        Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        float spec = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), hit.material == 5 ? 32.0f : 110.0f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.30f + 0.18f;
        if (hit.material == 5) {
            return add3(mul3(make3(0.015f, 0.014f, 0.013f), diffuse + 0.28f), mul3(make3(0.70f, 0.03f, 0.02f), spec * 0.35f));
        }
        if (hit.material == 6) {
            Vec3 glass = mix3(make3(0.07f, 0.12f, 0.16f), reflected, 0.58f);
            return add3(mul3(glass, diffuse + 0.42f), mul3(make3(0.70f, 0.90f, 1.0f), spec * 0.65f));
        }
        Vec3 body = mix3(make3(0.018f, 0.020f, 0.022f), reflected, 0.46f);
        body = add3(mul3(body, diffuse + 0.26f), mul3(make3(1.0f, 0.18f, 0.10f), spec * 0.45f));
        return body;
    }

    if (hit.material == 7) {
        float stripe = fract1(hit.p.x * 3.6f + hit.p.z * 1.4f);
        Vec3 fabric = stripe < 0.52f ? make3(0.54f, 0.035f, 0.025f) : make3(0.78f, 0.18f, 0.14f);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.46f + 0.30f;
        float weave = 0.88f + 0.12f * sinf(hit.p.x * 48.0f + hit.p.y * 19.0f);
        return mul3(fabric, diffuse * weave);
    }

    if (hit.material == 8) {
        float leaf = 0.5f + 0.5f * sinf(hit.p.x * 57.0f + hit.p.y * 83.0f + hit.p.z * 31.0f);
        Vec3 green = mix3(make3(0.03f, 0.17f, 0.07f), make3(0.30f, 0.48f, 0.18f), leaf);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.52f + 0.34f;
        return mul3(green, diffuse);
    }

    if (hit.material == 10) {
        Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
        float spec = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 96.0f);
        Vec3 metal = mix3(make3(0.05f, 0.055f, 0.06f), reflected, 0.38f);
        return add3(metal, mul3(make3(1.0f, 0.92f, 0.75f), spec * 0.70f));
    }

    if (hit.material == 11) {
        float grain = 0.5f + 0.5f * sinf(hit.p.x * 24.0f + hit.p.z * 37.0f);
        Vec3 wood = mix3(make3(0.25f, 0.12f, 0.055f), make3(0.58f, 0.31f, 0.13f), grain);
        float diffuse = fmaxf(0.0f, dot3(hit.n, lightDir)) * 0.58f + 0.28f;
        return mul3(wood, diffuse);
    }

    if (hit.material == 12) {
        float halo = powf(fmaxf(0.0f, dot3(hit.n, viewDir)), 3.0f);
        return add3(make3(1.85f, 1.32f, 0.62f), mul3(make3(1.0f, 0.74f, 0.28f), halo * 2.2f));
    }

    float eta = hit.material == 1 ? 1.0f / (1.47f + sceneLight * 0.035f) : 1.0f / 1.39f;
    Vec3 reflected = tracedSecondaryColor(hit.p, reflect3(rd, hit.n), sceneLight);
    Vec3 refracted = tracedSecondaryColor(hit.p, refract3(rd, hit.n, eta), sceneLight);
    float fresnel = powf(1.0f - fmaxf(0.0f, dot3(hit.n, viewDir)), 5.0f);
    float facetA = fmaxf(0.0f, dot3(hit.n, normalize3(make3(0.18f, 0.91f, 0.36f))));
    float facetB = fmaxf(0.0f, dot3(hit.n, normalize3(make3(-0.74f, 0.42f, 0.52f))));
    float dispersion = sinf((hit.n.x * 41.0f + hit.n.y * 29.0f + hit.n.z * 37.0f + hit.id) * 2.3f);
    Vec3 spectral = make3(0.84f + 0.12f * sinf(dispersion + 0.0f),
                          0.90f + 0.08f * sinf(dispersion + 2.1f),
                          0.98f + 0.08f * sinf(dispersion + 4.2f));
    Vec3 glass = mix3(hadamard3(refracted, spectral), reflected, 0.16f + 0.70f * fresnel);
    glass = add3(glass, mul3(make3(0.92f, 0.98f, 1.0f), facetA * facetA * 0.30f));
    glass = add3(glass, mul3(make3(1.0f, 0.90f, 0.62f), facetB * facetB * 0.16f));
    float sparkle = powf(fmaxf(0.0f, dot3(reflect3(mul3(lightDir, -1.0f), hit.n), viewDir)), 120.0f);
    glass = add3(glass, mul3(make3(1.0f, 0.96f, 0.84f), sparkle * (2.4f + sceneLight)));
    return glass;
}

extern "C" __global__ void render_realistic_raytrace(unsigned int* pixels, int width, int height, float exposure, unsigned long long frame) {
    int x = blockIdx.x * blockDim.x + threadIdx.x;
    int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;

    const float sceneLight = 1.0f; // SYNTHI_HMR_DIRECTION_TOKEN
    Vec3 color = make3(0.0f, 0.0f, 0.0f);
    const float offsets[4][2] = {
        {0.30f, 0.30f},
        {0.70f, 0.30f},
        {0.30f, 0.70f},
        {0.70f, 0.70f}
    };
    for (int sample = 0; sample < 4; ++sample) {
        float px = ((float)x + offsets[sample][0]) / (float)width;
        float py = ((float)y + offsets[sample][1]) / (float)height;
        color = add3(color, cameraRayColor(px, py, width, height, sceneLight, exposure));
    }
    color = mul3(color, 0.25f);
    pixels[y * width + x] = packColor(color);
}

int main(int, char**) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* window = SDL_CreateWindow("Synthi GPU Realistic Raytrace HMR", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, 0);
    SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    SDL_Texture* texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_STREAMING, WIDTH, HEIGHT);

    static unsigned int hostPixels[PIXEL_COUNT];
    unsigned int* devicePixels = nullptr;
    hipMalloc(&devicePixels, sizeof(unsigned int) * PIXEL_COUNT);

    bool running = true;
    unsigned long long frame = 0;
    while (running) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT) running = false;
        }

        dim3 block(16, 16);
        dim3 grid((WIDTH + block.x - 1) / block.x, (HEIGHT + block.y - 1) / block.y);
        render_realistic_raytrace<<<grid, block>>>(devicePixels, WIDTH, HEIGHT, 1.04f, frame++);
        hipDeviceSynchronize();
        hipMemcpy(hostPixels, devicePixels, sizeof(unsigned int) * PIXEL_COUNT, hipMemcpyDeviceToHost);

        SDL_UpdateTexture(texture, nullptr, hostPixels, WIDTH * (int)sizeof(unsigned int));
        SDL_RenderClear(renderer);
        SDL_RenderCopy(renderer, texture, nullptr, nullptr);
        SDL_RenderPresent(renderer);
        SDL_Delay(16);

        if ((frame % 120ULL) == 0ULL) {
            std::fprintf(stderr, "[user-gpu-realistic-raytrace] frame=%llu deterministic=1\n", frame);
        }
    }

    hipFree(devicePixels);
    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
