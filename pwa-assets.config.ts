import { defineConfig } from '@vite-pwa/assets-generator/config';

/**
 * Icon generation for Hays + Sons.
 *
 * Source: public/logo.svg (red rounded square + white "H+").
 * Run with `npm run icons`.
 *
 * - transparent: favicon + standard PWA icons (192/512) + 256/64 for the Windows .ico
 * - maskable: full-bleed red field (safe zone) for Android/Windows maskable slots
 * - apple: opaque red background for iOS home-screen icons
 */
export default defineConfig({
  preset: {
    transparent: {
      sizes: [64, 192, 256, 512],
      favicons: [[48, 'favicon.ico']],
      padding: 0,
    },
    maskable: {
      sizes: [512],
      padding: 0.3,
      resizeOptions: { background: '#DC2626' },
    },
    apple: {
      sizes: [180],
      padding: 0.3,
      resizeOptions: { background: '#DC2626' },
    },
  },
  images: ['public/logo.svg'],
});
