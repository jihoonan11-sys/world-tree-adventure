// 헤드리스 브라우저(Chromium) 스모크 테스트
// 사용법: node smoke-test.mjs <사이트주소> [출력폴더]
//   예) node smoke-test.mjs http://127.0.0.1:8080/ smoke-out
// 환경 변수
//   THREE_ROOT : (선택) 로컬 three@0.147.0 폴더. 지정하면 jsDelivr 요청을 이 폴더로 대신 응답합니다.
//   EXPECT_RUN_ID : (선택) manifest.json 의 run_id 가 이 값과 같아야 통과합니다 (배포 후 검사용)
// 하는 일: 게임 페이지 열기 -> manifest.json 읽기 -> 모델 파일을 같은 사이트에서 받기 ->
//          SHA-256 비교 -> GLTFLoader 로 파싱 -> 장면에 올려 스크린샷 -> 결과 JSON 저장
// 실패하면 종료 코드 1 로 끝납니다.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = (process.argv[2] || "").replace(/\/?$/, "/");
const outDir = process.argv[3] || "smoke-out";
if (!process.argv[2]) {
  console.error("사용법: node smoke-test.mjs <사이트주소> [출력폴더]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const THREE_ROOT = process.env.THREE_ROOT || "";
const EXPECT_RUN_ID = process.env.EXPECT_RUN_ID || "";
const result = { base, ok: false, checks: [], errors: [], models: {} };
const check = (name, pass, detail = "") => {
  result.checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`);
};

function finish(code) {
  result.ok = code === 0;
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  const lines = ["### 스모크 테스트 결과", "", "| 항목 | 결과 | 상세 |", "| --- | --- | --- |"];
  for (const c of result.checks) lines.push(`| ${c.name} | ${c.pass ? "통과" : "실패"} | ${String(c.detail).replace(/\|/g, "/")} |`);
  if (result.errors.length) lines.push("", "페이지 오류:", ...result.errors.slice(0, 10).map((e) => "- " + e));
  const md = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  process.exit(code);
}

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => result.errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") result.errors.push("console: " + m.text());
  });

  // 외부 CDN(jsDelivr)을 로컬 three 폴더로 대신 응답 (인터넷이 막힌 환경에서만 사용)
  if (THREE_ROOT) {
    await ctx.route("https://cdn.jsdelivr.net/npm/three@0.147.0/**", async (route) => {
      const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.147.0/", "");
      const file = path.join(THREE_ROOT, rel);
      if (!file.startsWith(path.resolve(THREE_ROOT)) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
      const type = file.endsWith(".js") ? "application/javascript" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    });
  }

  // 1) 게임 페이지 열기
  const resp = await page.goto(base, { waitUntil: "load", timeout: 60000 });
  check("게임 페이지 응답 200", resp && resp.status() === 200, `status=${resp && resp.status()}`);
  await page.waitForFunction(() => window.THREE && THREE.GLTFLoader, null, { timeout: 30000 }).catch(() => {});
  const hasLoader = await page.evaluate(() => !!(window.THREE && THREE.GLTFLoader));
  check("Three.js 와 GLTFLoader 로드", hasLoader);
  const hasCanvas = await page.evaluate(() => !!document.querySelector("canvas"));
  check("게임 canvas 생성", hasCanvas);

  // 2) manifest.json 읽기
  const manifestUrl = new URL("models/manifest.json", base).href;
  const mres = await page.request.get(manifestUrl, { headers: { "Cache-Control": "no-cache" } });
  check("manifest.json 응답 200", mres.status() === 200, `status=${mres.status()}`);
  const manifest = mres.status() === 200 ? await mres.json() : null;
  if (manifest) {
    check("manifest 모델 1개 이상", manifest.models && Object.keys(manifest.models).length > 0);
    if (EXPECT_RUN_ID) check("manifest run_id 가 방금 배포한 실행과 일치", String(manifest.run_id) === EXPECT_RUN_ID, `manifest=${manifest.run_id}, 기대=${EXPECT_RUN_ID}`);
  }

  // 3) 모델별: 같은 사이트에서 받기 -> SHA-256 -> GLTFLoader 파싱
  if (manifest && manifest.models) {
    for (const [key, m] of Object.entries(manifest.models)) {
      const url = new URL(m.file, base).href;
      const info = await page.evaluate(
        async ({ url, expectSha, expectSize }) => {
          const out = { fetched: false };
          const t0 = performance.now();
          const r = await fetch(url);
          out.status = r.status;
          if (!r.ok) return out;
          const buf = await r.arrayBuffer();
          out.fetched = true;
          out.size = buf.byteLength;
          out.fetchMs = Math.round(performance.now() - t0);
          out.sizeOk = buf.byteLength === expectSize;
          const h = await crypto.subtle.digest("SHA-256", buf);
          out.sha = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
          out.shaOk = out.sha === expectSha;

          // 게임과 같은 방식으로 로더를 구성
          const loader = new THREE.GLTFLoader();
          if (THREE.DRACOLoader) {
            const d = new THREE.DRACOLoader();
            d.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/libs/draco/gltf/");
            loader.setDRACOLoader(d);
          }
          if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
          const t1 = performance.now();
          try {
            const gltf = await new Promise((res, rej) => loader.parse(buf, "", res, rej));
            out.parseMs = Math.round(performance.now() - t1);
            let meshes = 0, skinned = 0, tris = 0;
            gltf.scene.traverse((o) => {
              if (o.isMesh) {
                meshes++;
                if (o.isSkinnedMesh) skinned++;
                const g = o.geometry;
                tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
              }
            });
            out.meshes = meshes;
            out.skinned = skinned;
            out.triangles = Math.round(tris);
            out.animations = gltf.animations.length;
            const box = new THREE.Box3().setFromObject(gltf.scene);
            const s = new THREE.Vector3();
            box.getSize(s);
            out.bbox = [s.x, s.y, s.z].map((v) => +v.toFixed(3));
            out.bboxOk = s.toArray().every((v) => isFinite(v)) && s.length() > 0;

            // 별도 장면에 올려 렌더링 (화면 확인용)
            const cv = document.createElement("canvas");
            cv.width = 480; cv.height = 480;
            const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
            const scene = new THREE.Scene();
            scene.background = new THREE.Color(0xcfe8ff);
            scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.0));
            const sun = new THREE.DirectionalLight(0xffffff, 0.8);
            sun.position.set(3, 6, 4);
            scene.add(sun);
            scene.add(gltf.scene);
            const c = box.getCenter(new THREE.Vector3());
            const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
            const d = Math.max(s.x, s.y, s.z) * 1.8;
            cam.position.set(c.x, c.y, c.z + d);
            cam.lookAt(c);
            renderer.render(scene, cam);
            out.png = cv.toDataURL("image/png");
            out.rendered = true;
          } catch (e) {
            out.parseError = String((e && e.message) || e);
          }
          return out;
        },
        { url, expectSha: m.sha256, expectSize: m.size },
      );
      const png = info.png;
      delete info.png;
      result.models[key] = info;
      check(`[${key}] 같은 사이트에서 다운로드 (CORS 불필요)`, info.fetched, `status=${info.status}, ${info.fetchMs}ms`);
      check(`[${key}] 크기 일치`, info.sizeOk, `size=${info.size}`);
      check(`[${key}] SHA-256 일치`, info.shaOk);
      check(`[${key}] GLTFLoader 파싱 성공`, !info.parseError && info.meshes > 0, info.parseError || `meshes=${info.meshes}, skinned=${info.skinned}, tris=${info.triangles}, anim=${info.animations}, ${info.parseMs}ms`);
      check(`[${key}] 모델 크기(bbox) 정상`, info.bboxOk, JSON.stringify(info.bbox));
      if (png) fs.writeFileSync(path.join(outDir, `model-${key}.png`), Buffer.from(png.split(",")[1], "base64"));
    }
  }

  // 4) 게임 화면 스크린샷 + 치명 오류 확인
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(outDir, "game.png") });
  const fatal = result.errors.filter((e) => /pageerror|is not defined|is not a function|Cannot read/.test(e));
  check("게임 페이지에 치명적 JS 오류 없음", fatal.length === 0, fatal.slice(0, 3).join(" / "));
} catch (e) {
  result.errors.push("test-runner: " + ((e && e.stack) || e));
  check("테스트 실행 중 예외 없음", false, String((e && e.message) || e));
} finally {
  await browser.close();
}
finish(result.checks.every((c) => c.pass) ? 0 : 1);
