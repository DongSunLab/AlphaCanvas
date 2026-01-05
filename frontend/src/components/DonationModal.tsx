
import { useState, useEffect } from 'react';

interface DonationModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function DonationModal({ isOpen, onClose }: DonationModalProps) {
    const [copied, setCopied] = useState(false);
    const ACCOUNT_NUMBER = "100-140-276790";
    const BANK_NAME = "케이뱅크";

    useEffect(() => {
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) {
            window.addEventListener('keydown', handleEsc);
        }
        return () => window.removeEventListener('keydown', handleEsc);
    }, [isOpen, onClose]);

    const handleCopy = () => {
        navigator.clipboard.writeText(`${BANK_NAME} ${ACCOUNT_NUMBER}`)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            })
            .catch(err => console.error('Failed to copy: ', err));
    };

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
                width: '500px',
                maxWidth: '90vw',
                // Auto height for this one since content is short
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
                        <span style={{ fontSize: 24 }}>🎁</span>
                        후원하기
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

                {/* Content */}
                <div style={{
                    padding: '32px 40px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 24,
                    textAlign: 'center',
                    background: '#1e1e1e',
                    color: '#ddd'
                }}>
                    <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.8)', lineHeight: 1.6, margin: 0 }}>
                        AlphaCanvas는 1인 개발자가<br /> 개인 시간과 비용을 들여 운영하고 있습니다.<br />
                        서비스는 앞으로도 무료로 제공할 예정입니다.<br />
                        <br />
                        사용에 도움이 되었다면, 커피 한 잔 값으로 후원해 주세요.<br />
                        작은 후원도 서버비와 신규 기능 개발에 큰 힘이 됩니다 ♡
                    </p>

                    {/* Toonation Button */}
                    <a
                        href="https://toon.at/donate/alphacanvas"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 10,
                            width: '100%',
                            padding: '16px',
                            backgroundColor: '#ff5252', // Matching the red/orange accent
                            color: 'white',
                            borderRadius: 12,
                            textDecoration: 'none',
                            fontWeight: 700,
                            fontSize: 16,
                            boxShadow: '0 4px 12px rgba(255, 82, 82, 0.2)',
                            transition: 'all 0.2s',
                            boxSizing: 'border-box',
                            border: '1px solid rgba(255,255,255,0.1)'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = '#ff1744';
                            e.currentTarget.style.transform = 'translateY(-2px)';
                            e.currentTarget.style.boxShadow = '0 6px 16px rgba(255, 82, 82, 0.4)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = '#ff5252';
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.boxShadow = '0 4px 12px rgba(255, 82, 82, 0.2)';
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                        투네이션으로 후원하기
                    </a>

                    {/* Account Info */}
                    <div style={{
                        backgroundColor: 'rgba(255,255,255,0.05)',
                        padding: '20px',
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.08)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12
                    }}>
                        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', fontWeight: 600, textTransform: 'uppercase' }}>계좌 후원</div>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 12,
                            flexWrap: 'wrap'
                        }}>
                            <span style={{ fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: '0.5px' }}>
                                {BANK_NAME} {ACCOUNT_NUMBER}
                            </span>
                            <button
                                onClick={handleCopy}
                                style={{
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    background: copied ? '#4CAF50' : 'rgba(255,255,255,0.1)',
                                    color: copied ? 'white' : 'rgba(255,255,255,0.9)',
                                    borderRadius: 6,
                                    padding: '6px 12px',
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    fontWeight: 500
                                }}
                                onMouseEnter={e => {
                                    if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.2)';
                                }}
                                onMouseLeave={e => {
                                    if (!copied) e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                                }}
                            >
                                {copied ? '복사됨' : '복사'}
                                {copied && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div style={{
                    padding: '16px 24px',
                    borderTop: '1px solid rgba(255,255,255,0.1)',
                    backgroundColor: '#252525',
                    fontSize: 13,
                    color: 'rgba(255,255,255,0.5)',
                    textAlign: 'center'
                }}>
                    감사한 마음으로 더 좋은 서비스를 만들겠습니다.
                </div>
            </div>
        </div>
    );
}
