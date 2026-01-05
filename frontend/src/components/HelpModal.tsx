
import { useEffect, useState } from 'react';
import katex from 'katex';

interface HelpModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function HelpModal({ isOpen, onClose }: HelpModalProps) {
    const [activeTab, setActiveTab] = useState<'basics' | 'functions' | 'geometry' | 'shortcuts'>('basics');

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
                            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        AlphaCanvas 사용 설명서
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
                            active={activeTab === 'basics'}
                            onClick={() => setActiveTab('basics')}
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>}
                            label="기본 안내"
                        />
                        <TabButton
                            active={activeTab === 'functions'}
                            onClick={() => setActiveTab('functions')}
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" /></svg>}
                            label="함수 입력"
                        />
                        <TabButton
                            active={activeTab === 'geometry'}
                            onClick={() => setActiveTab('geometry')}
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="14.31" y1="8" x2="20.05" y2="17.94" /><line x1="9.69" y1="8" x2="21.17" y2="8" /><line x1="7.38" y1="12" x2="13.12" y2="2.06" /><line x1="9.69" y1="16" x2="3.95" y2="6.06" /><line x1="14.31" y1="16" x2="2.83" y2="16" /><line x1="16.62" y1="12" x2="10.88" y2="21.94" /></svg>}
                            label="기하 도구"
                        />
                        <TabButton
                            active={activeTab === 'shortcuts'}
                            onClick={() => setActiveTab('shortcuts')}
                            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>}
                            label="단축키"
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
                        {activeTab === 'basics' && (
                            <div className="space-y-6">
                                <SectionTitle>AlphaCanvas에 오신 것을 환영합니다</SectionTitle>
                                <p style={{ lineHeight: 1.6 }}>
                                    AlphaCanvas는 고품질의 수학 그래프와 도형을 쉽게 그리고, SVG 및 고해상도 PNG로 내보낼 수 있는 도구입니다.
                                    교재 제작, 문제 출제, 강의 자료 생성에 최적화되어 있습니다.
                                </p>

                                <h3 style={{ fontSize: 18, color: '#fff', marginTop: 32, marginBottom: 16 }}>주요 기능</h3>
                                <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                    <FeatureCard
                                        title="강력한 함수 그래프"
                                        desc="양함수, 음함수, 매개변수 방정식 등 다양한 형태의 함수를 아름답게 시각화합니다."
                                    />
                                    <FeatureCard
                                        title="스마트한 기하 도구"
                                        desc="점, 선, 원, 접선 등 기하학적 요소들을 직관적으로 작도하고 편집할 수 있습니다."
                                    />
                                    <FeatureCard
                                        title="고품질 내보내기"
                                        desc="벡터 기반의 SVG와 4K 해상도의 PNG 출력을 지원하여 인쇄물에도 깨끗하게 나옵니다."
                                    />
                                    <FeatureCard
                                        title="LaTeX 수식 지원"
                                        desc="자연스러운 수식 입력을 위한 LaTeX 문법을 완벽하게 지원합니다."
                                    />
                                </ul>
                            </div>
                        )}

                        {activeTab === 'functions' && (
                            <div className="space-y-6">
                                <SectionTitle>함수 및 수식 입력</SectionTitle>

                                <h3 style={{ fontSize: 16, color: '#4fc3f7', marginTop: 24 }}>1. 양함수 (Explicit Functions)</h3>
                                <p style={{ marginBottom: 8 }}>일반적인 y=f(x) 형태의 함수입니다.</p>
                                <CodeBlock>y = x^2 - 2x + 1</CodeBlock>
                                <CodeBlock>f(x) = \sin(x) + \cos(x)</CodeBlock>

                                <h3 style={{ fontSize: 16, color: '#4fc3f7', marginTop: 24 }}>2. 음함수 (Implicit Functions)</h3>
                                <p style={{ marginBottom: 8 }}>x와 y의 관계식으로 정의되는 도형입니다. 원, 타원 등을 그릴 때 유용합니다.</p>
                                <CodeBlock>x^2 + y^2 = 16</CodeBlock>
                                <CodeBlock>x^3 + y^3 = 3xy</CodeBlock>

                                <h3 style={{ fontSize: 16, color: '#4fc3f7', marginTop: 24 }}>3. 평행이동 문법 (Translation)</h3>
                                <p style={{ marginBottom: 8 }}>기존 함수를 평행이동하여 새로운 그래프를 생성할 수 있습니다.</p>
                                <CodeBlock>f(x) + (2, 3)</CodeBlock>
                                <p style={{ fontSize: 13, color: '#aaa', marginTop: 4 }}>→ f(x)를 x축으로 +2, y축으로 +3 만큼 평행이동</p>

                                <h3 style={{ fontSize: 16, color: '#4fc3f7', marginTop: 24 }}>4. 점 찍기</h3>
                                <p style={{ marginBottom: 8 }}>좌표를 직접 입력하여 점을 생성합니다.</p>
                                <CodeBlock>(1, 2)</CodeBlock>
                                <CodeBlock>( \pi, \sin(\pi) )</CodeBlock>
                            </div>
                        )}

                        {activeTab === 'geometry' && (
                            <div className="space-y-6">
                                <SectionTitle>기하 도구 사용법</SectionTitle>
                                <p style={{ marginBottom: 24 }}>우측 상단의 에이전트 패널 또는 단축키를 통해 도구를 선택할 수 있습니다.</p>

                                <div style={{ display: 'grid', gap: 16 }}>
                                    <ToolItem name="선택 모드 (Select)" desc="객체를 선택하고 이동하거나 속성을 편집합니다." />
                                    <ToolItem name="점 모드 (Point)" desc="캔버스 위에 자유롭게 점을 찍거나, 선/곡선 위에 점을 구속시킵니다." />
                                    <ToolItem name="직선/선분 (Line/Segment)" desc="두 점을 연결하는 직선이나 선분을 그립니다." />
                                    <ToolItem name="원 (Circle)" desc="중심과 한 점, 또는 세 점을 지나는 원을 작도합니다." />
                                    <ToolItem name="접선 (Tangent)" desc="원이나 곡선에 접하는 선을 그립니다." />
                                    <ToolItem name="각도 (Angle)" desc="세 점을 지정하여 각도를 표시합니다." />
                                </div>
                            </div>
                        )}

                        {activeTab === 'shortcuts' && (
                            <div className="space-y-6">
                                <SectionTitle>단축키 목록</SectionTitle>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                    <ShortcutGroup title="일반">
                                        <ShortcutKey keys={['Ctrl', 'Z']} desc="실행 취소 (Undo)" />
                                        <ShortcutKey keys={['Ctrl', 'Shift', 'Z']} desc="다시 실행 (Redo)" />
                                        <ShortcutKey keys={['Delete']} desc="선택한 객체 삭제" />
                                        <ShortcutKey keys={['Space']} desc="팬(이동) 모드 전환" />
                                    </ShortcutGroup>

                                    <ShortcutGroup title="화면 조작">
                                        <ShortcutKey keys={['Wheel']} desc="화면 확대/축소" />
                                        <ShortcutKey keys={['Drag']} desc="화면 이동 (팬 모드)" />
                                        <ShortcutKey keys={['Ctrl', 'C']} desc="SVG 이미지를 클립보드에 복사" />
                                    </ShortcutGroup>
                                </div>
                            </div>
                        )}
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

function CodeBlock({ children }: any) {
    const html = katex.renderToString(children, {
        throwOnError: false,
        displayMode: false
    });

    return (
        <div style={{
            background: 'rgba(0,0,0,0.3)',
            padding: '12px 16px',
            borderRadius: 8,
            // fontFamily: 'monospace', // Removed to let KaTeX fonts take over
            fontSize: 16, // Slightly larger for math
            color: '#e0e0e0', // Better contrast for math
            marginBottom: 8,
            border: '1px solid rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center', // Center the math
            minHeight: 48
        }}>
            <span dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

function FeatureCard({ title, desc }: any) {
    return (
        <li style={{
            background: 'rgba(255,255,255,0.03)',
            padding: 16,
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.05)'
        }}>
            <strong style={{ color: '#fff', display: 'block', marginBottom: 6 }}>{title}</strong>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{desc}</span>
        </li>
    );
}

function ToolItem({ name, desc }: any) {
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            paddingBottom: 12,
            borderBottom: '1px solid rgba(255,255,255,0.05)'
        }}>
            <span style={{ fontWeight: 600, color: '#fff' }}>{name}</span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{desc}</span>
        </div>
    );
}

function ShortcutGroup({ title, children }: any) {
    return (
        <div>
            <h4 style={{ fontSize: 15, color: '#2196F3', marginBottom: 12 }}>{title}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {children}
            </div>
        </div>
    );
}

function ShortcutKey({ keys, desc }: any) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{desc}</span>
            <div style={{ display: 'flex', gap: 4 }}>
                {keys.map((k: string) => (
                    <kbd key={k} style={{
                        background: 'rgba(255,255,255,0.1)',
                        padding: '2px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        color: '#fff',
                        fontFamily: 'monospace',
                        minWidth: 20,
                        textAlign: 'center'
                    }}>{k}</kbd>
                ))}
            </div>
        </div>
    );
}
