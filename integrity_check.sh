#!/bin/bash

echo "======================================"
echo "   StaffManager 정합성 점검 리포트"
echo "======================================"
echo ""

# 1. 파일 존재 확인
echo "📂 1. 핵심 파일 존재 여부"
echo "======================================"
files=(
  "dashboard.html"
  "employees.html"
  "attendances.html"
  "calendar.html"
  "salary.html"
  "payroll.html"
  "settings.html"
  "contracts.html"
  "netlify/functions/employees-list.js"
  "netlify/functions/employees-create.js"
  "netlify/functions/attendances-list.js"
)

for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    echo "✅ $file"
  else
    echo "❌ $file - 파일 없음!"
  fi
done

# 2. 파일명 일관성 (attendance vs attendances)
echo ""
echo "📝 2. 파일명 일관성 점검"
echo "======================================"
echo "attendances 링크 현황:"
grep -h 'href="/attendances\.html"' *.html 2>/dev/null | wc -l | xargs echo "  - attendances.html 링크:"
grep -h 'href="/attendance\.html"' *.html 2>/dev/null | wc -l | xargs echo "  - attendance.html 링크:"

if grep -q 'href="/attendance\.html"' *.html 2>/dev/null; then
  echo "⚠️  WARNING: attendance.html 링크 발견!"
  grep -n 'href="/attendance\.html"' *.html
fi

# 3. API 호출 메서드 점검
echo ""
echo "🔌 3. API 호출 메서드 점검"
echo "======================================"

echo "salary.html → employees-list:"
if grep -A 3 "employees-list" salary.html 2>/dev/null | grep -q "method: 'GET'"; then
  echo "  ✅ GET (정상)"
elif grep -A 3 "employees-list" salary.html 2>/dev/null | grep -q "method: 'POST'"; then
  echo "  ❌ POST (오류 - GET이어야 함)"
else
  echo "  ❓ 알 수 없음"
fi

echo "payroll.html → employees-list:"
if grep -A 3 "employees-list" payroll.html 2>/dev/null | grep -q "method: 'GET'"; then
  echo "  ✅ GET (정상)"
elif grep -A 3 "employees-list" payroll.html 2>/dev/null | grep -q "method: 'POST'"; then
  echo "  ❌ POST (오류 - GET이어야 함)"
else
  echo "  ❓ 알 수 없음"
fi

# 4. employees-create.js 버전 확인
echo ""
echo "🔧 4. employees-create.js 버전"
echo "======================================"
if [ -f "netlify/functions/employees-create.js" ]; then
  if grep -q "이메일이 있는 경우에만" netlify/functions/employees-create.js; then
    echo "❌ 구버전 (이메일 필수)"
  elif grep -q "이메일 없어도" netlify/functions/employees-create.js; then
    echo "✅ 최신버전 (이메일 선택)"
  else
    # user_id가 null 가능한지 확인
    if grep -q "user_id: newUser ? newUser.id : null" netlify/functions/employees-create.js; then
      echo "❌ 구버전 (user_id null 허용)"
    elif grep -q "user_id: newUser.id" netlify/functions/employees-create.js; then
      echo "✅ 최신버전 (user_id 필수)"
    else
      echo "❓ 알 수 없음"
    fi
  fi
else
  echo "❌ 파일 없음"
fi

# 5. 탭 네비게이션 일관성
echo ""
echo "📑 5. 탭 네비게이션 일관성"
echo "======================================"
for html in dashboard.html employees.html attendances.html salary.html settings.html; do
  if [ -f "$html" ]; then
    tab_count=$(grep -c 'href=".*\.html"' "$html" | head -1)
    echo "$html: 탭 링크 수 확인 중..."
  fi
done

# 6. 최종 요약
echo ""
echo "======================================"
echo "   📊 점검 완료!"
echo "======================================"
echo ""
echo "다음 단계:"
echo "1. ❌ 표시된 항목 확인"
echo "2. 필요한 파일 업데이트"
echo "3. git add . && git commit && git push"
echo ""

