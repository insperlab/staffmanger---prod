// business-filter.js
// 사업장 필터 공통 모듈 — 모든 페이지에서 재사용
// 비유: TV 리모컨. 한 번 만들어두면 어느 TV(페이지)에서든 동일하게 작동

const BusinessFilter = {
    // localStorage 키 상수
    STORAGE_KEY: 'sm_selected_business',
  
    // ── 초기화 ──────────────────────────────────────────────
    // 페이지 로드 시 호출. 드롭다운 렌더링 + 변경 이벤트 등록
    async init(options = {}) {
      const {
        containerId = 'business-filter-container', // 드롭다운을 넣을 div ID
        onChanged = null,   // 사업장 변경 시 콜백 함수
        showLabel = true    // "사업장:" 라벨 표시 여부
      } = options;
  
      const container = document.getElementById(containerId);
      if (!container) return;
  
      // 로딩 표시
      container.innerHTML = '<span style="color:#999;font-size:13px;">사업장 로딩중...</span>';
  
      try {
        const businesses = await this.fetchBusinesses();
  
        // 사업장이 1개 이하면 필터 숨김 (단일 매장은 불필요)
        if (businesses.length <= 1) {
          container.innerHTML = '';
          // 단일 사업장이면 그 ID를 자동 선택 상태로 저장
          if (businesses.length === 1) {
            this.setSelected(businesses[0].id);
          }
          if (onChanged) onChanged(this.getSelected());
          return;
        }
  
        // 드롭다운 HTML 렌더링
        container.innerHTML = this.renderDropdown(businesses, showLabel);
  
        // 변경 이벤트 등록
        const select = document.getElementById('business-filter-select');
        if (select) {
          select.addEventListener('change', (e) => {
            this.setSelected(e.target.value);
            if (onChanged) onChanged(e.target.value);
          });
        }
  
        // 변경 없이도 초기 데이터 로드
        if (onChanged) onChanged(this.getSelected());
  
      } catch (err) {
        console.error('사업장 필터 초기화 실패:', err);
        container.innerHTML = '';
        if (onChanged) onChanged('all');
      }
    },
  
    // ── API 호출 ─────────────────────────────────────────────
    async fetchBusinesses() {
      const token = localStorage.getItem('token');
      const res = await fetch('/.netlify/functions/businesses-list', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('사업장 조회 실패');
      const data = await res.json();
      return data.businesses || [];
    },
  
    // ── localStorage 저장/조회 ───────────────────────────────
    getSelected() {
      return localStorage.getItem(this.STORAGE_KEY) || 'all';
    },
  
    setSelected(businessId) {
      localStorage.setItem(this.STORAGE_KEY, businessId || 'all');
    },
  
    // ── 드롭다운 HTML 생성 ────────────────────────────────────
    renderDropdown(businesses, showLabel) {
      const selected = this.getSelected();
      const options = businesses.map(b => {
        const label = b.is_headquarters ? `${b.name} (본점)` : b.name;
        return `<option value="${b.id}" ${selected === b.id ? 'selected' : ''}>${label}</option>`;
      }).join('');
  
      return `
        <div style="display:flex;align-items:center;gap:8px;">
          ${showLabel ? '<label style="font-size:13px;color:#555;white-space:nowrap;">사업장</label>' : ''}
          <select id="business-filter-select" style="
            padding:6px 10px;
            border:1px solid #ddd;
            border-radius:6px;
            font-size:13px;
            background:#fff;
            cursor:pointer;
            min-width:140px;
          ">
            <option value="all" ${selected === 'all' ? 'selected' : ''}>📍 전체 사업장</option>
            ${options}
          </select>
        </div>
      `;
    },
  
    // ── API 쿼리 파라미터 생성 헬퍼 ──────────────────────────
    // 사용법: fetch('/api/employees?' + BusinessFilter.toQueryParam())
    toQueryParam() {
      const selected = this.getSelected();
      return selected !== 'all' ? `business_id=${selected}` : '';
    }
  };