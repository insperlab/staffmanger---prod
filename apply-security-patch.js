#!/usr/bin/env node
// =====================================================
// StaffManager Security Patch v1.0
// 실행: cd staffmanager-deploy && node apply-security-patch.js
// =====================================================

const fs = require('fs');
const path = require('path');

const FUNCTIONS_DIR = path.join(__dirname, 'netlify', 'functions');
const LIB_DIR = path.join(FUNCTIONS_DIR, 'lib');

// auth-login.js는 별도 교체하므로 건너뜀
const SKIP_FILES = ['auth-login.js', '.DS_Store'];

console.log('🔒 StaffManager Security Patch v1.0');
console.log('====================================\n');

// 1. lib 디렉토리 확인
if (!fs.existsSync(path.join(LIB_DIR, 'auth.js'))) {
  console.error('❌ netlify/functions/lib/auth.js 가 없습니다!');
  console.error('   먼저 lib/auth.js를 복사해주세요.');
  process.exit(1);
}
console.log('✅ lib/auth.js 확인됨\n');

// 2. 대상 파일 목록
const files = fs.readdirSync(FUNCTIONS_DIR).filter(f =>
  f.endsWith('.js') && !SKIP_FILES.includes(f) && !f.startsWith('.')
);

console.log(`📝 패치 대상: ${files.join(', ')}\n`);

let patchedCount = 0;
let skippedCount = 0;

for (const file of files) {
  const filePath = path.join(FUNCTIONS_DIR, file);
  let code = fs.readFileSync(filePath, 'utf-8');
  const original = code;

  console.log(`  📄 ${file}`);

  // 이미 패치된 파일 건너뛰기
  if (code.includes("require('./lib/auth')")) {
    console.log('     ⏭️  이미 패치됨\n');
    skippedCount++;
    continue;
  }

  // ---- 패치 1: lib/auth import 추가 ----
  const importLine = "const { verifyToken, getCorsHeaders } = require('./lib/auth');\n";

  // 첫 번째 줄(주석이든 코드든) 앞에 추가
  code = importLine + code;

  // ---- 패치 2: 인라인 getUserFromToken 함수 → 주석 처리 ----
  // 패턴: 함수 선언 블록 전체를 찾아서 주석 처리
  const patterns = [
    // 패턴 A: 섹션 주석 + function 선언 (가장 일반적)
    /(\/\/\s*=+\n\/\/\s*(?:JWT )?토큰에서 사용자 정보 추출\n\/\/\s*=+\nfunction getUserFromToken[\s\S]*?^})\n/m,
    // 패턴 B: function만
    /(function getUserFromToken\(authHeader\)\s*\{[\s\S]*?^})\n/m,
  ];

  let functionRemoved = false;
  for (const pattern of patterns) {
    if (pattern.test(code)) {
      code = code.replace(pattern, '// [보안패치] getUserFromToken → verifyToken으로 대체됨\n');
      functionRemoved = true;
      console.log('     ✅ 인라인 getUserFromToken 제거');
      break;
    }
  }
  if (!functionRemoved) {
    console.log('     ⚠️  인라인 getUserFromToken 미발견 (수동 확인 필요)');
  }

  // ---- 패치 3: getUserFromToken 호출 → verifyToken 교체 ----
  const callCount = (code.match(/getUserFromToken\(/g) || []).length;
  if (callCount > 0) {
    code = code.replace(/getUserFromToken\(/g, 'verifyToken(');
    console.log(`     ✅ getUserFromToken() → verifyToken() 호출 ${callCount}개 교체`);
  }

  // ---- 패치 4: CORS '*' → staffmanager.io 교체 ----
  const corsCount = (code.match(/'Access-Control-Allow-Origin':\s*'\*'/g) || []).length;
  if (corsCount > 0) {
    code = code.replace(
      /'Access-Control-Allow-Origin':\s*'\*'/g,
      "'Access-Control-Allow-Origin': 'https://staffmanager.io'"
    );
    console.log(`     ✅ CORS '*' → 'https://staffmanager.io' ${corsCount}개 교체`);
  }

  // ---- 저장 ----
  if (code !== original) {
    fs.writeFileSync(filePath, code, 'utf-8');
    console.log('     💾 저장 완료\n');
    patchedCount++;
  } else {
    console.log('     ⚠️  변경 없음\n');
    skippedCount++;
  }
}

console.log('====================================');
console.log(`✅ 패치 완료: ${patchedCount}개 함수`);
console.log(`⏭️  건너뜀: ${skippedCount}개 함수`);
console.log('');
console.log('📌 다음 단계:');
console.log('   1. git diff 로 변경사항 확인');
console.log('   2. npx netlify deploy --prod');
console.log('   3. 로그인 테스트 (새 JWT 토큰 발급 확인)');
