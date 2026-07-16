import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.xinjing.app',
  appName: '心镜',
  webDir: 'app',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    Filesystem: {
      access: 'public',
    },
    Preferences: {
      storeName: 'xinjing_prefs',
    },
  },
};

export default config;
