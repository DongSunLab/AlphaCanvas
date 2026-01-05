/**
 * UUID 생성 유틸리티
 * crypto.randomUUID()를 지원하지 않는 환경(HTTP, 오래된 브라우저)에서도 작동
 */

export function generateUUID(): string {
  // crypto.randomUUID() 지원 확인
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (e) {
      // HTTPS가 아니거나 다른 이유로 실패하면 fallback 사용
      console.warn('crypto.randomUUID() failed, using fallback:', e);
    }
  }

  // Fallback: RFC4122 version 4 UUID 생성
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

