-- =====================================================
-- Phase 6: 전자계약 테이블 (contracts)
-- Supabase SQL Editor에서 실행
-- =====================================================

-- 1. contracts 테이블 생성
CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  
  -- 계약 정보
  contract_type VARCHAR(50) NOT NULL DEFAULT '근로계약서',
  title VARCHAR(200) NOT NULL,
  
  -- UCanSign 연동 정보
  ucansign_request_id VARCHAR(200),
  ucansign_template_id VARCHAR(200),
  ucansign_status VARCHAR(50) DEFAULT 'draft',
  
  -- 서명 참여자 정보
  signer_name VARCHAR(100),
  signer_email VARCHAR(200),
  signer_phone VARCHAR(20),
  
  -- 상태 관리
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  -- draft: 작성중, sent: 발송됨, viewed: 열람됨, signed: 서명완료, completed: 완료, rejected: 거절, expired: 만료
  
  -- PDF 관련
  pdf_url TEXT,
  signed_pdf_url TEXT,
  
  -- 메타데이터
  contract_data JSONB DEFAULT '{}',
  
  -- 타임스탬프
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  sent_at TIMESTAMP WITH TIME ZONE,
  signed_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_contracts_company_id ON contracts(company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_employee_id ON contracts(employee_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_ucansign_request_id ON contracts(ucansign_request_id);

-- 3. updated_at 자동 업데이트 트리거
CREATE OR REPLACE FUNCTION update_contracts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_contracts_updated_at ON contracts;
CREATE TRIGGER trigger_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION update_contracts_updated_at();

-- 4. RLS 정책 (Row Level Security)
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

-- service_role은 모든 접근 허용
CREATE POLICY "service_role_all_contracts" ON contracts
  FOR ALL
  USING (true)
  WITH CHECK (true);
