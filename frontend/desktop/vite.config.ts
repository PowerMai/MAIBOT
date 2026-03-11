
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
// @ts-ignore - 类型声明非必需
import tailwind from '@tailwindcss/postcss';

export default defineConfig(({ command }) => ({
  // Electron file:// 加载 dist 时需要相对资源路径；dev 保持根路径
  base: command === 'build' ? './' : '/',
  plugins: [react()],
  define: {
    // API 地址配置
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://localhost:2024'),
    'import.meta.env.VITE_LANGGRAPH_API_URL': JSON.stringify('http://localhost:2024'),
  },
  css: {
    // 使用 Tailwind v4 官方 PostCSS 插件（无需额外 autoprefixer）
    postcss: {
      plugins: [tailwind()],
    },
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
    alias: {
      // 主路径别名
      '@': path.resolve(__dirname, './src'),
      // dompurify ESM 入口，避免 Rollup build 时 resolve 失败（pnpm 下需显式指向）
      'dompurify': path.resolve(__dirname, 'node_modules/.pnpm/dompurify@3.3.1/node_modules/dompurify/dist/purify.es.mjs'),
      // react-syntax-highlighter 为嵌套依赖，build 时需显式指向以便 dist/esm/styles/prism 等子路径可解析
      'react-syntax-highlighter': path.resolve(__dirname, 'node_modules/.pnpm/react-syntax-highlighter@16.1.0_react@18.3.1/node_modules/react-syntax-highlighter'),
      // 版本化包别名
      'vaul@1.1.2': 'vaul',
      'sonner@2.0.3': 'sonner',
      'recharts@2.15.2': 'recharts',
      'react-resizable-panels@2.1.7': 'react-resizable-panels',
      'react-hook-form@7.55.0': 'react-hook-form',
      'react-day-picker@8.10.1': 'react-day-picker',
      'next-themes@0.4.6': 'next-themes',
      'lucide-react@0.487.0': 'lucide-react',
      'input-otp@1.4.2': 'input-otp',
      'embla-carousel-react@8.6.0': 'embla-carousel-react',
      'cmdk@1.1.1': 'cmdk',
      'class-variance-authority@0.7.1': 'class-variance-authority',
      '@radix-ui/react-tooltip@1.1.8': '@radix-ui/react-tooltip',
      '@radix-ui/react-toggle@1.1.2': '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group@1.1.2': '@radix-ui/react-toggle-group',
      '@radix-ui/react-tabs@1.1.3': '@radix-ui/react-tabs',
      '@radix-ui/react-switch@1.1.3': '@radix-ui/react-switch',
      '@radix-ui/react-slot@1.1.2': '@radix-ui/react-slot',
      '@radix-ui/react-slider@1.2.3': '@radix-ui/react-slider',
      '@radix-ui/react-separator@1.1.2': '@radix-ui/react-separator',
      '@radix-ui/react-select@2.1.6': '@radix-ui/react-select',
      '@radix-ui/react-scroll-area@1.2.3': '@radix-ui/react-scroll-area',
      '@radix-ui/react-radio-group@1.2.3': '@radix-ui/react-radio-group',
      '@radix-ui/react-progress@1.1.2': '@radix-ui/react-progress',
      '@radix-ui/react-popover@1.1.6': '@radix-ui/react-popover',
      '@radix-ui/react-navigation-menu@1.2.5': '@radix-ui/react-navigation-menu',
      '@radix-ui/react-menubar@1.1.6': '@radix-ui/react-menubar',
      '@radix-ui/react-label@2.1.2': '@radix-ui/react-label',
      '@radix-ui/react-hover-card@1.1.6': '@radix-ui/react-hover-card',
      '@radix-ui/react-dropdown-menu@2.1.6': '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-dialog@1.1.6': '@radix-ui/react-dialog',
      '@radix-ui/react-context-menu@2.2.6': '@radix-ui/react-context-menu',
      '@radix-ui/react-collapsible@1.1.3': '@radix-ui/react-collapsible',
      '@radix-ui/react-checkbox@1.1.4': '@radix-ui/react-checkbox',
      '@radix-ui/react-avatar@1.1.3': '@radix-ui/react-avatar',
      '@radix-ui/react-aspect-ratio@1.1.2': '@radix-ui/react-aspect-ratio',
      '@radix-ui/react-alert-dialog@1.1.6': '@radix-ui/react-alert-dialog',
      '@radix-ui/react-accordion@1.2.3': '@radix-ui/react-accordion',
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/node_modules/react-dom/') || id.includes('/node_modules/react/')) return 'vendor-react';
            if (id.includes('/node_modules/motion/')) return 'vendor-motion';
            if (id.includes('react-markdown') || id.includes('remark-') || id.includes('rehype-') || id.includes('katex') || id.includes('micromark')) return 'vendor-markdown';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-recharts';
            if (id.includes('@radix-ui')) return 'vendor-radix';
            if (id.includes('@monaco-editor') || id.includes('monaco-editor')) return 'monaco';
            if (id.includes('xlsx') || id.includes('xlsx.js')) return 'xlsx';
            if (id.includes('@assistant-ui') || id.includes('@langchain/langgraph-sdk')) return 'chat';
            if (id.includes('pdfjs-dist') && !id.includes('pdf.worker')) return 'pdfjs';
            return 'vendor-misc';
          }
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 3000,
    host: true, // 监听所有接口，便于 start.sh 探活（127.0.0.1 / localhost）与 Electron 连接
    strictPort: true, // 固定 3000，与 Electron main.js 中 VITE_DEV_PORT 一致
    open: false, // Electron 模式下不自动打开浏览器
    hmr: {
      // HMR 配置，提高稳定性
      overlay: true,
      timeout: 5000,
    },
    watch: {
      // 文件监听配置
      usePolling: false,
      interval: 1000,
    },
  },
  // 优化配置
  optimizeDeps: {
    // 预构建依赖，提高启动速度；dompurify 需预构建以免 markdown-text 动态加载 500
    include: [
      'react',
      'react-dom',
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      'dompurify',
      'react-syntax-highlighter',
      'secure-json-parse',
      '@assistant-ui/react-langgraph',
    ],
    // 不预构建该包会导致其请求 assistant-stream/utils 子路径走 node_modules，进而 secure-json-parse 以 CJS 裸加载无 default；故保留预构建，仅关闭 minify 避免 esbuild 产出非法语法（if 块花括号被删）
    esbuildOptions: {
      minify: false,
    },
  },
}));