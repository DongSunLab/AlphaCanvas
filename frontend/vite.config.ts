import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: 'jsdom'
  },
  // 운영 빌드에서 디버그 로그/디버거를 최대한 제거 (성능 + 민감정보 노출 방지)
  esbuild: mode === 'production'
    ? {
        drop: ['debugger'],
        // console.error는 남겨 장애 분석 가능하게 유지
        pure: ['console.log', 'console.debug', 'console.info', 'console.warn']
      }
    : undefined,
  build: {
    // 기본값도 false지만, 운영 안전을 위해 명시
    sourcemap: false
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true
      },
      // SNOW API 엔드포인트만 프록시
      '^/snow/(health|statistics|classifications|classification-folders|classification|questions|image|voyage-search|structured-search|preprocess-math-batch|find-image|uploads|assets|export-hwp-stream|download-hwp|export-hwp|save_classification_folders)': {
        target: 'http://localhost:8000',
        changeOrigin: true
      },
      // 파일 업로드 API (POST만)
      '/snow/upload': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        bypass: (req) => {
          // GET 요청은 Vite가 처리 (프론트엔드 페이지)
          if (req.method === 'GET') {
            return '/snow/upload'
          }
          // POST 요청만 백엔드로 프록시
        }
      },
      // MAY API 엔드포인트만 프록시
      '^/may/(api|health)': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
}))
