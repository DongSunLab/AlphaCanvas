
import { useState, useEffect } from 'react';

const TERMS_TEXT = `제1조 (목적)
본 약관은 AlphaCanvas (이하 “본 서비스”)가 제공하는 그래프 렌더링 및 AI 연동 기능의 이용 조건과 책임 사항을 규정함을 목적으로 합니다.

제2조 (서비스 내용)
본 서비스는 사용자가 입력한 데이터 및 설정을 기반으로 그래프를 시각화하는 도구를 제공합니다.
AI 기능은 사용자가 직접 입력한 외부 AI API 키를 통해 동작하며, 사용자의 요청(프롬프트/그래프 상태/선택적으로 이미지)을 처리하기 위해 암호화되어 서버로 전송될 수 있습니다.
본 서비스는 AI 응답을 제공하기 위해 필요한 범위에서만 요청을 처리하며, AI 제공자(예: OpenAI, Google 등)의 정책 및 처리 방식은 각 제공자 약관을 따릅니다.

제3조 (API 키 및 책임)
AI API 키는 사용자가 직접 제공하며, 키의 관리, 사용, 비용 발생에 대한 모든 책임은 사용자 본인에게 있습니다.
본 서비스는 서버에 API 키를 영구 저장하지 않으며, 요청 처리 목적 외로 사용하지 않습니다.
단, 사용자가 선택한 경우 브라우저(로컬 저장소 등)에 키가 저장될 수 있으며, 이는 사용자 기기 환경의 설정에 따릅니다.
API 제공자의 정책 변경, 오류, 비용 문제에 대해 본 서비스는 책임을 지지 않습니다.

제4조 (서비스 제공의 한계)
본 서비스는 “있는 그대로(as-is)” 제공되며, 결과의 정확성, 완전성, 특정 목적에 대한 적합성을 보장하지 않습니다.
서비스는 사전 공지 없이 변경, 중단, 종료될 수 있습니다.
서버 오류, 네트워크 문제, 데이터 손실로 인한 손해에 대해 본 서비스는 책임을 지지 않습니다.

제5조 (쿠키)
본 서비스는 기본 기능 제공 및 보안 목적을 위해 쿠키(또는 유사한 식별자)를 사용할 수 있습니다.
본 서비스는 쿠키를 광고 목적의 추적에 사용하지 않습니다.

제5조 (후원)
후원은 본 서비스의 유지 및 개발을 위한 자발적 기여입니다.
후원은 특정 기능, 성능, 지속적인 서비스 제공을 보장하지 않습니다.
후원금은 원칙적으로 환불되지 않습니다.

제6조 (이용 제한)
본 서비스의 안정적인 운영을 방해하거나 악용하는 행위가 확인될 경우, 사전 통보 없이 이용을 제한할 수 있습니다.

제7조 (약관 변경)
본 약관은 필요 시 변경될 수 있으며, 변경 사항은 서비스 내 공지로 갈음합니다.

제8조 (문의)
서비스 관련 문의는 아래 연락처로 가능합니다.
이메일: physicsbeube@gmail.com`;

const PRIVACY_TEXT = `AlphaCanvas Team은 개인정보 보호법을 준수하며, 이용자의 개인정보를 보호하기 위해 다음과 같은 방침을 수립·공개합니다.

1. 개인정보 수집 여부
본 서비스는 회원가입 기능이 없으며, 이용자의 개인정보를 직접 수집하지 않습니다.

2. 로컬 저장소(브라우저) 저장
서비스 편의 기능을 위해 아래 정보가 이용자 기기(브라우저 로컬 저장소 등)에 저장될 수 있습니다.
- AI API 키(사용자가 저장을 선택한 경우)
이는 이용자 기기 내에 저장되며, 브라우저 설정에서 삭제할 수 있습니다.

3. API 키 처리 및 외부 전송
사용자가 입력한 AI API 키는 요청 처리 목적에 한해 사용됩니다.
AI 기능을 사용하면 키 및 요청 데이터(프롬프트/그래프 상태/선택적으로 이미지)가 암호화되어 서버로 전송될 수 있으며, AI 제공자에게 전달되어 처리될 수 있습니다.
해당 키는 서버에 영구 저장하지 않으며, 요청 처리 목적 외로 사용하지 않습니다.

4. 쿠키
본 서비스는 기본 기능 제공 및 보안 목적을 위해 쿠키를 사용할 수 있습니다.
쿠키는 광고 목적의 추적에 사용하지 않습니다.

5. 자동 수집 정보(서버 로그)
서비스 운영 및 보안 목적을 위해 아래 정보가 자동으로 수집될 수 있습니다.
- IP 주소
- User-Agent
- 접속 시각
해당 정보는 일정 기간 보관 후 삭제됩니다.

6. 개인정보의 제3자 제공
본 서비스는 이용자의 개인정보를 제3자에게 제공하지 않습니다.

7. 개인정보 보관 기간
개인정보를 수집하지 않으므로 별도의 보관 기간은 존재하지 않습니다.
단, 서버 로그는 운영 및 보안 목적 달성 후 삭제됩니다.

8. 문의
개인정보 관련 문의는 아래로 연락 바랍니다.
이메일: physicsbeube@gmail.com`;

interface TermsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function TermsModal({ isOpen, onClose }: TermsModalProps) {
    const [activeTab, setActiveTab] = useState<'terms' | 'privacy'>('terms');

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) {
            window.addEventListener('keydown', handleEsc);
        }
        return () => window.removeEventListener('keydown', handleEsc);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            opacity: isOpen ? 1 : 0,
            transition: 'opacity 0.2s'
        }} onClick={onClose}>
            <div style={{
                width: '800px',
                maxWidth: '90vw',
                height: '80vh',
                background: '#1e1e1e',
                borderRadius: 16,
                boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
                border: '1px solid rgba(255,255,255,0.1)',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            }} onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div style={{
                    padding: '20px 24px',
                    borderBottom: '1px solid rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: '#252525'
                }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: 20,
                        fontWeight: 600,
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10
                    }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 8v4" />
                            <path d="M12 16h.01" />
                        </svg>
                        이용약관 및 정보
                    </h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'rgba(255,255,255,0.5)',
                            cursor: 'pointer',
                            padding: 4,
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.color = '#fff';
                            e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.color = 'rgba(255,255,255,0.5)';
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {/* Content Layout */}
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                    {/* Sidebar Navigation */}
                    <div style={{
                        width: 200,
                        background: '#222',
                        borderRight: '1px solid rgba(255,255,255,0.05)',
                        display: 'flex',
                        flexDirection: 'column',
                        padding: '16px 8px',
                        gap: 4
                    }}>
                        <TabButton
                            active={activeTab === 'terms'}
                            onClick={() => setActiveTab('terms')}
                            label="이용약관"
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>}
                        />
                        <TabButton
                            active={activeTab === 'privacy'}
                            onClick={() => setActiveTab('privacy')}
                            label="개인정보처리방침"
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
                        />
                    </div>

                    {/* Main Content */}
                    <div style={{
                        flex: 1,
                        padding: '32px 40px',
                        overflowY: 'auto',
                        background: '#1e1e1e',
                        color: '#ddd'
                    }}>
                        <SectionTitle>
                            {activeTab === 'terms' ? '이용약관' : '개인정보처리방침'}
                        </SectionTitle>

                        <div style={{
                            whiteSpace: 'pre-wrap',
                            lineHeight: 1.7,
                            fontSize: 14,
                            color: 'rgba(255,255,255,0.8)'
                        }}>
                            {activeTab === 'terms' ? TERMS_TEXT : PRIVACY_TEXT}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TabButton({ active, onClick, icon, label }: any) {
    return (
        <button
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                background: active ? 'rgba(33, 150, 243, 0.15)' : 'transparent',
                border: 'none',
                borderLeft: active ? '3px solid #2196F3' : '3px solid transparent',
                color: active ? '#2196F3' : 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 14,
                fontWeight: 500,
                transition: 'all 0.2s'
            }}
            onMouseEnter={e => {
                if (!active) {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                    e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
                }
            }}
            onMouseLeave={e => {
                if (!active) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'rgba(255,255,255,0.6)';
                }
            }}
        >
            {icon}
            {label}
        </button>
    );
}

function SectionTitle({ children }: any) {
    return (
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24, color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 12 }}>
            {children}
        </h2>
    );
}
