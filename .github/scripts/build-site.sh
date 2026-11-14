#!/usr/bin/env bash
# models.json 을 읽어 GitHub Release 에서 GLB 파일을 내려받고 검증한 뒤,
# GitHub Pages 에 올릴 _site 폴더를 만듭니다.
# 하나라도 실패하면 즉시 중단하므로(exit 1) 배포까지 가지 않습니다.
set -euo pipefail

OUT="_site"
DL="_dl"
MAX_TOTAL_MB=900     # 이 용량을 넘으면 중단 (Pages 사이트 한도 1GB 보호)
WARN_TOTAL_MB=700    # 이 용량을 넘으면 경고
WARN_FILE_MB=100     # 파일 하나가 이 용량을 넘으면 경고

fail() { echo "::error::$*"; exit 1; }
note() { echo "$*"; }

command -v jq >/dev/null || fail "jq 가 필요합니다"
command -v gh >/dev/null || fail "gh(GitHub CLI)가 필요합니다"
command -v python3 >/dev/null || fail "python3 가 필요합니다"
command -v sha256sum >/dev/null || fail "sha256sum 이 필요합니다"

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY 환경 변수가 필요합니다}"

[ -f index.html ] || fail "index.html 이 저장소 최상위에 없습니다"
[ -f models.json ] || fail "models.json 이 저장소 최상위에 없습니다"

# ---- 1. models.json 형식 검사 ----
jq -e '.schema == 1 and (.models | type == "array") and (.models | length > 0)' models.json >/dev/null \
  || fail "models.json 형식 오류: schema 는 1 이어야 하고 models 배열에 항목이 1개 이상 있어야 합니다"

dups=$(jq -r '[.models[].key] | group_by(.)[] | select(length > 1) | .[0]' models.json)
[ -z "$dups" ] || fail "models.json 에 중복된 key 가 있습니다: $dups"

rm -rf "$OUT" "$DL"
mkdir -p "$OUT/models" "$DL"
cp index.html "$OUT/index.html"

count=$(jq '.models | length' models.json)
entries='{}'
summary_rows=""

# ---- 2. 모델마다 다운로드 + 검증 ----
for i in $(seq 0 $((count - 1))); do
  key=$(jq -r ".models[$i].key // empty" models.json)
  tag=$(jq -r ".models[$i].tag // empty" models.json)
  asset=$(jq -r ".models[$i].asset // empty" models.json)
  size=$(jq -r ".models[$i].size // empty" models.json)
  sha=$(jq -r ".models[$i].sha256 // empty" models.json)

  [[ "$key" =~ ^[a-z0-9_]+$ ]]               || fail "[$i] key 형식 오류 (소문자, 숫자, _ 만 가능): '$key'"
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]]          || fail "[$key] tag 형식 오류: '$tag'"
  [[ "$asset" =~ ^[A-Za-z0-9._-]+\.glb$ ]]   || fail "[$key] asset 은 영문·숫자·._- 로 된 .glb 파일명이어야 합니다: '$asset'"
  [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" -gt 0 ] || fail "[$key] size 는 0보다 큰 정수여야 합니다: '$size'"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]]             || fail "[$key] sha256 은 소문자 16진수 64자리여야 합니다"

  note "== [$key] Release $tag 에서 $asset 내려받는 중"
  dir="$DL/$key"
  mkdir -p "$dir"
  ok=0
  for attempt in 1 2 3; do
    if gh release download "$tag" --repo "$REPO" --pattern "$asset" --dir "$dir" --clobber; then
      ok=1
      break
    fi
    note "다운로드 실패 ($attempt/3). 잠시 후 다시 시도합니다"
    sleep $((attempt * 5))
  done
  [ "$ok" = 1 ] || fail "[$key] Release '$tag' 에서 '$asset' 을 내려받지 못했습니다 (태그나 파일 이름을 확인하세요)"

  file="$dir/$asset"
  [ -f "$file" ] || fail "[$key] 내려받은 파일을 찾을 수 없습니다: $asset"
  n_files=$(find "$dir" -type f | wc -l)
  [ "$n_files" -eq 1 ] || fail "[$key] 내려받은 파일이 정확히 1개가 아닙니다 ($n_files 개)"

  actual_size=$(stat -c %s "$file")
  [ "$actual_size" -eq "$size" ] || fail "[$key] 크기 불일치: models.json=$size, 실제=$actual_size"

  actual_sha=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$actual_sha" = "$sha" ] || fail "[$key] SHA-256 불일치: models.json=$sha, 실제=$actual_sha"

  python3 - "$file" <<'PY' || fail "[$key] GLB 파일 형식 검사 실패 (헤더가 올바른 GLB 가 아닙니다)"
import os
import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    head = f.read(12)
if len(head) < 12:
    sys.exit("파일이 너무 짧습니다")
magic, version, length = struct.unpack("<4sII", head)
if magic != b"glTF":
    sys.exit("GLB 매직 값이 'glTF' 가 아닙니다")
if version != 2:
    sys.exit("GLB 버전이 2 가 아닙니다: %d" % version)
if length != os.path.getsize(path):
    sys.exit("GLB 헤더 길이(%d)와 실제 파일 크기(%d)가 다릅니다" % (length, os.path.getsize(path)))
PY

  # 캐시 문제 방지: 파일 이름에 해시 앞 8자리를 넣습니다 (예: player.cc33531f.glb)
  hash8="${sha:0:8}"
  dest="models/${key}.${hash8}.glb"
  cp "$file" "$OUT/$dest"

  entries=$(jq --arg k "$key" --arg f "$dest" --arg s "$sha" --argjson z "$size" --arg t "$tag" --arg a "$asset" \
    '. + {($k): {file: $f, sha256: $s, size: $z, tag: $t, asset: $a}}' <<<"$entries")
  summary_rows="${summary_rows}| ${key} | ${tag} | ${size} | ${hash8} | ${dest} |"$'\n'
  note "   OK: 크기와 SHA-256 일치, GLB 헤더 정상 -> $dest"
done

# ---- 3. manifest.json 생성 (게임이 나중에 읽을 모델 목록) ----
commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)
jq -n --argjson models "$entries" --arg commit "$commit" \
  --arg run "${GITHUB_RUN_ID:-local}" --arg attempt "${GITHUB_RUN_ATTEMPT:-0}" \
  '{schema: 1, commit: $commit, run_id: $run, run_attempt: $attempt, models: $models}' \
  > "$OUT/models/manifest.json"

# ---- 4. 용량 검사 ----
total_bytes=$(du -sb "$OUT" | cut -f1)
total_mb=$((total_bytes / 1024 / 1024))
note "== _site 전체 용량: ${total_mb}MB"
[ "$total_mb" -le "$MAX_TOTAL_MB" ] || fail "_site 용량이 ${MAX_TOTAL_MB}MB 를 넘습니다 (${total_mb}MB). Pages 사이트 한도는 1GB 입니다"
[ "$total_mb" -le "$WARN_TOTAL_MB" ] || echo "::warning::_site 용량이 ${total_mb}MB 입니다. Pages 한도(1GB)에 가까워지고 있습니다"
while IFS= read -r big; do
  echo "::warning::파일이 ${WARN_FILE_MB}MB 를 넘습니다: $big"
done < <(find "$OUT" -type f -size +"${WARN_FILE_MB}"M)

# ---- 5. 요약 ----
{
  echo "### 모델 빌드 결과"
  echo
  echo "| key | 태그 | 크기(바이트) | 해시 | 배포 경로 |"
  echo "| --- | --- | --- | --- | --- |"
  printf '%s' "$summary_rows"
  echo
  echo "전체 용량: ${total_mb}MB / 한도 1GB"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

note "== 완료: $OUT 폴더가 준비되었습니다"
